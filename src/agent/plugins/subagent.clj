(ns agent.plugins.subagent
  "Provider-neutral subagent registry and run lifecycle."
  (:require [agent.kernel :as kernel]
            [clojure.string :as str]))

(defn- provider-id [value]
  (cond
    (keyword? value) value
    (and (string? value) (not (str/blank? value))) (keyword value)
    :else value))

(defn- public-provider [provider]
  (dissoc provider :start))

(defn- public-job [job]
  (-> job
      (dissoc :handle :completion)
      (update :provider provider-id)))

(defn- requested-capabilities [request]
  (cond-> []
    (:output-schema request) (conj :output-schema)
    (:persona request) (conj :persona)
    (:tool-filter request) (conj :tool-filter)))

(defn- validate-request! [provider request]
  (when (str/blank? (:prompt request))
    (throw (ex-info "Subagent prompt must not be blank" {})))
  (doseq [capability (requested-capabilities request)]
    (when-not (true? (get-in provider [:capabilities capability]))
      (throw (ex-info "Subagent provider does not support requested capability"
                      {:provider (:id provider)
                       :capability capability}))))
  (let [parent-depth (or (:parent-depth request) 0)
        next-depth (inc parent-depth)
        provider-limit (get-in provider [:capabilities :max-depth])
        requested-limit (:max-depth request)
        limit (cond
                (and provider-limit requested-limit)
                (min provider-limit requested-limit)

                provider-limit provider-limit
                requested-limit requested-limit
                :else nil)]
    (when-not (and (int? parent-depth) (not (neg? parent-depth)))
      (throw (ex-info "Subagent parent depth must be a non-negative integer"
                      {:parent-depth parent-depth})))
    (when (and limit (> next-depth limit))
      (throw (ex-info "Subagent delegation depth limit exceeded"
                      {:provider (:id provider)
                       :depth next-depth
                       :max-depth limit})))
    (assoc request :depth next-depth :max-depth limit)))

(def plugin
  {:id :subagent/runtime
   :description "Named subagent provider registry with bounded run lifecycle."
   :provides #{:subagents/runtime}
   :start
   (fn [ctx _]
     (let [providers (atom {})
           jobs (atom {})
           register!
           (fn [{:keys [id start capabilities] :as provider}]
             (let [id (provider-id id)
                   provider (assoc provider :id id)]
               (when-not (and (keyword? id) (fn? start) (map? capabilities))
                 (throw (ex-info
                         "Subagent provider requires keyword :id, :start, and capabilities"
                         {:provider (dissoc provider :start)})))
               (when (contains? @providers id)
                 (throw (ex-info "Subagent provider is already registered"
                                 {:provider id})))
               (swap! providers assoc id provider)
               (kernel/emit! ctx :subagent/provider-added
                             (public-provider provider))
               (let [active? (atom true)]
                 (fn []
                   (when (compare-and-set! active? true false)
                     (swap! providers dissoc id)
                     (kernel/emit! ctx :subagent/provider-removed
                                   {:provider id}))))))
           release!
           (fn [run-id]
             (when-let [job (get @jobs run-id)]
               (swap! jobs dissoc run-id)
               (try ((get-in job [:handle :dispose!]))
                    (catch Throwable _))
               true))
           start!
           (fn [request]
             (let [id (provider-id (:provider request))
                   provider (get @providers id)]
               (when-not provider
                 (throw (ex-info "Subagent provider is not registered"
                                 {:provider id
                                  :available (set (keys @providers))})))
               (let [request (validate-request! provider request)
                     run-id (or (:id request) (str (random-uuid)))
                     started-at (System/currentTimeMillis)
                     handle ((:start provider)
                             (assoc request :id run-id :provider id))]
                 (when-not (and (map? handle)
                                (instance? clojure.lang.IDeref (:result handle))
                                (fn? (:cancel! handle))
                                (fn? (:dispose! handle)))
                   (throw (ex-info "Subagent provider returned an invalid handle"
                                   {:provider id :run-id run-id})))
                 (let [completion (promise)
                       job {:id run-id
                            :label (or (:label request) (:prompt request))
                            :provider id
                            :depth (:depth request)
                            :status :running
                            :started-at started-at
                            :handle handle
                            :completion completion}]
                   (when (contains? @jobs run-id)
                     ((:dispose! handle))
                     (throw (ex-info "Subagent run id is already active"
                                     {:run-id run-id})))
                   (swap! jobs assoc run-id job)
                   (kernel/emit! ctx :subagent/start (public-job job))
                   (future
                     (let [result
                           (try
                             @(:result handle)
                             (catch Throwable error
                               {:output ""
                                :stop-reason :error
                                :error (ex-message error)
                                :details (ex-data error)}))
                           completed-at (System/currentTimeMillis)
                           completed (assoc result
                                            :id run-id
                                            :provider id
                                            :depth (:depth request))]
                       (swap! jobs update run-id
                              #(when %
                                 (assoc % :status :completed
                                          :completed-at completed-at
                                          :result completed)))
                       (deliver completion completed)
                       (kernel/emit! ctx :subagent/end completed)))
                   (public-job job)))))
           wait!
           (fn [run-id & [timeout-ms]]
             (let [job (get @jobs run-id)]
               (when-not job
                 (throw (ex-info "Subagent run was not found"
                                 {:run-id run-id})))
               (let [result (if (some? timeout-ms)
                              (deref (:completion job) timeout-ms ::timeout)
                              @(:completion job))]
                 (if (= ::timeout result)
                   {:id run-id :status :running}
                   result))))
           interrupt!
           (fn [run-id]
             (if-let [job (get @jobs run-id)]
               (if (= :running (:status job))
                 (boolean ((get-in job [:handle :cancel!])))
                 false)
               (throw (ex-info "Subagent run was not found"
                               {:run-id run-id}))))
           runtime
           {:register! register!
            :providers #(->> @providers vals (map public-provider)
                             (sort-by (comp str :id)) vec)
            :provider #(some-> (get @providers (provider-id %))
                               public-provider)
            :start! start!
            :jobs #(->> @jobs vals (map public-job)
                        (sort-by :started-at) vec)
            :job #(some-> (get @jobs %) public-job)
            :wait! wait!
            :interrupt! interrupt!
            :release! release!}]
       (kernel/register-service! ctx :subagents/runtime runtime)
       (fn []
         (doseq [run-id (keys @jobs)]
           (when-let [job (get @jobs run-id)]
             (try ((get-in job [:handle :cancel!])) (catch Throwable _)))
           (release! run-id)))))})
