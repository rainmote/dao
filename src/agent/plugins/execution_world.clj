(ns agent.plugins.execution-world
  "Replaceable local filesystem/process execution world.

  Model-facing tools depend on this service instead of directly touching the
  host, so a container, SSH daemon, or test double can replace it."
  (:require [agent.cancellation :as cancellation]
            [agent.kernel :as kernel]
            [agent.sandbox :as sandbox]
            [babashka.fs :as fs]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.nio.file Files LinkOption Path]
           [java.util.concurrent TimeUnit]))

(def ^:private seatbelt-profile
  (str "(version 1)\n"
       "(deny default)\n"
       "(allow process*)\n(allow signal)\n(allow sysctl-read)\n"
       "(allow mach-lookup)\n(allow ipc-posix-sem*)\n(allow ipc-posix-shm*)\n"
       "(allow file-read-metadata (subpath \"/Users\"))\n"
       "(allow file-read* (literal \"/\") (literal \"/var\") (literal \"/etc\")\n"
       "  (subpath \"/System\") (subpath \"/usr\") (subpath \"/bin\")\n"
       "  (subpath \"/sbin\") (subpath \"/Library\") (subpath \"/private\")\n"
       "  (subpath \"/dev\") (subpath (param \"WORKSPACE\")))\n"
       "(allow file-write* (subpath (param \"WORKSPACE\")))\n"))

(defn- real-path ^Path [path]
  (.toRealPath (fs/path path) (make-array LinkOption 0)))

(defn- lexical-path ^Path [^Path root input]
  (let [candidate (.normalize (.resolve root (str input)))]
    (when-not (.startsWith candidate root)
      (throw (ex-info "Path escapes the execution root"
                      {:path input :root (str root)})))
    candidate))

(defn- existing-inside ^Path [^Path root input]
  (let [target (real-path (lexical-path root input))]
    (when-not (.startsWith target root)
      (throw (ex-info "Path resolves outside the execution root"
                      {:path input :root (str root)})))
    target))

(defn- writable-inside ^Path [^Path root input]
  (let [target (lexical-path root input)
        parent (.getParent target)]
    (when-not parent
      (throw (ex-info "Write target has no parent" {:path input})))
    ;; Resolving the real parent rejects traversal through a symlink. Requiring
    ;; the parent to exist also avoids an unchecked create-directories walk.
    (let [real-parent (real-path parent)
          existing? (or (Files/exists target (make-array LinkOption 0))
                        (Files/isSymbolicLink target))]
      (when-not (.startsWith real-parent root)
        (throw (ex-info "Write target resolves outside the execution root"
                        {:path input :root (str root)})))
      (if existing?
        (let [real-target (real-path target)]
          (when-not (.startsWith real-target root)
            (throw (ex-info "Write target resolves outside the execution root"
                            {:path input :root (str root)})))
          real-target)
        (.resolve real-parent (str (.getFileName target)))))))

(defn- read-limited [path offset limit]
  (let [text (slurp (str path))
        start (min (count text) (max 0 offset))
        end (min (count text) (+ start limit))]
    {:content (subs text start end)
     :offset start
     :truncated (< end (count text))
     :size (count text)}))

(defn- logical-lines [text]
  ;; A final POSIX newline terminates the last physical line; it does not add a
  ;; second, phantom empty line to the range/count shown to the model.
  (if (empty? text)
    []
    (let [lines (str/split text #"\r?\n" -1)]
      (if (and (seq lines) (empty? (peek lines)))
        (pop (vec lines))
        (vec lines)))))

(defn- fit-whole-lines [lines max-chars]
  (loop [remaining lines fitted [] characters 0]
    (if-let [line (first remaining)]
      (let [separator (if (empty? fitted) 0 1)
            required (+ separator (count line))]
        (cond
          (<= (+ characters required) max-chars)
          (recur (next remaining) (conj fitted line)
                 (+ characters required))

          ;; Preserve a useful preview even when one line alone exceeds the
          ;; character budget. Offset-based continuation cannot recover the
          ;; remainder of that same line, so expose this case explicitly.
          (empty? fitted)
          {:lines [(subs line 0 (min max-chars (count line)))]
           :character-truncated? true
           :first-line-exceeds-limit? true}

          :else
          {:lines fitted :character-truncated? true}))
      {:lines fitted :character-truncated? false})))

(defn- read-lines-limited [path offset limit max-chars]
  (let [text (slurp (str path))
        lines (logical-lines text)
        total-lines (count lines)
        start (min total-lines (max 0 offset))
        requested-end (min total-lines (+ start (max 1 limit)))
        selected (subvec lines start requested-end)
        fitted (fit-whole-lines selected max-chars)
        output-lines (:lines fitted)
        character-truncated? (:character-truncated? fitted)
        first-line-exceeds-limit? (:first-line-exceeds-limit? fitted)
        returned-lines (count output-lines)
        end (+ start returned-lines)
        more-lines? (< end total-lines)]
    {:content (str/join "\n" output-lines)
     :offset start
     :line-count returned-lines
     :total-lines total-lines
     :truncated (or more-lines? character-truncated?)
     :truncated-by (cond
                     character-truncated? :characters
                     more-lines? :lines
                     :else nil)
     :first-line-exceeds-limit (boolean first-line-exceeds-limit?)
     :max-chars max-chars
     :size (count text)}))

(defn- relative [^Path root ^Path target]
  (str (.relativize root target)))

(defn- walk-paths [root]
  ;; Files/walk does not follow symbolic links unless FOLLOW_LINKS is supplied.
  (with-open [paths (Files/walk root (make-array java.nio.file.FileVisitOption 0))]
    (vec (iterator-seq (.iterator paths)))))

(defn- regular-files [root]
  (->> (walk-paths root)
       (filter #(Files/isRegularFile % (make-array LinkOption 0)))
       (remove #(Files/isSymbolicLink %))))

(defn- bounded [items limit]
  (let [values (vec (take (inc limit) items))]
    {:items (vec (take limit values))
     :truncated (> (count values) limit)}))

(defn- pump! [stream stream-name on-update]
  (future
    (with-open [reader (io/reader stream)]
      (let [buffer (char-array 4096)
            output (StringBuilder.)]
        (loop []
          (let [n (.read reader buffer)]
            (if (neg? n)
              (str output)
              (let [chunk (String. buffer 0 n)]
                (.append output chunk)
                (when on-update
                  (on-update {:stream stream-name :chunk chunk}))
                (recur)))))))))

(defn- persist-full-output! [output-root stdout stderr]
  (fs/create-dirs output-root)
  (let [target (fs/path output-root (str (random-uuid) ".log"))]
    (spit (str target) (str "STDOUT\n" stdout "\nSTDERR\n" stderr))
    (str target)))

(defn- file-matches [root pattern file]
  (with-open [reader (io/reader (str file))]
    (doall
     (for [[index line] (map-indexed vector (line-seq reader))
           :when (re-find pattern line)]
       {:path (relative root file)
        :line (inc index)
        :text line}))))

(defn- process-command [sandbox root command]
  ;; Tool commands are intentionally non-login shells. A login shell reads
  ;; user startup files before executing the requested command, which leaks
  ;; unrelated configuration into results and conflicts with a workspace-only
  ;; sandbox (for example ~/.profile becomes a spurious permission error).
  (case sandbox
    :none ["/bin/sh" "-c" command]
    :seatbelt ["/usr/bin/sandbox-exec"
               "-D" (str "WORKSPACE=" root)
               "-p" seatbelt-profile
               "/bin/sh" "-c" command]
    :unavailable
    (throw (ex-info
            "Process execution is unavailable because no safe sandbox was found"
            {:sandbox sandbox}))))

(defn- spawn! [root output-root sandbox default-timeout max-output
               {:keys [command cwd timeout-ms cancel-token on-update]
                :or {cwd "."}}]
  (when (str/blank? command)
    (throw (ex-info "Command must not be blank" {})))
  (let [working-directory (existing-inside root cwd)]
    (when-not (fs/directory? working-directory)
      (throw (ex-info "Command cwd is not a directory" {:cwd cwd})))
    (cancellation/throw-if-cancelled! cancel-token)
    (let [started (System/nanoTime)
          process (.start (doto (ProcessBuilder.
                                 (process-command sandbox root command))
                            (.directory (io/file (str working-directory)))))
          dispose-cancel (cancellation/on-cancel!
                          cancel-token
                          #(do (.destroy process)
                               (when (.isAlive process)
                                 (.destroyForcibly process))))
          stdout-task (pump! (.getInputStream process) :stdout on-update)
          stderr-task (pump! (.getErrorStream process) :stderr on-update)
          effective-timeout (or timeout-ms default-timeout)]
      (try
        (when-not (.waitFor process effective-timeout TimeUnit/MILLISECONDS)
          (.destroy process)
          (when (.isAlive process) (.destroyForcibly process))
          (throw (ex-info "Command timed out"
                          {:timeout-ms effective-timeout :command command})))
        (cancellation/throw-if-cancelled! cancel-token)
        (let [stdout @stdout-task
              stderr @stderr-task
              truncated? (or (> (count stdout) max-output)
                             (> (count stderr) max-output))
              output-path (when truncated?
                            (persist-full-output! output-root stdout stderr))]
          {:exit-code (.exitValue process)
           :stdout (subs stdout 0 (min max-output (count stdout)))
           :stderr (subs stderr 0 (min max-output (count stderr)))
           :truncated truncated?
           :full-output-path output-path
           :cwd (relative root working-directory)
           :duration-ms (long (/ (- (System/nanoTime) started) 1000000))})
        (finally
          (dispose-cancel))))))

(def plugin
  {:id :execution/local-world
   :description "Workspace-bounded filesystem and cancellable process provider."
   :provides #{:execution/world}
   :start
   (fn [ctx {:keys [root timeout-ms max-output-chars output-dir sandbox]
             :or {root "." timeout-ms 30000 max-output-chars 50000
                  output-dir ".bb-agent/tool-output" sandbox :auto}}]
     (when-not (and (pos-int? timeout-ms) (pos-int? max-output-chars))
       (throw (ex-info "Execution limits must be positive integers"
                       {:timeout-ms timeout-ms
                        :max-output-chars max-output-chars})))
     (let [workspace-root (real-path root)
           mode (sandbox/resolve-mode sandbox)
           output-root (lexical-path workspace-root output-dir)
           world
           {:provider :local
            :sandbox mode
            :root (str workspace-root)
            :capabilities (cond-> #{:fs/read :fs/write}
                            (not= :unavailable mode) (conj :process))
            :resolve! (fn [path] (str (existing-inside workspace-root path)))
            :resolve-write! (fn [path]
                              (str (writable-inside workspace-root path)))
            :read! (fn [{:keys [path offset limit unit max-chars]
                         :or {offset 0 limit 50000 max-chars 50000}}]
                     (let [target (existing-inside workspace-root path)]
                       (merge {:path (relative workspace-root target)}
                              (if (= unit :lines)
                                (read-lines-limited target offset limit
                                                    max-chars)
                                (read-limited target offset limit)))))
            :write! (fn [{:keys [path content append]}]
                      (let [target (writable-inside workspace-root path)]
                        (if append
                          (spit (str target) content :append true)
                          (spit (str target) content))
                        {:path (relative workspace-root target)
                         :bytes (count (.getBytes (str content) "UTF-8"))
                         :appended (boolean append)}))
            :edit! (fn [{:keys [path old-text new-text]}]
                     (let [target (existing-inside workspace-root path)
                           content (slurp (str target))
                           first-index (.indexOf content old-text)
                           second-index (when-not (neg? first-index)
                                          (.indexOf content old-text
                                                    (inc first-index)))]
                       (when (neg? first-index)
                         (throw (ex-info "Edit text was not found" {:path path})))
                       (when (and second-index (not (neg? second-index)))
                         (throw (ex-info "Edit text is not unique" {:path path})))
                       (let [updated (str (subs content 0 first-index)
                                          new-text
                                          (subs content (+ first-index
                                                           (count old-text))))]
                         (spit (str target) updated)
                         {:path (relative workspace-root target)
                          :replacements 1
                          :bytes (count (.getBytes updated "UTF-8"))})))
            :list! (fn [{:keys [path limit] :or {path "." limit 500}}]
                     (let [target (existing-inside workspace-root path)
                           entries (->> (.listFiles (io/file (str target)))
                                        (sort-by #(.getName ^java.io.File %))
                                        (map (fn [file]
                                               {:path (relative
                                                       workspace-root
                                                       (.toPath file))
                                                :type (cond
                                                        (.isDirectory file) :directory
                                                        (.isFile file) :file
                                                        :else :other)})))]
                       (merge {:path (relative workspace-root target)}
                              (bounded entries limit))))
            :find! (fn [{:keys [path pattern limit]
                         :or {path "." pattern "*" limit 500}}]
                     (let [target (existing-inside workspace-root path)
                           matcher (.getPathMatcher
                                    (java.nio.file.FileSystems/getDefault)
                                    (str "glob:" pattern))
                           entries (->> (walk-paths target)
                                        (remove #(= target %))
                                        (filter #(.matches matcher
                                                            (.getFileName %)))
                                        (map #(relative workspace-root %))
                                        sort)]
                       (merge {:path (relative workspace-root target)
                               :pattern pattern}
                              (bounded entries limit))))
            :search! (fn [{:keys [path query limit]
                           :or {path "." limit 200}}]
                       (let [target (existing-inside workspace-root path)
                             pattern (re-pattern query)
                             matches
                             (mapcat #(file-matches workspace-root pattern %)
                                     (regular-files target))]
                         (merge {:path (relative workspace-root target)
                                 :query query}
                                (bounded matches limit))))
            :spawn! #(spawn! workspace-root output-root mode timeout-ms
                             max-output-chars %)}]
       (kernel/register-service! ctx :execution/world world))
     nil)})
