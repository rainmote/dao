(ns agent.plugins.subagent-in-process
  "Isolated in-process spawn/fork providers for the subagent runtime."
  (:require [agent.cancellation :as cancellation]
            [agent.kernel :as kernel]
            [agent.plugin :as plugin]
            [agent.schema :as schema]
            [cheshire.core :as json]
            [clojure.string :as str]))

(def ^:private default-allowed-tools
  #{"current_time" "read" "read_file" "ls" "find" "grep" "load_skill"})

(defn- effective-messages [events]
  (reduce
   (fn [messages event]
     (case (:type event)
       "message" (conj messages (get-in event [:data :message]))
       "session/clear" []
       "session/compaction" (vec (get-in event
                                           [:data :replacement_messages]))
       messages))
   [] events))

(defn- completed-parent-messages [parent-ctx]
  (if-let [store (and parent-ctx
                      (kernel/service parent-ctx :session/store))]
    (let [events (vec ((:events store)))
          boundary (last (keep-indexed
                          (fn [index event]
                            (when (= "step/end" (:type event)) index))
                          events))
          completed (if (some? boundary)
                      (subvec events 0 (inc boundary))
                      [])
          ;; A clear or compaction may happen between runs. Preserve those
          ;; checkpoints while excluding messages from the currently open turn.
          later-checkpoints
          (->> (if (some? boundary)
                 (subvec events (inc boundary))
                 events)
               (filter #(contains? #{"session/clear" "session/compaction"}
                                    (:type %))))]
      (effective-messages (concat completed later-checkpoints)))
    []))

(defn- seed! [child messages]
  (let [store (kernel/require-service child :session/store)]
    (doseq [message messages]
      ((:append! store) "message" {:message message}))))

(defn- final-output [child]
  (or (some (fn [message]
              (when (= "assistant" (:role message)) (:content message)))
            (reverse ((:messages
                       (kernel/require-service child :session/store)))))
      ""))

(defn- effective-tool-filter [base requested]
  (let [base (set base)
        requested (when requested (set requested))
        outside (seq (remove base requested))]
    (when outside
      (throw (ex-info "Subagent tool filter cannot expand provider permissions"
                      {:requested requested
                       :allowed base
                       :disallowed (set outside)})))
    (or requested base)))

(defn- inherit-parent-resources! [child parent]
  (when-let [resources (and parent
                            (kernel/service parent :resources/catalog))]
    (let [bridge (kernel/plugin-context child :subagent/parent-resources)]
      (when-not (kernel/service child :resources/catalog)
        ;; The catalog switches atomically and exposes read-only skill access,
        ;; so a child can share it without rescanning or bypassing parent trust.
        (kernel/register-service! bridge :resources/catalog resources))
      (when (and (kernel/tool parent "load_skill")
                 (nil? (kernel/tool child "load_skill")))
        (kernel/register-tool! bridge (kernel/tool parent "load_skill")))
      (kernel/mark-loaded!
       child
       {:id :subagent/parent-resources
        :namespace 'agent.plugins.subagent-in-process
        :description "Inherited read-only skill catalog from the parent."}))))

(defn- install-boundary! [child {:keys [tool-filter persona output-schema]}]
  (let [boundary (kernel/plugin-context child :subagent/child-boundary)
        schema-text (when output-schema (json/generate-string output-schema))
        extra-prompt
        (str
         (when-not (str/blank? persona)
           (str "\n\nSubagent persona:\n" persona))
         (when schema-text
           (str "\n\nReturn only one JSON value matching this schema. "
                "Do not wrap it in Markdown fences:\n" schema-text)))]
    (kernel/intercept!
     boundary :llm/request -100
     (fn [_ request next]
       (next (cond-> (update request :tools
                             (fn [tools]
                               (filterv #(contains?
                                          tool-filter
                                          (get-in % [:function :name]))
                                        tools)))
               (not (str/blank? extra-prompt))
               (update :system-prompt str extra-prompt)))))
    (kernel/intercept!
     boundary :tool/pre-execute -100
     (fn [_ request next]
       (if (contains? tool-filter (get-in request [:execution :name]))
         (next request)
         (assoc request :decision :deny
                        :reason "Tool is outside the subagent read-only boundary"))))
    (kernel/mark-loaded! child
                         {:id :subagent/child-boundary
                          :namespace 'agent.plugins.subagent-in-process
                          :description "Per-child persona, schema, and tool boundary."})))

(defn- structured-output [output output-schema]
  (when output-schema
    (let [value (json/parse-string output true)]
      (schema/validate! output-schema value
                        "Subagent output did not match the requested schema")
      value)))

(defn- start-child
  [child-profile mode allowed-tools request]
  (let [child-token (cancellation/create-token)
        detach-parent (cancellation/on-cancel!
                       (:cancel-token request)
                       #(cancellation/cancel! child-token))
        child-holder (atom nil)
        result (promise)
        disposed? (atom false)
        cancel! #(cancellation/cancel! child-token)
        dispose! (fn []
                   (when (compare-and-set! disposed? false true)
                     (cancel!)
                     (detach-parent)
                     (when-let [child @child-holder]
                       (kernel/dispose-all! child))))
        task
        (future
          (try
            (let [child (plugin/boot! child-profile)
                  tools (effective-tool-filter allowed-tools
                                               (:tool-filter request))]
              (reset! child-holder child)
              (when @disposed?
                (kernel/dispose-all! child)
                (cancellation/throw-if-cancelled! child-token))
              (when (= :fork mode)
                (seed! child (completed-parent-messages
                              (:parent-context request))))
              (inherit-parent-resources! child (:parent-context request))
              (install-boundary! child
                                 {:tool-filter tools
                                  :persona (:persona request)
                                  :output-schema (:output-schema request)})
              (let [run (kernel/require-service child :agent/run)
                    value (run (:prompt request)
                               {:cancel-token child-token
                                :max-steps (:max-steps request)
                                :model-options (:model-options request)})
                    output (:content value)]
                (deliver result
                         (cond-> {:output output
                                  :stop-reason :completed
                                  :usage (:usage value)
                                  :steps (:steps value)}
                           (:output-schema request)
                           (assoc :structured
                                  (structured-output
                                   output (:output-schema request)))))))
            (catch Throwable error
              (let [aborted? (or (:cancelled (ex-data error))
                                 (cancellation/cancelled? child-token))]
                (deliver result
                         {:output (if-let [child @child-holder]
                                    (final-output child)
                                    "")
                          :stop-reason (if aborted? :aborted :error)
                          :error (ex-message error)
                          :details (ex-data error)})))
            (finally
              (detach-parent)
              (when (and @disposed? @child-holder)
                (kernel/dispose-all! @child-holder)))))]
    {:result result
     :task task
     :cancel! cancel!
     :dispose! dispose!}))

(def plugin
  {:id :subagent/in-process
   :description "Spawn and safe-fork subagents in isolated plugin contexts."
   :requires #{:subagents/runtime}
   :start
   (fn [ctx {:keys [child-profile allowed-tools max-depth providers]
             :or {allowed-tools default-allowed-tools
                  max-depth 1
                  providers [{:id :spawn :mode :spawn}
                             {:id :fork :mode :fork}]}}]
     (when-not (and (map? child-profile) (seq (:plugins child-profile)))
       (throw (ex-info "In-process subagents require a non-empty child profile"
                       {})))
     (when-not (and (pos-int? max-depth) (= 1 max-depth))
       (throw (ex-info
               "The in-process provider currently supports max-depth 1"
               {:max-depth max-depth})))
     (let [runtime (kernel/require-service ctx :subagents/runtime)
           allowed-tools (set allowed-tools)]
       (doseq [{:keys [id mode]} providers]
         (when-not (contains? #{:spawn :fork} mode)
           (throw (ex-info "Unknown in-process subagent mode"
                           {:provider id :mode mode})))
         (kernel/track-effect!
          ctx
          ((:register! runtime)
           {:id id
            :kind :in-process
            :mode mode
            :capabilities {:output-schema true
                           :persona true
                           :tool-filter true
                           :max-depth max-depth}
            :start #(start-child child-profile mode allowed-tools %)}))))
     nil)})
