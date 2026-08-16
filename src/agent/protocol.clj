(ns agent.protocol
  "Versioned JSON event and stdin/stdout RPC projections."
  (:require [agent.kernel :as kernel]
            [cheshire.core :as json]
            [clojure.string :as str]))

(def protocol-version 1)

(defn- event-name [event]
  (if (keyword? event)
    (str (namespace event) "/" (name event))
    (str event)))

(defn- write-json! [value]
  (locking *out*
    (println (json/generate-string (assoc value :version protocol-version)))
    (flush)))

(defn subscribe-json! [ctx]
  (let [plugin-ctx (kernel/plugin-context ctx :protocol/json)
        session (kernel/require-service ctx :agent/session)
        dispose-session
        ((:subscribe! session)
         (fn [event]
           (write-json! {:type "event"
                         :event (event-name (:type event))
                         :data (dissoc event :type)})))]
    (doseq [event [:session/event :llm/stream :tool.execution/update
                   :tool.execution/end
                   :approval/event :context/compacted
                   :context/compaction-fallback]]
      (kernel/on! plugin-ctx event
                  (fn [_ data]
                    (write-json! {:type "event"
                                  :event (event-name event)
                                  :data data}))))
    (fn []
      (dispose-session)
      (kernel/dispose-plugin! ctx :protocol/json))))

(defn json-once! [ctx prompt]
  (let [dispose (subscribe-json! ctx)]
    (try
      (let [result ((kernel/require-service ctx :agent/run) prompt)]
        (write-json! {:type "result" :ok true :result result})
        result)
      (catch Throwable error
        (write-json! {:type "result" :ok false
                      :error {:message (ex-message error)
                              :data (ex-data error)}})
        (throw error))
      (finally (dispose)))))

(defn- rpc-response! [id result]
  (write-json! {:type "response" :id id :ok true :result result}))

(defn- rpc-error! [id error]
  (write-json! {:type "response" :id id :ok false
                :error {:message (ex-message error) :data (ex-data error)}}))

(defn rpc! [ctx]
  (let [session (kernel/require-service ctx :agent/session)
        store (kernel/require-service ctx :session/store)
        dispose (subscribe-json! ctx)
        tasks (atom #{})]
    (write-json! {:type "ready"})
    (try
      (loop []
        (when-let [line (read-line)]
          (when-not (str/blank? line)
            (let [{:keys [id method params] :as request}
                  (try
                    (json/parse-string line true)
                    (catch Throwable error
                      (rpc-error! nil error)
                      nil))]
              (when request
                (try
                  (case method
                    "prompt"
                    (let [{:keys [task result]}
                          ((:submit! session) (:message params)
                           (or (:options params) {}))]
                      (swap! tasks conj task)
                      (rpc-response! id {:accepted true})
                      (future
                        (let [{:keys [ok value error]} @result]
                          (if ok
                            (write-json! {:type "run-result"
                                          :request-id id :ok true
                                          :result value})
                            (write-json! {:type "run-result"
                                          :request-id id :ok false
                                          :error {:message (ex-message error)
                                                  :data (ex-data error)}}))
                          (swap! tasks disj task))))

                    "steer" (rpc-response! id
                                            ((:steer! session)
                                             (:message params)))
                    "follow-up" (rpc-response! id
                                                ((:follow-up! session)
                                                 (:message params)))
                    "abort" (rpc-response! id ((:abort! session)))
                    "state" (rpc-response! id ((:state session)))
                    "clear" (do ((:clear! store))
                                  (rpc-response! id {:cleared true}))
                    "compact" (rpc-response! id
                                              ((:compact! store)
                                               (or params {})))
                    "sessions"
                    (if-let [catalog (kernel/service ctx :session/catalog)]
                      (rpc-response! id ((:list catalog)))
                      (rpc-response! id []))
                    "providers"
                    (if-let [registry (kernel/service ctx :llm/registry)]
                      (rpc-response! id {:current ((:current registry))
                                         :providers ((:providers registry))})
                      (rpc-response! id nil))
                    "select-provider"
                    (rpc-response!
                     id
                     ((:select! (kernel/require-service ctx :llm/registry))
                      (keyword (:provider params))))
                    "reload"
                    (rpc-response!
                     id
                     ((:reload! (kernel/require-service
                                 ctx :resources/catalog))))
                    "shutdown" (do
                                 (rpc-response! id {:shutting-down true})
                                 ((:abort! session)))
                    (throw (ex-info "Unknown RPC method"
                                    {:method method})))
                  (catch Throwable error
                    (rpc-error! id error))))))
          (when-not (= "shutdown"
                       (:method (try (json/parse-string line true)
                                     (catch Throwable _ {}))))
            (recur))))
      (finally
        ((:abort! session))
        (doseq [task @tasks] (deref task 1000 nil))
        (dispose)))))
