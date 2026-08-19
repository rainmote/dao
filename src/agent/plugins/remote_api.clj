(ns agent.plugins.remote-api
  "Frontend-neutral remote methods exposed by the agent worker."
  (:require [agent.command :as command]
            [agent.kernel :as kernel]))

(def ^:private empty-params
  {:type "object" :additionalProperties false})

(defn- object-params [properties & required]
  (cond-> {:type "object"
           :properties properties
           :additionalProperties false}
    (seq required) (assoc :required (vec required))))

(defn- public-provider [entry]
  (some-> entry (dissoc :generate)))

(defn- session-snapshot [ctx]
  (let [store (kernel/require-service ctx :session/store)
        session (kernel/require-service ctx :agent/session)
        models (kernel/service ctx :llm/registry)
        interactions (kernel/service ctx :interaction/remote)]
    {:session_id (:session-id store)
     :path (:path store)
     :cursor (or (:seq (last ((:events store)))) 0)
     :events ((:events store))
     :state ((:state session))
     :models (when models
               {:current (public-provider ((:current models)))
                :providers ((:providers models))})
     :interactions (if interactions ((:pending interactions)) [])}))

(def plugin
  {:id :remote/api
   :description "Remote session, turn, model, command, and runtime methods."
   :requires #{:remote/registry :session/store :agent/session}
   :start
   (fn [ctx _]
     (let [registry (kernel/require-service ctx :remote/registry)
           store (kernel/require-service ctx :session/store)
           session (kernel/require-service ctx :agent/session)
           tasks (atom #{})
           register!
           (fn [definition]
             (kernel/track-effect! ctx ((:register! registry) definition)))
           method!
           (fn [method description params-schema result-schema handler]
             (register! {:method method
                         :description description
                         :params-schema params-schema
                         :result-schema result-schema
                         :handler handler}))]
       (method! "remote.methods" "Describe every registered remote method."
                empty-params {:type "array"}
                (fn [_] ((:methods registry))))
       (method! "session.snapshot" "Return a replayable session snapshot."
                empty-params {:type "object"}
                (fn [_] (session-snapshot ctx)))
       (method! "session.events" "Return durable events after a cursor."
                (object-params {"after" {:type "integer" :minimum 0}})
                {:type "object"}
                (fn [{:keys [after]}]
                  (let [events ((:events-after store) (or after 0))]
                    {:session_id (:session-id store)
                     :after (or after 0)
                     :cursor (or (:seq (last events)) (or after 0))
                     :events events})))
       (method! "session.rename" "Rename the current session."
                (object-params {"name" {:type "string" :minLength 1}}
                               "name")
                {:type "object"}
                (fn [{:keys [name]}]
                  (let [event ((:name! store) name)]
                    (kernel/emit! ctx :session/event event)
                    {:name name :event event})))
       (method! "session.clear" "Clear the active conversation branch."
                empty-params {:type "object"}
                (fn [_]
                  ((:clear! store))
                  (let [event (last ((:events store)))]
                    (kernel/emit! ctx :session/event event)
                    {:cleared true :event event})))
       (method! "session.compact" "Compact old session messages."
                (object-params
                 {"summary" {:type "string"}
                  "retain" {:type "integer" :minimum 1}})
                {:type "object"}
                (fn [params]
                  (let [result ((:compact! store) params)]
                    (when (:compacted result)
                      (kernel/emit! ctx :session/event
                                    (last ((:events store)))))
                    result)))
       (method! "session.tree" "Return the append-only session tree."
                empty-params {:type "array"}
                (fn [_] ((:tree store))))
       (method! "session.fork" "Fork the session to a host-selected destination."
                (object-params
                 {"destination" {:type "string" :minLength 1}}
                 "destination")
                {:type "object"}
                (fn [{:keys [destination]}] ((:fork! store) destination)))
       (method! "turn.submit" "Start an agent turn asynchronously."
                (object-params
                 {"message" {:type "string" :minLength 1}
                  "options" {:type "object"}}
                 "message")
                {:type "object"}
                (fn [{:keys [message options]}]
                  (let [request-id (str (random-uuid))
                        {:keys [task result]}
                        ((:submit! session) message (or options {}))]
                    (swap! tasks conj task)
                    (future
                      (let [{:keys [ok value error]} @result]
                        (kernel/emit!
                         ctx :remote/run-result
                         (if ok
                           {:request_id request-id :ok true :result value}
                           {:request_id request-id :ok false
                            :error {:message (ex-message error)
                                    :data (ex-data error)}}))
                        (swap! tasks disj task)))
                    {:accepted true :request_id request-id})))
       (method! "turn.steer" "Queue steering text for the active turn."
                (object-params {"message" {:type "string" :minLength 1}}
                               "message")
                {:type "object"}
                (fn [{:keys [message]}] ((:steer! session) message)))
       (method! "turn.follow-up" "Queue a follow-up for the active turn."
                (object-params {"message" {:type "string" :minLength 1}}
                               "message")
                {:type "object"}
                (fn [{:keys [message]}] ((:follow-up! session) message)))
       (method! "turn.abort" "Abort the active turn."
                empty-params {:type "object"}
                (fn [_] {:aborted (boolean ((:abort! session)))}))
       (method! "turn.state" "Return the live agent state."
                empty-params {:type "object"}
                (fn [_] ((:state session))))
       (method! "model.list" "List available providers and current selection."
                empty-params {:type "object"}
                (fn [_]
                  (if-let [models (kernel/service ctx :llm/registry)]
                    {:current (public-provider ((:current models)))
                     :providers ((:providers models))}
                    {:current nil :providers []})))
       (method! "model.select" "Select the provider used by future turns."
                (object-params {"provider" {:type "string" :minLength 1}}
                               "provider")
                {:type "object"}
                (fn [{:keys [provider]}]
                  (public-provider
                   ((:select! (kernel/require-service ctx :llm/registry))
                    (keyword provider)))))
       (method! "command.list" "List shared slash commands."
                empty-params {:type "array"}
                (fn [_] (command/commands ctx)))
       (method! "command.execute" "Execute one shared slash command."
                (object-params {"command" {:type "string" :minLength 1}}
                               "command")
                {:type "object"}
                (fn [{command-text :command}]
                  (let [{:keys [name]} (command/parse command-text)]
                    (when (contains? #{"fork" "quit"} name)
                      (throw (ex-info
                              "This command is unavailable over the remote boundary"
                              {:command name})))
                    (command/dispatch! ctx command-text))))
       (method! "runtime.status" "Describe loaded plugins, tools, and resources."
                empty-params {:type "object"}
                (fn [_]
                  (let [resources (kernel/service ctx :resources/catalog)]
                    {:plugins
                     (mapv #(-> (select-keys % [:id :namespace :description])
                                (update :namespace str))
                           (kernel/loaded-plugins ctx))
                     :tools (mapv #(select-keys % [:name :description
                                                   :parameters])
                                  (kernel/tools ctx))
                     :commands (command/commands ctx)
                     :resources
                     (when resources
                       (let [snapshot ((:snapshot resources))]
                         {:context-count (count (:contexts snapshot))
                          :prompt-count (count (:prompts snapshot))
                          :skill-count (count (:skills snapshot))
                          :project-trusted (:project-trusted snapshot)}))})))
       (method! "subagent.status" "List subagent providers and jobs."
                empty-params {:type "object"}
                (fn [_]
                  (if-let [subagents (kernel/service ctx :subagents/runtime)]
                    {:providers ((:providers subagents))
                     :jobs ((:jobs subagents))}
                    {:providers [] :jobs []})))
       (fn []
         ((:abort! session))
         (doseq [task @tasks] (deref task 1000 nil)))))})
