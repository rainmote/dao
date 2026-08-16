(ns agent.plugins.resources
  "Trusted user/project context, prompt, and progressive skill discovery."
  (:require [agent.kernel :as kernel]
            [babashka.fs :as fs]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.nio.file Files LinkOption]))

(defn- regular-paths [directory]
  (let [root (.toPath (io/file directory))]
    (if-not (Files/isDirectory root (make-array LinkOption 0))
      []
      (with-open [paths (Files/walk root
                                    (make-array java.nio.file.FileVisitOption 0))]
        (->> (iterator-seq (.iterator paths))
             (filter #(Files/isRegularFile % (make-array LinkOption 0)))
             (remove #(Files/isSymbolicLink %))
             vec)))))

(defn- markdown-files [directory]
  (->> (regular-paths directory)
       (filter #(str/ends-with? (str/lower-case (str %)) ".md"))))

(defn- frontmatter-value [text key]
  (second (re-find (re-pattern (str "(?m)^" key ":\\s*(.+?)\\s*$")) text)))

(defn- skill-entry [scope path]
  (let [text (slurp (str path))
        fallback (str (.getFileName (.getParent path)))]
    {:name (or (frontmatter-value text "name") fallback)
     :description (or (frontmatter-value text "description")
                      (str "Skill from " fallback))
     :scope scope
     :path (str path)}))

(defn- context-entry [scope path]
  {:scope scope
   :name (str (.getFileName path))
   :path (str path)
   :content (slurp (str path))})

(defn- scope-resources [scope base project-root?]
  (let [base-file (io/file base)
        contexts
        (concat
         (for [name ["AGENTS.md" "SYSTEM.md"]
               :let [file (io/file base-file name)]
               :when (.isFile file)]
           (context-entry scope (.toPath file)))
         (when project-root?
           (for [name ["AGENTS.md" "SYSTEM.md"]
                 :let [file (io/file (.getParentFile base-file) name)]
                 :when (.isFile file)]
             (context-entry scope (.toPath file)))))
        prompts (for [path (markdown-files (io/file base-file "prompts"))]
                  {:name (str (.getFileName path))
                   :scope scope :path (str path)})
        skills (for [path (markdown-files (io/file base-file "skills"))
                     :when (= "SKILL.md" (str (.getFileName path)))]
                 (skill-entry scope path))]
    {:contexts (vec contexts) :prompts (vec prompts) :skills (vec skills)}))

(defn- discover [user-dir project-dir trusted?]
  (let [user (scope-resources :user user-dir false)
        project (if trusted?
                  (scope-resources :project project-dir true)
                  {:contexts [] :prompts [] :skills []})]
    {:contexts (vec (concat (:contexts user) (:contexts project)))
     :prompts (vec (concat (:prompts user) (:prompts project)))
     :skills (vec (concat (:skills user) (:skills project)))
     :project-trusted trusted?}))

(defn- catalog-prompt [{:keys [contexts skills]}]
  (str
   (when (seq contexts)
     (str "\n\nLoaded context files:\n"
          (str/join "\n\n"
                    (map #(str "# " (:name %) " (" (name (:scope %)) ")\n"
                               (:content %))
                         contexts))))
   (when (seq skills)
     (str "\n\nAvailable skills (call load_skill before following one):\n"
          (str/join "\n"
                    (map #(str "- " (:name %) ": " (:description %)
                               " [" (name (:scope %)) "]")
                         skills))))))

(def plugin
  {:id :resources/catalog
   :description "User/project context, prompts, skills, and atomic reload."
   :requires #{:project/trust}
   :provides #{:resources/catalog}
   :start
   (fn [ctx {:keys [root user-dir project-dir]
             :or {root "."}}]
     (let [workspace (fs/real-path root)
           user-root (or user-dir
                         (str (io/file (System/getProperty "user.home")
                                       ".bb-agent")))
           project-root (or project-dir (str (fs/path workspace ".bb-agent")))
           trust (kernel/require-service ctx :project/trust)
           scan! #(discover user-root project-root ((:trusted? trust)))
           state (atom (scan!))
           reload! (fn []
                     (let [candidate (scan!)]
                       ;; Discovery and reads finish before the visible atom is
                       ;; switched, so callers never observe half a catalog.
                       (reset! state candidate)
                       candidate))
           load-skill
           (fn [name]
             (if-let [skill (some #(when (= name (:name %)) %) (:skills @state))]
               {:name (:name skill)
                :description (:description skill)
                :scope (:scope skill)
                :content (slurp (:path skill))}
               (throw (ex-info "Skill was not found" {:name name}))))
           service
           {:snapshot (fn [] @state)
            :reload! reload!
            :skills (fn [] (:skills @state))
            :prompts (fn [] (:prompts @state))
            :contexts (fn [] (:contexts @state))
            :load-skill load-skill
            :render-prompt #(catalog-prompt @state)}]
       (kernel/register-service! ctx :resources/catalog service)
       (kernel/register-tool!
        ctx
        {:name "load_skill"
         :description "Load the full instructions for one discovered skill."
         :parameters {:type "object"
                      :required ["name"]
                      :properties {"name" {:type "string"}}
                      :additionalProperties false}
         :execute (fn [{:keys [name]} _] (load-skill name))
         :render (fn [_ value] (:content value))}))
     nil)})
