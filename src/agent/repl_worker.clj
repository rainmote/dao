(ns agent.repl-worker
  "Line-oriented EDN worker used by the Babashka REPL execution provider."
  (:require [clojure.edn :as edn])
  (:import [java.io StringWriter]))

(defn- limited [value limit]
  (let [text (str value)
        truncated (> (count text) limit)]
    {:text (subs text 0 (min limit (count text)))
     :truncated truncated}))

(defn- render-value [value print-length print-level]
  (binding [*print-length* print-length
            *print-level* print-level]
    (pr-str value)))

(defn- evaluate [repl-ns {:keys [code max-output-chars
                                 print-length print-level]}]
  (let [stdout (StringWriter.)
        stderr (StringWriter.)
        started (System/nanoTime)
        base {:backend "bb-repl"
              :namespace (str (ns-name repl-ns))}]
    (try
      (let [value (binding [*ns* repl-ns
                            *out* stdout
                            *err* stderr]
                    (load-string code))
            rendered (render-value value print-length print-level)
            value-result (limited rendered max-output-chars)
            stdout-result (limited stdout max-output-chars)
            stderr-result (limited stderr max-output-chars)]
        (assoc base
               :ok true
               :value (:text value-result)
               :stdout (:text stdout-result)
               :stderr (:text stderr-result)
               :truncated (boolean
                           (or (:truncated value-result)
                               (:truncated stdout-result)
                               (:truncated stderr-result)))
               :duration_ms (long (/ (- (System/nanoTime) started) 1000000))))
      (catch Throwable error
        (let [stdout-result (limited stdout max-output-chars)
              stderr-result (limited stderr max-output-chars)]
          (assoc base
                 :ok false
                 :error (or (ex-message error) (str (class error)))
                 :stdout (:text stdout-result)
                 :stderr (:text stderr-result)
                 :truncated (boolean
                             (or (:truncated stdout-result)
                                 (:truncated stderr-result)))
                 :duration_ms
                 (long (/ (- (System/nanoTime) started) 1000000))))))))

(defn- response [repl-ns request]
  (case (:op request)
    :eval (evaluate repl-ns request)
    :ping {:ok true :backend "bb-repl"}
    {:ok false :error (str "Unknown REPL operation: " (:op request))}))

(defn -main [& _]
  (let [repl-ns (create-ns 'agent.repl.user)
        protocol-out *out*]
    (loop []
      (when-let [line (read-line)]
        (let [request (try
                        (edn/read-string line)
                        (catch Throwable error
                          {:id nil :op :invalid :parse-error (ex-message error)}))
              result (if-let [parse-error (:parse-error request)]
                       {:ok false :error (str "Invalid worker request: " parse-error)}
                       (response repl-ns request))]
          (binding [*out* protocol-out]
            (prn (assoc result :id (:id request)))
            (flush))
          (recur))))))
