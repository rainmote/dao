(ns agent.plugins.runtime
  "Controllable agent session, deterministic tool batches, and the default loop."
  (:require [agent.cancellation :as cancellation]
            [agent.kernel :as kernel]
            [agent.schema :as schema]
            [agent.system-prompt :as system]
            [cheshire.core :as json]
            [clojure.string :as str]))

(defn- record! [ctx type data]
  (let [store (kernel/require-service ctx :session/store)
        event ((:append! store) type data)]
    (kernel/emit! ctx :session/event event)
    event))

(defn- record-message! [ctx message]
  (record! ctx "message" {:message message})
  message)

(defn- messages [ctx]
  ((:messages (kernel/require-service ctx :session/store))))

(defn- nonblank-string [value]
  (when (and (string? value) (not (str/blank? value))) value))

(defn- base-system-prompt [{:keys [system-prompt system-prompt-template]}]
  (case system-prompt-template
    nil system-prompt
    :omp @system/omp-template
    (throw (ex-info "Unknown system prompt template"
                    {:template system-prompt-template}))))

(defn- system-prompt [ctx config]
  (let [resources (kernel/service ctx :resources/catalog)
        snapshot (when resources
                   ((or (:prompt-snapshot resources) (:snapshot resources))))
        custom (or (nonblank-string (:custom-system-prompt config))
                   (get-in snapshot [:system-prompt :content]))
        append-prompt (or (nonblank-string (:append-system-prompt config))
                          (get-in snapshot [:append-system-prompt :content]))]
    (system/assemble
     {:base-prompt (base-system-prompt config)
      :custom-prompt custom
      :append-prompt append-prompt
      :contexts (:contexts snapshot)
      :skills (or (:model-skills snapshot) (:skills snapshot))
      :tool-names (when resources (mapv :name (kernel/tools ctx)))
      :workspace (:workspace snapshot)
      :local-date (when resources (str (java.time.LocalDate/now)))
      :project-trusted (:project-trusted snapshot)})))

(defn- blank-content? [content]
  (or (nil? content)
      (and (string? content) (str/blank? content))
      (and (sequential? content) (empty? content))))

(defn- arguments [tool-call]
  (let [raw (get-in tool-call [:function :arguments])]
    (cond
      (map? raw) raw
      (str/blank? raw) {}
      (string? raw) (json/parse-string raw true)
      :else (throw (ex-info "Tool arguments must be a JSON string or map"
                            {:arguments raw})))))

(defn- result-content [value]
  (if (string? value) value (json/generate-string value)))

(defn- failure [execution message & [details]]
  {:ok false
   :is-error true
   :execution execution
   :error message
   :details details
   :content (str "ERROR: " message)})

(defn- run-tool-body [{:keys [tool execution]}]
  (try
    (cancellation/throw-if-cancelled! (:cancel-token execution))
    (let [value ((:execute tool) (:arguments execution) execution)
          details (when-let [details-fn (:result-details tool)]
                    (details-fn (:arguments execution) value))]
      (when-let [output-schema (:output-schema tool)]
        (schema/validate! output-schema value
                          "Tool returned invalid canonical output"))
      {:ok true
       :is-error false
       :execution execution
       :value value
       :details details
       :content (if-let [render (or (:render-model tool) (:render tool))]
                  (render (:arguments execution) value)
                  (result-content value))})
    (catch Throwable error
      (failure execution (ex-message error) (ex-data error)))))

(defn- prepare-call! [ctx tool-call cancel-token on-update]
  (cancellation/throw-if-cancelled! cancel-token)
  (let [call-id (:id tool-call)
        tool-name (get-in tool-call [:function :name])
        tool (kernel/tool ctx tool-name)
        visible-arguments (try
                            (arguments tool-call)
                            (catch Throwable _
                              (get-in tool-call [:function :arguments])))
        base-execution {:token (str (random-uuid))
                        :call-id call-id
                        :name tool-name
                        :started-at-nanos (System/nanoTime)
                        :cancel-token cancel-token
                        :on-update on-update}]
    (record! ctx "tool/call" {:name tool-name
                               :call-id call-id
                               :arguments visible-arguments})
    (if-not tool
      {:call tool-call
       :result (failure base-execution (str "Unknown tool: " tool-name))}
      (try
        (let [args (arguments tool-call)
              execution (cond-> (assoc base-execution :arguments args)
                          (:approval-target tool)
                          (assoc :approval
                                 ((:approval-target tool) args)))
              validation-errors (schema/errors (:parameters tool) args)]
          (if (seq validation-errors)
            {:call tool-call
             :result (failure execution "Invalid tool arguments"
                              {:errors validation-errors})}
            (let [gate (kernel/waterfall
                        ctx :tool/pre-execute
                        {:decision :pending
                         :execution execution
                         :tool tool}
                        #(assoc % :decision :allow))]
              (if (= :deny (:decision gate))
                {:call tool-call
                 :result (assoc (failure execution
                                         (or (:reason gate)
                                             "Denied by policy"))
                                :terminate (boolean (:terminate gate)))}
                {:call tool-call
                 :prepared {:execution (:execution gate)
                            :tool (:tool gate)}}))))
        (catch Throwable error
          {:call tool-call
           :result (failure base-execution (ex-message error)
                            (ex-data error))})))))

(defn- execute-prepared! [ctx {:keys [prepared result] :as entry}]
  (if result
    entry
    (try
      (assoc entry :result
             (kernel/waterfall
              ctx :tool/post-execute
              (kernel/waterfall ctx :tool/execute prepared run-tool-body)
              identity))
      (catch Throwable error
        (assoc entry :result
               (failure (:execution prepared) (ex-message error)
                        (ex-data error)))))))

(defn- record-tool-result! [ctx {:keys [call result]}]
  (let [started-at (get-in result [:execution :started-at-nanos])
        duration-ms (when started-at
                      (max 0 (quot (- (System/nanoTime) started-at) 1000000)))
        result-data {:name (get-in call [:function :name])
                     :call-id (:id call)
                     :ok (:ok result)
                     :is-error (:is-error result)
                     :error (:error result)
                     :value (:value result)
                     :details (:details result)
                     :content (:content result)
                     :duration-ms duration-ms}]
    (kernel/emit! ctx :tool.execution/end result-data)
    ;; Canonical values can be large and often duplicate model content. Persist
    ;; the compact, renderer-oriented details instead so restored TUI cards keep
    ;; their semantics without doubling session size.
    (record! ctx "tool/result" (dissoc result-data :value))
    [call result]))

(defn- truncated-tool-results [tool-calls]
  (mapv (fn [tool-call]
          {:call tool-call
           :result
           (failure {:call-id (:id tool-call)
                     :name (get-in tool-call [:function :name])}
                    (str "Tool call was not executed because the model response "
                         "hit its output-token limit."))})
        tool-calls))

(defn- sequential-batch? [prepared]
  (boolean
   (some #(= :sequential (get-in % [:prepared :tool :execution-mode]))
         prepared)))

(defn- execute-batch! [ctx tool-calls cancel-token]
  (let [update! (fn [execution update]
                  (kernel/emit! ctx :tool.execution/update
                                {:execution-id (:token execution)
                                 :call-id (:call-id execution)
                                 :name (:name execution)
                                 :update update}))
        ;; Policy and approval always run in model order before any body starts.
        prepared (mapv #(prepare-call! ctx % cancel-token update!) tool-calls)
        executed (if (sequential-batch? prepared)
                   (mapv #(do
                            (cancellation/throw-if-cancelled! cancel-token)
                            (execute-prepared! ctx %))
                         prepared)
                   (let [tasks (mapv #(future (execute-prepared! ctx %))
                                     prepared)]
                     (mapv deref tasks)))]
    ;; Durable results are ordered by the original model calls even when live
    ;; updates and bodies completed in another order.
    (mapv #(record-tool-result! ctx %) executed)))

(defn- tool-result-message [tool-call result]
  {:role "tool"
   :tool_call_id (:id tool-call)
   :content (:content result)})

(defn- add-usage [total usage]
  (merge-with (fn [left right]
                (if (and (number? left) (number? right))
                  (+ left right)
                  right))
              total (or usage {})))

(defn- publish! [ctx listeners type data]
  (let [event (assoc data :type type)]
    (kernel/emit! ctx type event)
    (doseq [listener (vals @listeners)]
      (try (listener event) (catch Throwable _)))
    event))

(defn- set-phase! [ctx state listeners phase & [extra]]
  (let [next-state (cond-> (merge @state {:phase phase} extra)
                     (= phase :model)
                     (assoc :partial-assistant "" :partial-reasoning "")

                     (not= phase :model)
                     (dissoc :partial-assistant :partial-reasoning))]
    (reset! state next-state)
    (publish! ctx listeners :agent/state next-state)
    next-state))

(defn- track-partial! [ctx state listeners event]
  (when (= :model (:phase @state))
    (let [field (case (:type event)
                  :text/delta :partial-assistant
                  :reasoning/delta :partial-reasoning
                  nil)
          delta (:delta event)]
      (when (and field (string? delta))
        (let [next-state (swap! state update field str delta)]
          (publish! ctx listeners :agent/state next-state))))))

(defn- drain-kind! [queue kind]
  (let [selected (atom [])]
    (swap! queue
           (fn [items]
             (reduce (fn [remaining item]
                       (if (= kind (:kind item))
                         (do (swap! selected conj item) remaining)
                         (conj remaining item)))
                     [] items)))
    @selected))

(defn- inject-queued! [ctx queue listeners kind]
  (let [items (drain-kind! queue kind)]
    (doseq [{:keys [message]} items]
      (record-message! ctx {:role "user" :content message})
      (publish! ctx listeners :agent.message/queued-consumed
                {:kind kind :message message}))
    (when (seq items)
      (publish! ctx listeners :queue/changed {:queue @queue}))
    (count items)))

(defn- close-admission!
  [ctx active admission-lock queue listeners reason]
  (locking admission-lock
    (when @active
      (swap! active assoc :accepting-queue? false))
    (let [discarded @queue]
      (when (seq discarded)
        (reset! queue [])
        (doseq [item discarded]
          (record! ctx "queue/discarded" (assoc item :reason reason)))
        (publish! ctx listeners :queue/changed
                  {:queue [] :discarded (count discarded) :reason reason}))
      (count discarded))))

(defn- error-chain [error]
  (take-while some? (iterate ex-cause error)))

(defn- transport-error? [error]
  (let [message (->> (error-chain error)
                     (keep ex-message)
                     (str/join " ")
                     str/lower-case)]
    (or (some #(instance? java.io.IOException %) (error-chain error))
        (some #(str/includes? message %)
              ["remote host terminated the handshake"
               "connection reset"
               "connection refused"
               "connection closed"
               "broken pipe"
               "timed out"
               "timeout"
               "unexpected end of stream"
               "premature eof"
               "temporary failure in name resolution"]))))

(defn- retryable? [error]
  (let [data (ex-data error)
        status (or (:status data) (:http-status data))]
    (and (not (:cancelled data))
         (if (contains? data :retryable)
           (boolean (:retryable data))
           (or (contains? #{408 409 425 429 500 502 503 504} status)
               (and (nil? status) (transport-error? error)))))))

(defn- context-overflow? [error]
  (let [data (ex-data error)
        message (str/lower-case (or (ex-message error) ""))]
    (or (:context-overflow data)
        (str/includes? message "context length")
        (str/includes? message "context window")
        (str/includes? message "too many tokens"))))

(defn- cancellable-wait! [cancel-token milliseconds]
  (loop [remaining milliseconds]
    (cancellation/throw-if-cancelled! cancel-token)
    (when (pos? remaining)
      (let [slice (min remaining 50)]
        (Thread/sleep slice)
        (recur (- remaining slice))))))

(defn- generate-with-recovery! [ctx config request cancel-token state listeners]
  (let [llm (kernel/require-service ctx :llm/generate)
        context (kernel/service ctx :context/manager)
        max-retries (or (:max-retries config) 2)
        retry-delay-ms (or (:retry-delay-ms config) 250)]
    (loop [attempt 0 overflow-retried? false]
      (cancellation/throw-if-cancelled! cancel-token)
      (let [prepared (if context ((:prepare! context) request) request)]
        (set-phase! ctx state listeners :model {:attempt attempt})
        (let [outcome (try
                        {:response (kernel/waterfall ctx :llm/request
                                                     prepared llm)}
                        (catch Throwable error {:error error}))
              error (:error outcome)]
          (cond
            (nil? error) (:response outcome)

            (and (context-overflow? error)
                 context
                 (not overflow-retried?))
            (do
              (set-phase! ctx state listeners :compacting)
              ((:compact! context) {:force true :reason :overflow
                                    :cancel-token cancel-token
                                    :provider (get-in request
                                                      [:options :provider])})
              (publish! ctx listeners :agent/retry
                        {:reason :context-overflow :attempt (inc attempt)})
              (recur (inc attempt) true))

            (and (retryable? error) (< attempt max-retries))
            (do
              (set-phase! ctx state listeners :retry
                          {:attempt (inc attempt)})
              (publish! ctx listeners :agent/retry
                        {:reason :provider-error
                         :attempt (inc attempt)
                         :delay-ms (* retry-delay-ms (inc attempt))})
              (cancellable-wait! cancel-token
                                 (* retry-delay-ms (inc attempt)))
              (recur (inc attempt) overflow-retried?))

            :else (throw error)))))))

(defn- finish-or-continue!
  "Atomically consume messages queued at a natural stop, or close admission.

  Without this boundary a follow-up could observe an active run immediately
  after the final queue drain and then remain stranded until another run."
  [ctx active admission-lock queue listeners]
  (locking admission-lock
    (let [steering-count (inject-queued! ctx queue listeners :steer)
          follow-up-count (if (zero? steering-count)
                            (inject-queued! ctx queue listeners :follow-up)
                            0)
          continue-count (+ steering-count follow-up-count)]
      (when (zero? continue-count)
        (swap! active assoc :accepting-queue? false))
      continue-count)))

(defn- run-agent-body!
  [ctx config active admission-lock prompt options cancel-token queue state
   listeners]
  (when (blank-content? prompt)
    (throw (ex-info "Prompt must not be blank" {})))
  (record-message! ctx {:role "user" :content prompt})
  (publish! ctx listeners :agent.message/start {:role "user" :content prompt})
  (let [max-steps (or (:max-steps options) (:max-steps config) 12)]
    (loop [step 1 usage {}]
      (cancellation/throw-if-cancelled! cancel-token)
      (when (> step max-steps)
        (throw (ex-info "Agent exceeded its step limit"
                        {:max-steps max-steps :messages (messages ctx)})))
      ;; Steering becomes context immediately before the next model request.
      (inject-queued! ctx queue listeners :steer)
      (record! ctx "step/start" {:step step})
      (publish! ctx listeners :agent.turn/start {:step step})
      (let [request {:system-prompt (system-prompt ctx config)
                     :messages (messages ctx)
                     :tools (kernel/tool-schemas ctx)
                     :cancel-token cancel-token
                     :options (:model-options options)}
            response (generate-with-recovery!
                      ctx config request cancel-token state listeners)
            assistant (assoc (:message response) :role "assistant")
            tool-calls (vec (:tool_calls assistant))
            next-usage (add-usage usage (:usage response))]
        (record-message! ctx assistant)
        (publish! ctx listeners :agent.message/end {:message assistant})
        (if (seq tool-calls)
          (let [executions (if (= "length" (:finish-reason response))
                             (mapv #(record-tool-result! ctx %)
                                   (truncated-tool-results tool-calls))
                             (do
                               (set-phase! ctx state listeners :tool)
                               (execute-batch! ctx tool-calls cancel-token)))
                results (mapv second executions)]
            (doseq [[call result] executions]
              (record-message! ctx (tool-result-message call result)))
            (record! ctx "step/end" {:step step :tool-count (count results)})
            (publish! ctx listeners :agent.turn/end
                      {:step step :tool-count (count results)})
            (if (and (seq results) (every? :terminate results))
              (do
                (close-admission! ctx active admission-lock queue listeners
                                  :tool-terminated)
                {:content (or (:content assistant) "")
                 :terminated true :steps step :usage next-usage
                 :messages (messages ctx)})
              (recur (inc step) next-usage)))
          (let [continue-count (finish-or-continue!
                                ctx active admission-lock queue listeners)]
            (record! ctx "step/end" {:step step :tool-count 0})
            (publish! ctx listeners :agent.turn/end
                      {:step step :tool-count 0})
            (if (pos? continue-count)
              (recur (inc step) next-usage)
              {:content (or (:content assistant) "")
               :steps step :usage next-usage
               :messages (messages ctx)})))))))

(defn- run-agent!
  [ctx config active admission-lock prompt options queue state listeners]
  (let [token (or (:cancel-token options) (cancellation/create-token))
        run-id (str (random-uuid))]
    (locking admission-lock
      (when-not (compare-and-set! active nil {:token token :run-id run-id
                                              :accepting-queue? true})
        (throw (ex-info "An agent run is already active" {}))))
    (set-phase! ctx state listeners :model {:run-id run-id :attempt 0})
    (try
      (let [result (run-agent-body! ctx config active admission-lock prompt
                                    options token queue state listeners)]
        (set-phase! ctx state listeners :idle
                    {:run-id nil :attempt nil :last-result result})
        result)
      (catch Throwable error
        (close-admission! ctx active admission-lock queue listeners
                          (if (:cancelled (ex-data error)) :aborted :error))
        (if (:cancelled (ex-data error))
          (do
            (record! ctx "agent/aborted" {:run-id run-id})
            (publish! ctx listeners :agent/aborted {:run-id run-id}))
          (record! ctx "agent/error"
                   {:run-id run-id :message (ex-message error)}))
        (set-phase! ctx state listeners :idle
                    {:run-id nil :attempt nil :last-error (ex-message error)})
        (throw error))
      (finally
        (locking admission-lock
          (reset! active nil))))))

(defn- enqueue! [ctx active admission-lock queue listeners kind message]
  (when (blank-content? message)
    (throw (ex-info "Queued message must not be blank" {:kind kind})))
  (locking admission-lock
    (when-not (and @active (:accepting-queue? @active))
      (throw (ex-info "No agent run is accepting queued messages"
                      {:kind kind})))
    (let [item {:id (str (random-uuid)) :kind kind :message message}]
      (swap! queue conj item)
      (record! ctx "queue/added" item)
      (publish! ctx listeners :queue/changed {:queue @queue})
      item)))

(def plugin
  {:id :agent/default-loop
   :description "Controllable session with deterministic parallel tool batches."
   :requires #{:session/store :llm/generate}
   :provides #{:agent/run :agent/cancel :agent/session}
   :start
   (fn [ctx config]
     (let [active (atom nil)
           admission-lock (Object.)
           queue (atom [])
           listeners (atom {})
           state (atom {:phase :idle :run-id nil})
           run (fn
                 ([prompt] (run-agent! ctx config active admission-lock prompt
                                       {} queue state listeners))
                 ([prompt options]
                  (run-agent! ctx config active admission-lock prompt options
                              queue state listeners)))
           abort! (fn []
                    (when-let [{:keys [token]} @active]
                      (cancellation/cancel! token)))
           submit! (fn [message options]
                     (let [result (promise)
                           task (future
                                  (try
                                    (deliver result {:ok true
                                                     :value (run message options)})
                                    (catch Throwable error
                                      (deliver result {:ok false
                                                       :error error}))))]
                       {:task task :result result}))
           session
           {:submit! (fn
                       ([message] (submit! message {}))
                       ([message options] (submit! message options)))
            :steer! #(enqueue! ctx active admission-lock queue listeners
                               :steer %)
            :follow-up! #(enqueue! ctx active admission-lock queue listeners
                                   :follow-up %)
            :abort! abort!
            :state (fn [] @state)
            :subscribe!
            (fn [listener]
              (when-not (fn? listener)
                (throw (ex-info "Session listener must be a function" {})))
              (let [id (str (random-uuid))]
                (swap! listeners assoc id listener)
                (fn [] (swap! listeners dissoc id))))}]
       (kernel/on! ctx :llm/stream
                   (fn [_ event]
                     (track-partial! ctx state listeners event)))
       (kernel/register-service! ctx :agent/run run)
       (kernel/register-service! ctx :agent/cancel abort!)
       (kernel/register-service! ctx :agent/session session))
     nil)})
