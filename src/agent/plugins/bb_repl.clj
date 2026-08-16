(ns agent.plugins.bb-repl
  "Persistent external Babashka process exposed as an execution service."
  (:require [agent.kernel :as kernel]
            [agent.sandbox :as sandbox]
            [babashka.fs :as fs]
            [babashka.process :as process]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(def ^:private seatbelt-profile
  (str "(version 1)\n"
       "(deny default)\n"
       "(allow process*)\n"
       "(allow signal)\n"
       "(allow sysctl-read)\n"
       "(allow mach-lookup)\n"
       "(allow ipc-posix-sem*)\n"
       "(allow ipc-posix-shm*)\n"
       ;; Babashka resolves classpath entries by walking their ancestors. Only
       ;; metadata is visible outside WORKSPACE; file contents remain denied.
       "(allow file-read-metadata (subpath \"/Users\"))\n"
       "(allow file-read*\n"
       "  (literal \"/\")\n"
       "  (literal \"/var\")\n"
       "  (literal \"/etc\")\n"
       "  (subpath \"/System\")\n"
       "  (subpath \"/usr\")\n"
       "  (subpath \"/bin\")\n"
       "  (subpath \"/sbin\")\n"
       "  (subpath \"/Library\")\n"
       "  (subpath \"/private\")\n"
       "  (subpath \"/dev\")\n"
       "  (subpath (param \"WORKSPACE\")))\n"
       "(allow file-write* (subpath (param \"WRITABLE\")))\n"))

(defn- absolute-classpath []
  (let [separator (System/getProperty "path.separator")
        cwd (fs/path (System/getProperty "user.dir"))]
    (->> (str/split (System/getProperty "java.class.path")
                    (re-pattern (java.util.regex.Pattern/quote separator)))
         (map #(let [path (fs/path %)]
                 (str (if (fs/absolute? path)
                        path
                        (fs/absolutize (fs/path cwd path))))))
         (str/join separator))))

(defn- worker-command [{:keys [command root sandbox writable-root]}]
  (let [base [(str command) "-cp" (absolute-classpath)
              "-m" "agent.repl-worker"]]
    (case sandbox
      :none base
      :seatbelt (into ["/usr/bin/sandbox-exec"
                       "-D" (str "WORKSPACE=" root)
                       "-D" (str "WRITABLE=" writable-root)
                       "-p" seatbelt-profile]
                      base))))

(defn- start-worker! [{:keys [root writable-root] :as config}]
  (fs/create-dirs writable-root)
  (let [child (process/process
               {:cmd (worker-command config)
                :dir (str root)
                :err :inherit})]
    {:process child
     :writer (io/writer (:in child))
     :reader (io/reader (:out child))}))

(defn- stop-worker! [worker]
  (when worker
    (try (.close ^java.io.Writer (:writer worker)) (catch Throwable _))
    (try (.close ^java.io.Reader (:reader worker)) (catch Throwable _))
    (try (process/destroy-tree (:process worker)) (catch Throwable _)))
  nil)

(defn- worker-alive? [worker]
  (and worker (.isAlive ^Process (get-in worker [:process :proc]))))

(defn- failed-result [message]
  {:ok false
   :backend "bb-repl"
   :namespace "agent.repl.user"
   :stdout ""
   :stderr ""
   :error message
   :truncated false
   :duration_ms 0})

(defn- request! [state lock config code]
  (locking lock
    (when-not (worker-alive? @state)
      (reset! state (start-worker! config)))
    (let [id (str (random-uuid))
          request {:id id
                   :op :eval
                   :code code
                   :max-output-chars (:max-output-chars config)
                   :print-length (:print-length config)
                   :print-level (:print-level config)}
          worker @state]
      (.write ^java.io.Writer (:writer worker) (str (pr-str request) "\n"))
      (.flush ^java.io.Writer (:writer worker))
      (let [read-task (future (.readLine ^java.io.BufferedReader
                                         (:reader worker)))
            line (deref read-task (:timeout-ms config) ::timeout)]
        (cond
          (= ::timeout line)
          (do
            (future-cancel read-task)
            (stop-worker! worker)
            (reset! state nil)
            (failed-result
             (str "Evaluation timed out after " (:timeout-ms config)
                  " ms; the REPL process was restarted")))

          (nil? line)
          (do
            (stop-worker! worker)
            (reset! state nil)
            (failed-result "Babashka REPL process exited unexpectedly"))

          :else
          (let [response (try
                           (edn/read-string line)
                           (catch Throwable error
                             (failed-result
                              (str "Invalid response from Babashka REPL: "
                                   (ex-message error)))))]
            (if (or (nil? (:id response)) (= id (:id response)))
              (dissoc response :id)
              (failed-result "Babashka REPL response id did not match"))))))))

(def plugin
  {:id :execution/bb-repl
   :description "Persistent, restartable Babashka REPL execution backend."
   :provides #{:execution/repl}
   :start
   (fn [ctx {:keys [root command sandbox writable-dir timeout-ms max-code-chars
                    max-output-chars print-length print-level]
             :or {root "."
                  command "bb"
                  sandbox :auto
                  writable-dir ".bb-agent/sandbox"
                  timeout-ms 10000
                  max-code-chars 50000
                  max-output-chars 20000
                  print-length 200
                  print-level 20}}]
     (when-not (and (pos-int? timeout-ms)
                    (pos-int? max-code-chars)
                    (pos-int? max-output-chars)
                    (pos-int? print-length)
                    (pos-int? print-level))
       (throw (ex-info "Babashka REPL numeric limits must be positive integers"
                       {:timeout-ms timeout-ms
                        :max-code-chars max-code-chars
                        :max-output-chars max-output-chars})))
     (let [workspace-root (fs/real-path root)
           mode (sandbox/resolve-mode sandbox)]
       (if (= :unavailable mode)
         (do
           (kernel/register-service!
            ctx :execution/repl
            {:backend :unavailable
             :sandbox :unavailable
             :available? false
             :reason "No safe Babashka sandbox is available on this OS."})
           nil)
         (let [command-path
               (or (fs/which command)
                   (throw (ex-info "Babashka command was not found"
                                   {:command command})))
               writable-root
               (fs/absolutize (fs/path workspace-root writable-dir))
               _ (when-not (fs/starts-with? writable-root workspace-root)
                   (throw
                    (ex-info
                     "Sandbox writable directory must be inside the project root"
                     {:writable-dir (str writable-root)})))
               state (atom nil)
               lock (Object.)
               config {:root workspace-root
                       :command command-path
                       :sandbox mode
                       :writable-root writable-root
                       :timeout-ms timeout-ms
                       :max-output-chars max-output-chars
                       :print-length print-length
                       :print-level print-level}
               service
               {:backend :babashka
                :sandbox mode
                :available? true
                :writable-root (str writable-root)
                :eval! (fn [code]
                         (when-not (string? code)
                           (throw (ex-info "REPL code must be a string" {})))
                         (when (str/blank? code)
                           (throw (ex-info "REPL code must not be blank" {})))
                         (when (> (count code) max-code-chars)
                           (throw
                            (ex-info "REPL code exceeds configured limit"
                                     {:max-code-chars max-code-chars})))
                         (request! state lock config code))}]
           (kernel/register-service! ctx :execution/repl service)
           #(locking lock
              (stop-worker! @state)
              (reset! state nil))))))})
