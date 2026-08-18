(ns agent.test-runner
  (:require [agent.cancellation :as cancellation]
            [agent.command :as command]
            [agent.cli :as cli]
            [agent.api :as api]
            [agent.kernel :as kernel]
            [agent.plugin :as plugin]
            [agent.protocol :as protocol]
            [agent.sandbox :as sandbox]
            [agent.ui :as ui]
            [agent.plugins.chatgpt]
            [agent.plugins.omp]
            [agent.plugins.openai]
            [agent.plugins.subagent]
            [agent.plugins.subagent-in-process]
            [agent.plugins.subagent-tools]
            [agent.plugins.trust :as trust]
            [agent.plugins.tui :as tui]
            [agent.schema :as schema]
            [agent.streaming :as streaming]
            [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is run-tests testing]]))

(declare delete-tree!)

(deftest reversible-kernel-effects
  (let [ctx (kernel/create-context)
        plugin-ctx (kernel/plugin-context ctx :test/plugin)
        seen (atom [])]
    (kernel/register-service! plugin-ctx :demo/value 42)
    (kernel/register-tool! plugin-ctx
                           {:name "demo"
                            :description "demo"
                            :parameters {:type "object"}
                            :execute (fn [_ _] {:ok true})})
    (kernel/on! plugin-ctx :demo/event
                (fn [_ event] (swap! seen conj event)))
    (is (= 42 (kernel/service ctx :demo/value)))
    (is (= ["demo"] (mapv :name (kernel/tools ctx))))
    (kernel/emit! ctx :demo/event {:value 1})
    (is (= [{:value 1}] @seen))
    (kernel/dispose-plugin! ctx :test/plugin)
    (is (nil? (kernel/service ctx :demo/value)))
    (is (empty? (kernel/tools ctx)))
    (kernel/emit! ctx :demo/event {:value 2})
    (is (= [{:value 1}] @seen))))

(defn- tui-test-context []
  (plugin/boot!
   {:plugins
    [{:ns 'agent.plugins.session}
     {:ns 'agent.plugins.mock :config {:responses []}}
     {:ns 'agent.plugins.runtime}
     {:ns 'agent.plugins.tui}]}))

(deftest tui-sessions-are-recoverable-by-default
  (let [base {:plugins [{:ns 'agent.plugins.session :config {:path nil}}]}
        configured (cli/ensure-tui-session-path base)
        path (get-in configured [:plugins 0 :config :path])]
    (is (re-find #"^\.bb-agent/sessions/\d{8}-\d{6}-[0-9a-f]{8}\.jsonl$"
                 path))
    (is (= "/tmp/explicit.jsonl"
           (get-in (cli/ensure-tui-session-path
                    (assoc-in base [:plugins 0 :config :path]
                              "/tmp/explicit.jsonl"))
                   [:plugins 0 :config :path])))
    (is (nil? (get-in (cli/ensure-tui-session-path
                       (assoc-in base [:plugins 0 :config :ephemeral] true))
                      [:plugins 0 :config :path])))))

(deftest tui-prompts-for-an-undecided-project-before-tool-use
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "bb-agent-trust-prompt-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        trust-file (io/file directory "user" "trust.edn")
        ctx (plugin/boot!
             {:plugins
              [{:ns 'agent.plugins.session}
               {:ns 'agent.plugins.mock :config {:responses []}}
               {:ns 'agent.plugins.runtime}
               {:ns 'agent.plugins.trust
                :config {:root (str directory)
                         :trust-file (str trust-file)}}
               {:ns 'agent.plugins.tui}]})]
    (try
      (let [service (kernel/require-service ctx :ui/extensions)
            registries (:registries service)
            state (tui/initial-state ctx {} registries)
            trust-service (kernel/require-service ctx :project/trust)]
        (is (= "Trust this project?" (get-in state [:overlay :title])))
        (is (= :deny
               (get-in state [:overlay :items
                              (get-in state [:overlay :selected]) :value])))
        (is (false? ((:trusted? trust-service))))
        (is (:overlay (tui/handle-key ctx state :escape nil)))
        (is (false? (:running? (tui/handle-key ctx state :ctrl-c nil))))
        (is (false? (:explicit?
                     (trust/decision-info directory (str trust-file)))))
        (let [allowed (tui/handle-key
                       ctx (tui/handle-key ctx state :up nil) :enter nil)]
          (is (nil? (:overlay allowed)))
          (is ((:trusted? trust-service)))
          (is (= {:decision :allow :explicit? true}
                 (select-keys (trust/decision-info
                               directory (str trust-file))
                              [:decision :explicit?])))
          ;; The saved decision prevents the startup choice from reopening.
          (is (nil? (:overlay
                     (tui/initial-state ctx {} registries))))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest shared-command-dispatch-and-tui-editor
  (let [ctx (tui-test-context)]
    (try
      (let [plugin-ctx (kernel/plugin-context ctx :test/command)]
        (kernel/register-command!
         plugin-ctx
         {:name "hello" :description "test"
          :execute (fn [argument _] (str "hello " argument))})
        (is (= "hello world"
               (:output (command/dispatch! ctx "/hello world"))))
        (is (some #(= "hello" (:name %)) (command/commands ctx))))
      (let [editor (-> (tui/make-editor)
                       (tui/editor-insert "alpha")
                       (tui/editor-insert "\nβeta"))]
        (is (= "alpha\nβeta" (:text editor)))
        (is (= 10 (:cursor editor)))
        (is (= 4 (:cursor (tui/editor-vertical editor :up))))
        (is (= "alpha\nβet" (:text (tui/editor-backspace editor)))))
      (let [service (kernel/require-service ctx :ui/extensions)
            state (assoc (tui/initial-state ctx {} (:registries service))
                         :width 60 :height 14
                         :editor (tui/make-editor "two\nlines"))
            rendered (tui/render-screen state)]
        (is (= 14 (count rendered)))
        (is (some #(str/includes? % "bb-agent") rendered))
        (is (some #(str/includes? % "two") rendered)))
      (let [service (kernel/require-service ctx :ui/extensions)
            state (assoc (tui/initial-state ctx {} (:registries service))
                         :editor (tui/make-editor "/th"))
            completed (tui/handle-key ctx state :tab nil)]
        (is (= "Commands" (get-in completed [:overlay :title])))
        (is (some #(= "/theme " (:value %))
                  (get-in completed [:overlay :items]))))
      (let [service (kernel/require-service ctx :ui/extensions)
            state (assoc (tui/initial-state ctx {} (:registries service))
                         :agent-state {:phase :model
                                       :partial-assistant "**streaming** now"})]
        (is (some #(str/includes? (tui/strip-ansi %) "Assistant · live")
                  (tui/transcript-lines state 60))))
      (let [service (kernel/require-service ctx :ui/extensions)
            base (tui/replace-session-events
                  (tui/initial-state ctx {} (:registries service))
                  [{:type "tool/call"
                    :data {:name "bash" :call-id "live-1"
                           :arguments {:command "echo ok"}}}])
            updated (tui/update-state
                     ctx base
                     {:type :tool-update
                      :event {:call-id "live-1" :name "bash"
                              :update {:stream :stdout :chunk "ok\n"}}}
                     (:registries service))]
        (is (some #(str/includes? (tui/strip-ansi %) "running")
                  (tui/transcript-lines updated 60))))
      (let [catalog-ctx (kernel/plugin-context ctx :test/catalog)]
        (let [refresh-count (atom 0)]
        (kernel/register-service!
         catalog-ctx :session/catalog
         {:list (fn [] [{:name "picked" :path "/tmp/picked.jsonl"
                         :message-count 3}])
          :refresh! #(swap! refresh-count inc)})
        (let [service (kernel/require-service ctx :ui/extensions)
              state (assoc (tui/initial-state ctx {} (:registries service))
                           :editor (tui/make-editor "/sessions"))
              selector (tui/handle-key ctx state :enter nil)
              selected (tui/handle-key ctx selector :enter nil)]
          (is (= "/tmp/picked.jsonl" (:next-session selected)))
          (is (false? (:running? selected)))
          (is (= 1 @refresh-count)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest tui-editor-layout-and-transcript-regressions
  (let [ctx (tui-test-context)
        service (kernel/require-service ctx :ui/extensions)
        registries (:registries service)]
    (try
      (testing "editing operates on graphemes and visual columns"
        (is (= {:text "A😀" :cursor 3}
               (tui/editor-backspace (tui/make-editor "A😀é"))))
        (is (= {:text "A" :cursor 1}
               (-> (tui/make-editor "A😀é")
                   tui/editor-backspace
                   tui/editor-backspace)))
        (is (= 7
               (:cursor (tui/editor-vertical
                         {:text "中文\nabcdef" :cursor 2} :down)))))
      (testing "history restores the draft that existed before browsing"
        (let [state (assoc (tui/initial-state ctx {} registries)
                           :history ["old prompt"]
                           :editor (tui/make-editor "draft"))
              recalled (tui/handle-key ctx state :up nil)
              restored (tui/handle-key ctx recalled :down nil)]
          (is (= "old prompt" (get-in recalled [:editor :text])))
          (is (= (tui/make-editor "draft") (:editor restored)))))
      (testing "completion preserves suffixes and places the cursor at insertion"
        (let [state (assoc (tui/initial-state ctx {} registries)
                           :editor {:text "/thX" :cursor 3})
              overlay (tui/handle-key ctx state :tab nil)
              completed (tui/handle-key ctx overlay :enter nil)]
          (is (= "/theme X" (get-in completed [:editor :text])))
          (is (= 7 (get-in completed [:editor :cursor])))))
      (testing "editor and large selectors remain inside the terminal"
        (let [state (assoc (tui/initial-state ctx {} registries)
                           :width 40 :height 10
                           :editor (tui/make-editor
                                    (str/join "\n" (repeat 30 "line"))))]
          (is (= 10 (count (tui/render-screen state)))))
        (let [state (tui/update-state
                     ctx (assoc (tui/initial-state ctx {} registries)
                                :width 40 :height 10)
                     {:type :ui-request :kind :select :result (promise)
                      :request {:title "Many"
                                :items (mapv #(hash-map :label (str "Item " %)
                                                       :value %)
                                             (range 20))}}
                     registries)
              state (assoc-in state [:overlay :selected] 18)
              rendered (map tui/strip-ansi (tui/render-screen state))]
          (is (= 10 (count rendered)))
          (is (some #(str/includes? % "Item 18") rendered))))
      (testing "transcript scroll supports pages, mouse wheels, and live updates"
        (let [events (mapv (fn [index]
                             {:type "message"
                              :data {:message {:role "user"
                                               :content (str "history-" index)}}})
                           (range 30))
              state (assoc (tui/replace-session-events
                            (tui/initial-state ctx {} registries)
                            events)
                           :width 60 :height 12)
              scrolled (tui/handle-key ctx state :page-up nil)
              visible-history
              (fn [value]
                (set (re-seq #"history-\d+"
                             (str/join "\n"
                                       (map tui/strip-ansi
                                            (tui/render-screen value))))))
              before-update (visible-history scrolled)
              appended (tui/update-state
                        ctx scrolled
                        {:type :session-event
                         :event {:type "message"
                                 :data {:message {:role "user"
                                                  :content "history-30"}}}}
                        registries)]
          (is (pos? (:scroll scrolled)))
          (is (seq before-update))
          (is (= before-update (visible-history appended)))
          (is (> (:scroll appended) (:scroll scrolled)))
          (is (some #(str/includes? (tui/strip-ansi %) "history ↑")
                    (tui/render-screen appended)))
          (is (= :page-up (tui/mouse-wheel-key "[<64;20;8M")))
          (is (= :page-down (tui/mouse-wheel-key "[<65;20;8M")))
          (let [at-bottom (nth (iterate #(tui/handle-key
                                         ctx % :page-down nil)
                                        appended)
                               20)]
            (is (zero? (:scroll at-bottom)))
            (is (contains? (visible-history at-bottom) "history-30")))))
      (testing "clear/compaction projection matches the model-visible context"
        (let [state (tui/replace-session-events
                     (tui/initial-state ctx {} registries)
                     [{:type "message"
                       :data {:message {:role "user" :content "old"}}}
                      {:type "session/clear" :data {}}
                      {:type "message"
                       :data {:message {:role "user" :content "new"}}}])
              lines (str/join "\n" (map tui/strip-ansi
                                          (tui/transcript-lines state 60)))]
          (is (not (str/includes? lines "old")))
          (is (str/includes? lines "new")))
        (let [state (-> (tui/initial-state ctx {} registries)
                        (tui/replace-session-events
                         [{:type "message"
                           :data {:message {:role "user"
                                            :content "stale"}}}])
                        (assoc :editor (tui/make-editor "/clear")))
              cleared (tui/handle-key ctx state :enter nil)
              lines (str/join "\n" (map tui/strip-ansi
                                          (tui/transcript-lines cleared 60)))]
          (is (not (str/includes? lines "stale")))
          (is (some #(= "session/clear" (:type %)) (:events cleared)))))
      (testing "durable results release live tool buffers and queue is visible"
        (let [base (assoc (tui/initial-state ctx {} registries)
                          :live-tools {"call" {:updates [{:chunk "x"}]}})
              ended (tui/update-state
                     ctx base
                     {:type :session-event
                      :event {:type "tool/result"
                              :data {:call-id "call" :name "demo"
                                     :ok true :content "ok"}}}
                     registries)
              queued (tui/update-state
                      ctx ended
                      {:type :queue-update
                       :queue [{:kind :follow-up :message "later"}]}
                      registries)]
          (is (empty? (:live-tools ended)))
          (is (some #(str/includes? (tui/strip-ansi %) "follow-up: later")
                    (tui/render-screen queued)))))
      (testing "a tool call and result render as one informative execution card"
        (let [state (tui/replace-session-events
                     (tui/initial-state ctx {} registries)
                     [{:type "tool/call" :at "2026-08-16T00:00:00Z"
                       :data {:name "demo" :call-id "one"
                              :arguments {:value 42}}}
                      {:type "tool/result" :at "2026-08-16T00:00:00.017Z"
                       :data {:name "demo" :call-id "one" :ok true
                              :content "answer: 42"}}])
              lines (mapv tui/strip-ansi (tui/transcript-lines state 60))]
          (is (= 1 (count (filter #(re-find #"^[◆✓✗] demo" %) lines))))
          (is (some #(= "✓ demo · done · 17 ms" %) lines))
          (is (some #(str/includes? % "args: {:value 42}") lines))
          (is (some #(str/includes? % "result: answer: 42") lines)))
        (let [base (tui/replace-session-events
                    (tui/initial-state ctx {} registries)
                    [{:type "tool/call"
                      :data {:name "demo" :call-id "live"
                             :arguments {:value 1}}}])
              ended (tui/update-state
                     ctx base
                     {:type :tool-end
                      :event {:name "demo" :call-id "live" :ok false
                              :error "boom" :content "boom"
                              :duration-ms 9}}
                     registries)
              lines (mapv tui/strip-ansi (tui/transcript-lines ended 60))]
          (is (= 1 (count (filter #(re-find #"^[◆✓✗] demo" %) lines))))
          (is (some #(= "✗ demo · error · 9 ms" %) lines))
          (is (some #(str/includes? % "error: boom") lines)))
        (let [state (tui/replace-session-events
                     (tui/initial-state ctx {} registries)
                     [{:type "tool/call"
                       :data {:name "bash" :call-id "bash-1"
                              :arguments {:command "printf hello"
                                          :cwd "src"}}}
                      {:type "tool/result"
                       :data {:name "bash" :call-id "bash-1" :ok true
                              :duration-ms 5
                              :details {:exit-code 0 :stdout-chars 5
                                        :stderr-chars 0 :truncated false}
                              :content "exit 0\nstdout:\nhello"}}])
              lines (mapv tui/strip-ansi (tui/transcript-lines state 80))]
          (is (some #(= "✓ bash · exit 0 · 5 ms" %) lines))
          (is (some #(str/includes? % "command: $ printf hello · cwd src")
                    lines))
          (is (some #(str/includes? % "output: exit 0 · stdout 5 chars")
                    lines)))
        (let [state (tui/replace-session-events
                     (tui/initial-state ctx {} registries)
                     [{:type "tool/call"
                       :data {:name "read" :call-id "read-1"
                              :arguments {:path "README.md" :limit 20}}}
                      {:type "tool/result"
                       :data {:name "read" :call-id "read-1" :ok true
                              :duration-ms 2 :content "hello\nworld"
                              :details {:path "README.md" :offset 0
                                        :line-count 2 :total-lines 40
                                        :size 500 :truncated true}}}])
              lines (mapv tui/strip-ansi (tui/transcript-lines state 80))]
          (is (some #(str/includes? % "file: README.md · 20 lines") lines))
          (is (some #(str/includes?
                      % "preview: lines 1-2/40 · 500 chars · more available")
                    lines))))
      (testing "durable entry rendering is reused across live updates"
        (let [render-count (atom 0)
              cached-registries
              (fn []
                (assoc-in (registries) [:message-renderers :user]
                          (fn [message _]
                            (swap! render-count inc)
                            [(str "cached " (:content message))])))
              events (conj
                      (mapv (fn [index]
                              {:id (str "cache-" index)
                               :type "message"
                               :data {:message {:role "user"
                                                :content (str index)}}})
                            (range 1000))
                      {:id "cache-tool" :type "tool/call"
                       :data {:name "bash" :call-id "cache-live"
                              :arguments {:command "echo ok"}}})
              loaded (tui/replace-session-events
                      (tui/initial-state ctx {} cached-registries) events)
              updated (tui/update-state
                       ctx loaded
                       {:type :tool-update
                        :event {:call-id "cache-live" :name "bash"
                                :update {:stream :stdout :chunk "ok"}}}
                       cached-registries)
              after-live-count @render-count
              appended (tui/update-state
                        ctx updated
                        {:type :session-event
                         :event {:id "cache-new" :type "message"
                                 :data {:message {:role "user"
                                                  :content "new"}}}}
                        cached-registries)]
          (is (= 1000 after-live-count))
          (is (= 1003 (count (tui/transcript-lines updated 80))))
          (is (= 1001 @render-count))
          (is (some #(str/includes? (tui/strip-ansi %) "cached new")
                    (tui/transcript-lines appended 80)))))
      (testing "idle Ctrl+C requires a deliberate second press"
        (let [state (assoc (tui/initial-state ctx {} registries)
                           :editor (tui/make-editor "discard me"))
              first-press (tui/handle-key ctx state :ctrl-c nil)
              second-press (tui/handle-key ctx first-press :ctrl-c nil)]
          (is (:running? first-press))
          (is (= "" (get-in first-press [:editor :text])))
          (is (false? (:running? second-press)))))
      (finally (kernel/dispose-all! ctx)))))

(deftest tui-streaming-submit-matches-pi-steer-and-follow-up-semantics
  (let [ctx (kernel/create-context)
        plugin-ctx (kernel/plugin-context ctx :test/tui-submit)
        calls (atom [])]
    (try
      (kernel/register-service!
       plugin-ctx :agent/session
       {:steer! #(swap! calls conj [:steer %])
        :follow-up! #(swap! calls conj [:follow-up %])
        :abort! (fn [] false)})
      (let [state {:editor (tui/make-editor "now")
                   :agent-state {:phase :model}
                   :registries {:shortcuts {}}
                   :history [] :notifications [] :running? true}
            after-steer (tui/handle-key ctx state :enter nil)
            after-follow-up (tui/handle-key
                             ctx (assoc after-steer
                                        :editor (tui/make-editor "later"))
                             :alt-enter nil)]
        (is (= [[:steer "now"] [:follow-up "later"]] @calls))
        (is (= ["now" "later"] (:history after-follow-up))))
      (finally (kernel/dispose-all! ctx)))))

(deftest reversible-ui-extension-registry-and-overlay
  (let [ctx (tui-test-context)
        extension-ctx (kernel/plugin-context ctx :test/ui-extension)
        service (kernel/require-service ctx :ui/extensions)]
    (try
      (is (= "The TUI prompt service is not active"
             (try
               ((:select! (kernel/require-service ctx :ui/prompt))
                {:title "inactive" :items []})
               nil
               (catch Throwable error (ex-message error)))))
      (ui/register-message-renderer! extension-ctx :demo
                                     (fn [_ _] ["demo"]))
      (ui/register-tool-renderer! extension-ctx "demo_tool"
                                  (fn [_ _] ["tool"]))
      (ui/register-shortcut! extension-ctx "ctrl+g"
                             {:description "demo" :handler (fn [_])})
      (ui/set-status! extension-ctx :demo "ready")
      (ui/set-widget! extension-ctx :demo ["widget"])
      (let [registries (:registries ((:snapshot service)))]
        (is (contains? (:message-renderers registries) :demo))
        (is (contains? (:tool-renderers registries) "demo_tool"))
        (is (contains? (:shortcuts registries) "ctrl+g"))
        (is (= "ready" (get-in registries [:statuses :demo :value])))
        (is (contains? (:widgets registries) :demo)))
      (let [override-ctx (kernel/plugin-context ctx :test/ui-override)]
        (ui/set-status! override-ctx :demo "override")
        (is (= "override"
               (get-in ((:registries service)) [:statuses :demo :value])))
        (kernel/dispose-plugin! ctx :test/ui-override)
        (is (= "ready"
               (get-in ((:registries service)) [:statuses :demo :value]))))
      (let [state (tui/initial-state ctx {} (:registries service))
            result (promise)
            with-overlay
            (tui/update-state
             ctx state
             {:type :ui-request :kind :select :result result
              :request {:title "Pick"
                        :items [{:label "A" :value :a}
                                {:label "B" :value :b}]}}
             (:registries service))
            moved (tui/handle-key ctx with-overlay :down nil)
            selected (tui/handle-key ctx moved :enter nil)]
        (is (nil? (:overlay selected)))
        (is (= :b (deref result 100 :timeout))))
      (let [state (tui/initial-state ctx {} (:registries service))
            result (promise)
            with-overlay
            (tui/update-state
             ctx state
             {:type :ui-request :kind :custom :result result
              :request {:title "Counter" :model 0
                        :view (fn [model] [(str "Count " model)])
                        :update (fn [model {:keys [key]}]
                                  (if (= key :enter)
                                    {:model model :done? true :value model}
                                    {:model (inc model)}))}}
             (:registries service))
            incremented (tui/handle-key ctx with-overlay :right nil)
            selected (tui/handle-key ctx incremented :enter nil)]
        (is (nil? (:overlay selected)))
        (is (= 1 (deref result 100 :timeout))))
      (kernel/dispose-plugin! ctx :test/ui-extension)
      (let [registries (:registries ((:snapshot service)))]
        (is (empty? (:message-renderers registries)))
        (is (empty? (:tool-renderers registries)))
        (is (empty? (:shortcuts registries)))
        (is (empty? (:statuses registries)))
        (is (empty? (:widgets registries))))
      (finally (kernel/dispose-all! ctx)))))

(deftest model-rendering-and-live-tool-end-are-independent
  (let [ctx (plugin/boot!
             {:plugins
              [{:ns 'agent.plugins.session}
               {:ns 'agent.plugins.mock
                :config
                {:responses
                 [{:message
                   {:role "assistant"
                    :tool_calls
                    [{:id "render-1" :type "function"
                      :function {:name "dual_render"
                                 :arguments "{\"value\":42}"}}]}
                   :finish-reason "tool_calls"}
                  {:message {:role "assistant" :content "done"}
                   :finish-reason "stop"}]}}
               {:ns 'agent.plugins.runtime}]})
        extension-ctx (kernel/plugin-context ctx :test/dual-render)
        ended (atom [])]
    (try
      (kernel/register-tool!
       extension-ctx
       {:name "dual_render"
        :description "dual renderer test"
        :parameters {:type "object" :required ["value"]
                     :properties {"value" {:type "integer"}}
                     :additionalProperties false}
        :execute (fn [{:keys [value]} _] {:value value})
        :render-model (fn [_ value] (str "model:" (:value value)))
        :render-tui (fn [_ _] ["visual-only"])})
      (kernel/on! extension-ctx :tool.execution/end
                  (fn [_ event] (swap! ended conj event)))
      ((kernel/require-service ctx :agent/run) "go")
      (is (= "model:42"
             (:content (last (filter #(= "tool" (:role %))
                                     ((:messages
                                       (kernel/require-service
                                        ctx :session/store))))))))
      (is (= {:value 42} (:value (first @ended))))
      (is (:ok (first @ended)))
      (finally (kernel/dispose-all! ctx)))))

(deftest approval-can-use-a-tui-prompt-service
  (let [ctx (kernel/create-context)
        prompt-ctx (kernel/plugin-context ctx :test/prompt)
        requests (atom [])]
    (try
      (kernel/register-service!
       prompt-ctx :ui/prompt
       {:select! (fn [request]
                   (swap! requests conj request)
                   :allow-session)})
      (plugin/load-plugin! ctx {:ns 'agent.plugins.approval
                                :config {:mode :ask}})
      (let [approve (kernel/require-service ctx :approval/request)]
        (is (= :allow (approve {:tool "write" :arguments {:path "a"}})))
        (is (= 1 (count @requests)))
        ;; The session grant is cached and does not reopen the overlay.
        (is (= :allow (approve {:tool "write" :arguments {:path "a"}})))
        (is (= 1 (count @requests))))
      (finally (kernel/dispose-all! ctx)))))

(deftest schema-boundary-validation
  (let [tool-schema {:type "object"
                     :required ["operation" "a"]
                     :properties {"operation" {:type "string"
                                                :enum ["add"]}
                                  "a" {:type "number"}}
                     :additionalProperties false}]
    (is (empty? (schema/errors tool-schema
                               {:operation "add" :a 2})))
    (is (= #{"$.a is required"
             "$.extra is not allowed"
             "$.operation must be one of [\"add\"]"}
           (set (schema/errors tool-schema
                               {:operation "delete" :extra true}))))))

(deftest babashka-repl-backend-is-persistent
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "bb-agent-repl-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        ctx (plugin/boot!
             {:plugins
              [{:ns 'agent.plugins.bb-repl
                :config {:root (str directory) :sandbox :none
                         :timeout-ms 5000}}
               {:ns 'agent.plugins.clojure-repl}]})]
    (try
      (let [repl (kernel/require-service ctx :execution/repl)
            define-result ((:eval! repl) "(def answer 41)")
            use-result ((:eval! repl)
                        "(do (println \"from-bb\") (inc answer))")
            tool (kernel/tool ctx "bb_repl")]
        (is (:ok define-result))
        (is (= "42" (:value use-result)))
        (is (= "from-bb\n" (:stdout use-result)))
        (is (= :babashka (:backend repl)))
        (is (= "bb_repl" (:name tool)))
        (is (empty? (schema/errors (:output-schema tool) use-result))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest seatbelt-repl-denies-workspace-writes-and-outside-reads
  (when (= "Mac OS X" (System/getProperty "os.name"))
    (let [root (.getCanonicalFile (java.io.File. "."))
          outside (java.io.File/createTempFile
                   "bb-agent-secret-" ".txt" (.getParentFile root))
          denied-name (str "sandbox-denied-" (random-uuid) ".txt")
          denied-file (java.io.File. root denied-name)
          writable-name (str ".bb-agent-repl-test-" (random-uuid))
          writable-file (java.io.File. root writable-name)]
      (try
        (spit outside "must-not-be-readable")
        (let [ctx (plugin/boot!
                   {:plugins
                    [{:ns 'agent.plugins.bb-repl
                      :config {:root "."
                               :sandbox :seatbelt
                               :writable-dir writable-name
                               :timeout-ms 5000}}]})]
          (try
            (let [repl (kernel/require-service ctx :execution/repl)
                  write-result ((:eval! repl)
                                (str "(spit " (pr-str denied-name)
                                     " \"blocked\")"))
                  read-result ((:eval! repl)
                               (str "(slurp " (pr-str (str outside)) ")"))]
              (is (= :seatbelt (:sandbox repl)))
              (is (false? (:ok write-result)))
              (is (false? (.exists denied-file)))
              (is (false? (:ok read-result)))
              (is (not (.contains (str read-result)
                                  "must-not-be-readable"))))
            (finally
              (kernel/dispose-all! ctx))))
        (finally
          (.delete outside)
          (when (.exists denied-file) (.delete denied-file))
          (delete-tree! writable-file))))))

(deftest project-trust-and-approval-gate
  (testing "untrusted projects fail before approval"
    (let [ctx (plugin/boot!
               {:plugins
                [{:ns 'agent.plugins.trust
                  :config {:trusted false}}
                 {:ns 'agent.plugins.approval
                  :config {:mode :allow}}
                 {:ns 'agent.plugins.policy
                  :config {:trusted-tools ["danger"]
                           :approval-tools ["danger"]}}]})]
      (try
        (let [result (kernel/waterfall
                      ctx :tool/pre-execute
                      {:execution {:name "danger" :arguments {}}}
                      #(assoc % :decision :allow))]
          (is (= :deny (:decision result)))
          (is (= (str "Tool requires a trusted project; "
                      "use /trust allow to enable it.")
                 (:reason result))))
        (finally (kernel/dispose-all! ctx)))))
  (testing "a configured deny approval is audited and enforced"
    (let [ctx (plugin/boot!
               {:plugins
                [{:ns 'agent.plugins.session}
                 {:ns 'agent.plugins.trust
                  :config {:trusted true}}
                 {:ns 'agent.plugins.approval
                  :config {:mode :deny}}
                 {:ns 'agent.plugins.policy
                  :config {:approval-tools ["danger"]}}]})]
      (try
        (let [result (kernel/waterfall
                      ctx :tool/pre-execute
                      {:execution {:name "danger"
                                   :token "execution-1"
                                   :arguments {:value 1}}}
                      #(assoc % :decision :allow))
              events ((:events (kernel/require-service ctx :session/store)))]
          (is (= :deny (:decision result)))
          (is (some #(= "approval/decision" (:type %)) events)))
        (finally (kernel/dispose-all! ctx))))))

(deftest cancellation-closes-a-blocked-stream
  (let [token (cancellation/create-token)
        input (java.io.PipedInputStream.)
        output (java.io.PipedOutputStream. input)
        task (future
               (try
                 (streaming/consume-sse! input token (fn [_]))
                 :completed
                 (catch Throwable error (ex-data error))))]
    (try
      (.write output (.getBytes "data: {\"value\":1}\n" "UTF-8"))
      (.flush output)
      (Thread/sleep 25)
      (is (true? (cancellation/cancel! token)))
      (is (= {:cancelled true} (deref task 1000 :timeout)))
      (finally
        (.close output)
        (.close input)))))

(deftest console-trace-shows-tool-process
  (let [ctx (plugin/boot!
             {:plugins
              [{:ns 'agent.plugins.trace
                :config {:enabled true :show-results true}}]})
        output (java.io.StringWriter.)]
    (try
      (binding [*err* output]
        (kernel/emit! ctx :session/event
                      {:type "tool/call"
                       :data {:name "bb_repl"
                              :arguments {:code "(+ 20 22)"}}})
        (kernel/emit! ctx :session/event
                      {:type "tool/result"
                       :data {:name "bb_repl"
                              :ok true
                              :content "value:\n42"}}))
      (let [text (str output)]
        (is (.contains text "→ tool bb_repl"))
        (is (.contains text "(+ 20 22)"))
        (is (.contains text "← tool bb_repl ok"))
        (is (.contains text "value:\n42")))
      (finally
        (kernel/dispose-all! ctx)))))

(defn- tool-loop-config [policy]
  {:plugins
   [{:ns 'agent.plugins.session}
    {:ns 'agent.plugins.mock
     :config
     {:responses
      [{:message
        {:role "assistant"
         :content nil
         :tool_calls
         [{:id "call-1"
           :type "function"
           :function {:name "calculate"
                      :arguments "{\"operation\":\"add\",\"a\":2,\"b\":3}"}}]}
        :finish-reason "tool_calls"
        :usage {:total_tokens 10}}
       {:message {:role "assistant" :content "The result is 5."}
        :finish-reason "stop"
        :usage {:total_tokens 4}}]}}
    {:ns 'example.math}
    {:ns 'agent.plugins.policy :config policy}
    {:ns 'agent.plugins.runtime
     :config {:system-prompt "test" :max-steps 3}}]})

(deftest offline-tool-calling-loop
  (let [ctx (plugin/boot! (tool-loop-config {}))]
    (try
      (let [result ((kernel/require-service ctx :agent/run) "Add two and three")
            role-sequence (mapv :role (:messages result))
            tool-message (first (filter #(= "tool" (:role %))
                                        (:messages result)))
            events ((:events (kernel/require-service ctx :session/store)))
            call-event (first (filter #(= "tool/call" (:type %)) events))
            result-event (first (filter #(= "tool/result" (:type %)) events))]
        (is (= "The result is 5." (:content result)))
        (is (= 2 (:steps result)))
        (is (= 14 (get-in result [:usage :total_tokens])))
        (is (= ["user" "assistant" "tool" "assistant"] role-sequence))
        (is (= {:result 5}
               (json/parse-string (:content tool-message) true)))
        (is (= {:operation "add" :a 2 :b 3}
               (get-in call-event [:data :arguments])))
        (is (= "{\"result\":5}" (get-in result-event [:data :content])))
        (is (contains? (:data result-event) :details))
        (is (nat-int? (get-in result-event [:data :duration-ms]))))
      (finally
        (kernel/dispose-all! ctx)))
    (is (empty? (kernel/loaded-plugins ctx)))
    (is (empty? (kernel/service-keys ctx)))))

(deftest runtime-retries-transient-transport-errors-only
  (testing "a transient TLS/IO failure is retried by the provider-neutral loop"
    (let [calls (atom 0)
          retries (atom [])
          generate (fn [_]
                     (if (= 1 (swap! calls inc))
                       (throw (java.io.IOException.
                               "Remote host terminated the handshake"))
                       {:message {:role "assistant" :content "recovered"}
                        :finish-reason "stop"}))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'agent.plugins.session}
                 {:ns 'agent.plugins.mock :config {:generate generate}}
                 {:ns 'agent.plugins.runtime
                  :config {:max-retries 2 :retry-delay-ms 1}}]})
          observer (kernel/plugin-context ctx :test/retry-observer)]
      (try
        (kernel/on! observer :agent/retry
                    (fn [_ event] (swap! retries conj event)))
        (is (= "recovered"
               (:content ((kernel/require-service ctx :agent/run) "hello"))))
        (is (= 2 @calls))
        (is (= :provider-error (:reason (first @retries))))
        (finally (kernel/dispose-all! ctx)))))

  (testing "a permanent client error is not retried"
    (let [calls (atom 0)
          generate (fn [_]
                     (swap! calls inc)
                     (throw (ex-info "bad request" {:status 400})))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'agent.plugins.session}
                 {:ns 'agent.plugins.mock :config {:generate generate}}
                 {:ns 'agent.plugins.runtime
                  :config {:max-retries 2 :retry-delay-ms 1}}]})]
      (try
        (is (= "bad request"
               (try
                 ((kernel/require-service ctx :agent/run) "hello")
                 nil
                 (catch Throwable error (ex-message error)))))
        (is (= 1 @calls))
        (finally (kernel/dispose-all! ctx))))))

(deftest policy-can-deny-without-changing-the-loop
  (let [ctx (plugin/boot! (tool-loop-config {:deny-tools ["calculate"]}))]
    (try
      (let [result ((kernel/require-service ctx :agent/run) "Add two and three")
            tool-message (first (filter #(= "tool" (:role %))
                                        (:messages result)))]
        (is (= "The result is 5." (:content result)))
        (is (.startsWith (:content tool-message) "ERROR: Denied")))
      (finally
        (kernel/dispose-all! ctx)))))

(deftest openai-compatible-request-shape
  (let [captured (atom nil)]
    (with-redefs [http/post
                  (fn [url options]
                    (reset! captured [url options])
                    {:status 200
                     :body (json/generate-string
                            {:model "demo-model"
                             :choices [{:finish_reason "stop"
                                        :message {:role "assistant"
                                                  :content "ok"}}]
                             :usage {:total_tokens 3}})})]
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'agent.plugins.openai
                    :config {:base-url "https://llm.example/v1/"
                             :model "demo-model"
                             :api-key "test-key"}}]})]
        (try
          (let [response ((kernel/require-service ctx :llm/generate)
                          {:system-prompt "system"
                           :messages
                           [{:role "user"
                             :content [{:type :text :text "hello"}
                                       {:type :image
                                        :url "data:image/png;base64,AA=="
                                        :detail "low"}]}]
                           :tools [{:type "function"
                                    :function {:name "demo"
                                               :description "demo"
                                               :parameters {:type "object"}}}]})
                [url options] @captured
                body (json/parse-string (:body options) true)]
            (is (= "ok" (get-in response [:message :content])))
            (is (= "https://llm.example/v1/chat/completions" url))
            (is (= "Bearer test-key"
                   (get-in options [:headers "authorization"])))
            (is (= "system" (get-in body [:messages 0 :role])))
            (is (= "user" (get-in body [:messages 1 :role])))
            (is (= "text" (get-in body [:messages 1 :content 0 :type])))
            (is (= "image_url"
                   (get-in body [:messages 1 :content 1 :type])))
            (is (= "data:image/png;base64,AA=="
                   (get-in body [:messages 1 :content 1 :image_url :url])))
            (is (= "auto" (:tool_choice body)))
            (is (true? (:stream body))))
          (finally
            (kernel/dispose-all! ctx)))))))

(defn- completed-event [response]
  (str (apply str
              (map-indexed
               (fn [index item]
                 (str (when (= "message" (:type item))
                        (apply str
                               (for [content (:content item)
                                     :when (= "output_text" (:type content))]
                                 (str "event: response.output_text.delta\n"
                                      "data: "
                                      (json/generate-string
                                       {:type "response.output_text.delta"
                                        :delta (:text content)})
                                      "\n\n"))))
                      "event: response.output_item.done\n"
                      "data: "
                      (json/generate-string
                       {:type "response.output_item.done"
                        :output_index index
                        :item item})
                      "\n\n"))
               (:output response)))
       "event: response.completed\n"
       "data: " (json/generate-string
                  {:type "response.completed"
                   ;; ChatGPT's subscription stream currently supplies the
                   ;; completed items in output_item.done events.
                   :response (assoc response :output [])})
       "\n\n"))

(deftest chatgpt-subscription-request-and-replay
  (let [auth-file (java.io.File/createTempFile "bb-agent-auth-" ".json")
        captured (atom [])
        stream-events (atom [])
        responses (atom
                   [{:id "resp-tool"
                     :status "completed"
                     :model "gpt-5.6-sol"
                     :output
                     [{:id "reason-1"
                       :type "reasoning"
                       :encrypted_content "opaque"
                       :summary []}
                      {:id "fc-1"
                       :type "function_call"
                       :call_id "call-1"
                       :name "demo"
                       :arguments "{\"value\":1}"}]
                     :usage {:input_tokens 10
                             :output_tokens 4
                             :total_tokens 14}}
                    {:id "resp-final"
                     :status "completed"
                     :model "gpt-5.6-sol"
                     :output
                     [{:id "msg-1"
                       :type "message"
                       :role "assistant"
                       :content [{:type "output_text" :text "done"}]}]
                     :usage {:input_tokens 18
                             :output_tokens 3
                             :total_tokens 21}}])]
    (try
      (spit auth-file
            (json/generate-string
             {:auth_mode "chatgpt"
              :tokens {:access_token "secret-token"
                       :account_id "account-1"
                       :refresh_token "must-not-leak"}}))
      (with-redefs
       [http/post
        (fn [url options]
          (swap! captured conj [url options])
          (let [response (first @responses)]
            (swap! responses subvec 1)
            {:status 200 :body (completed-event response)}))]
        (let [ctx (plugin/boot!
                   {:plugins
                    [{:ns 'agent.plugins.chatgpt
                      :config {:model "gpt-5.6-sol"
                               :auth-file (str auth-file)
                               :check-permissions false}}]})]
          (try
            (kernel/on! (kernel/plugin-context ctx :test/stream-observer)
                        :llm/stream
                        (fn [_ event] (swap! stream-events conj event)))
            (let [generate (kernel/require-service ctx :llm/generate)
                  first-response
                  (generate
                   {:system-prompt "system"
                    :messages
                    [{:role "user"
                      :content [{:type :text :text "hello"}
                                {:type :image
                                 :url "data:image/png;base64,AA=="
                                 :detail "low"}]}]
                    :tools [{:type "function"
                             :function {:name "demo"
                                        :description "demo"
                                        :parameters {:type "object"}}}]})
                  assistant (:message first-response)
                  final-response
                  (generate
                   {:system-prompt "system"
                    :messages [{:role "user" :content "hello"}
                               assistant
                               {:role "tool"
                                :tool_call_id "call-1"
                                :content "{\"ok\":true}"}]
                    :tools []})
                  [[url first-options] [_ second-options]] @captured
                  first-body (json/parse-string (:body first-options) true)
                  second-body (json/parse-string (:body second-options) true)]
              (is (= "https://chatgpt.com/backend-api/codex/responses" url))
              (is (= "Bearer secret-token"
                     (get-in first-options [:headers "authorization"])))
              (is (= "account-1"
                     (get-in first-options
                             [:headers "chatgpt-account-id"])))
              (is (= :stream (:as first-options)))
              (is (true? (:stream first-body)))
              (is (false? (:store first-body)))
              (is (= "demo" (get-in first-body [:tools 0 :name])))
              (is (nil? (get-in first-body [:tools 0 :function])))
              (is (= "input_text"
                     (get-in first-body [:input 0 :content 0 :type])))
              (is (= "input_image"
                     (get-in first-body [:input 0 :content 1 :type])))
              (is (= "data:image/png;base64,AA=="
                     (get-in first-body [:input 0 :content 1 :image_url])))
              (is (= "tool_calls" (:finish-reason first-response)))
              (is (= "call-1" (get-in assistant [:tool_calls 0 :id])))
              (is (= "reasoning" (get-in second-body [:input 1 :type])))
              (is (= "function_call"
                     (get-in second-body [:input 2 :type])))
              (is (= "function_call_output"
                     (get-in second-body [:input 3 :type])))
              (is (= "done" (get-in final-response [:message :content])))
              (is (= "stop" (:finish-reason final-response)))
              (is (= ["done"]
                     (->> @stream-events
                          (filter #(= :text/delta (:type %)))
                          (mapv :delta)))))
            (finally
              (kernel/dispose-all! ctx)))))
      (finally
        (.delete auth-file)))))

(deftest chatgpt-transport-retries-with-a-fresh-http1-client
  (let [auth-file (java.io.File/createTempFile "bb-agent-auth-" ".json")
        client-options (atom [])
        requests (atom [])
        response {:id "resp-recovered"
                  :status "completed"
                  :model "gpt-5.6-sol"
                  :output [{:id "msg-recovered"
                            :type "message"
                            :role "assistant"
                            :content [{:type "output_text"
                                       :text "recovered"}]}]}]
    (try
      (spit auth-file
            (json/generate-string
             {:auth_mode "chatgpt"
              :tokens {:access_token "secret-token"
                       :account_id "account-1"}}))
      (with-redefs
       [http/client
        (fn [options]
          (swap! client-options conj options)
          {:test-client (count @client-options)})
        http/post
        (fn [_ options]
          (swap! requests conj options)
          (if (= 1 (count @requests))
            (throw (java.io.IOException.
                    "Remote host terminated the handshake"))
            {:status 200 :body (completed-event response)}))]
        (let [ctx (plugin/boot!
                   {:plugins
                    [{:ns 'agent.plugins.chatgpt
                      :config {:model "gpt-5.6-sol"
                               :auth-file (str auth-file)
                               :check-permissions false
                               :transport-retries 1
                               :retry-delay-ms 1}}]})]
          (try
            (is (= "recovered"
                   (get-in ((kernel/require-service ctx :llm/generate)
                            {:system-prompt "system"
                             :messages [{:role "user" :content "hello"}]
                             :tools []})
                           [:message :content])))
            (is (= 2 (count @requests)))
            (is (= 2 (count @client-options)))
            (is (every? #(= :http1.1 (:version %)) @client-options))
            (is (every? #(= :http1.1 (:version %)) @requests))
            (is (not= (:client (first @requests))
                      (:client (second @requests))))
            (finally
              (kernel/dispose-all! ctx)))))
      (finally
        (.delete auth-file)))))

(deftest session-recovers-compacts-forks-and-clears-append-only
  (let [source (java.io.File/createTempFile "bb-agent-session-" ".jsonl")
        destination (java.io.File/createTempFile "bb-agent-fork-" ".jsonl")]
    (.delete destination)
    (try
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'agent.plugins.session
                    :config {:path (str source)
                             :retain-messages 2}}]})]
        (try
          (let [store (kernel/require-service ctx :session/store)]
            (doseq [index (range 5)]
              ((:append! store) "message"
               {:message {:role (if (even? index) "user" "assistant")
                          :content (str "message-" index)}}))
            (let [compaction ((:compact! store))
                  fork ((:fork! store) (str destination))]
              (is (true? (:compacted compaction)))
              (is (= 3 (count ((:messages store)))))
              (is (= "system" (:role (first ((:messages store))))))
              (is (.isFile destination))
              (is (not= (:session-id store) (:session-id fork)))
              (is (thrown? clojure.lang.ExceptionInfo
                           ((:fork! store) (str destination))))))
          (finally (kernel/dispose-all! ctx))))

      (spit source "{\"truncated\"\n" :append true)
      (let [ctx (plugin/boot!
                 {:plugins [{:ns 'agent.plugins.session
                             :config {:path (str source)}}]})]
        (try
          (let [store (kernel/require-service ctx :session/store)
                size-before (.length source)]
            (is (= 1 (count ((:diagnostics store)))))
            (is (= 3 (count ((:messages store)))))
            ((:clear! store))
            (is (empty? ((:messages store))))
            (is (> (.length source) size-before)))
          (finally (kernel/dispose-all! ctx))))

      (let [ctx (plugin/boot!
                 {:plugins [{:ns 'agent.plugins.session
                             :config {:path (str destination)}}]})]
        (try
          (let [store (kernel/require-service ctx :session/store)]
            (is (= 3 (count ((:messages store)))))
            (is (empty? ((:diagnostics store)))))
          (finally (kernel/dispose-all! ctx))))
      (finally
        (.delete source)
        (.delete destination)))))

(defn- tool-call [id name arguments]
  {:id id :type "function"
   :function {:name name :arguments (json/generate-string arguments)}})

(defn- subagent-test-context
  ([generate] (subagent-test-context generate #{}))
  ([generate allowed-tools]
   (plugin/boot!
    {:plugins
     [{:ns 'agent.plugins.session}
      {:ns 'agent.plugins.subagent}
      {:ns 'agent.plugins.subagent-in-process
       :config
       {:allowed-tools allowed-tools
        :child-profile
        {:plugins
         [{:ns 'agent.plugins.session}
          {:ns 'agent.plugins.mock :config {:generate generate}}
          {:ns 'example.math}
          {:ns 'agent.plugins.runtime :config {:max-steps 3}}]}}}
      {:ns 'agent.plugins.subagent-tools}]})))

(deftest subagent-providers-are-isolated-capability-checked-and-structured
  (let [request-seen (promise)
        ctx (subagent-test-context
             (fn [request]
               (deliver request-seen request)
               {:message {:role "assistant" :content "{\"answer\":42}"}
                :finish-reason "stop"})
             #{"calculate"})]
    (try
      (let [runtime (kernel/require-service ctx :subagents/runtime)
            delegate (kernel/tool ctx "delegate_task")
            result ((:execute delegate)
                    {:prompt "Return the answer"
                     :persona "You are a terse verifier."
                     :tool_filter ["calculate"]
                     :output_schema
                     {:type "object"
                      :required ["answer"]
                      :properties {"answer" {:type "integer"}}
                      :additionalProperties false}}
                    {:cancel-token (cancellation/create-token)})
            request (deref request-seen 1000 :timeout)]
        (is (= :completed (:stop-reason result)))
        (is (= {:answer 42} (:structured result)))
        (is (str/includes? (:system-prompt request) "terse verifier"))
        (is (= ["calculate"]
               (mapv #(get-in % [:function :name]) (:tools request))))
        (is (empty? ((:jobs runtime))))
        (is (= #{:spawn :fork}
               (set (map :id ((:providers runtime))))))
        (is (thrown-with-msg?
             clojure.lang.ExceptionInfo
             #"not registered"
             ((:start! runtime) {:provider :missing :prompt "x"})))
        (is (thrown-with-msg?
             clojure.lang.ExceptionInfo
             #"depth limit"
             ((:start! runtime) {:provider :spawn :prompt "x"
                                 :parent-depth 1}))))
      (finally (kernel/dispose-all! ctx)))))

(deftest fork-agent-seeds-only-completed-parent-turns
  (let [request-seen (promise)
        ctx (subagent-test-context
             (fn [request]
               (deliver request-seen request)
               {:message {:role "assistant" :content "forked"}
                :finish-reason "stop"}))]
    (try
      (let [store (kernel/require-service ctx :session/store)]
        ((:append! store) "message"
         {:message {:role "user" :content "completed user"}})
        ((:append! store) "message"
         {:message {:role "assistant" :content "completed assistant"}})
        ((:append! store) "step/end" {:step 1 :tool-count 0})
        ((:append! store) "session/compaction"
         {:original_message_count 2
          :retained_message_count 1
          :replacement_messages
          [{:role "system" :content "completed summary"}]})
        ((:append! store) "message"
         {:message {:role "user" :content "open user"}})
        ((:append! store) "step/start" {:step 2})
        (let [fork (kernel/tool ctx "fork_agent")
              result ((:execute fork) {:prompt "child prompt"}
                      {:cancel-token (cancellation/create-token)})
              request (deref request-seen 1000 :timeout)
              contents (mapv :content (:messages request))]
          (is (= :completed (:stop-reason result)))
          (is (= ["completed summary" "child prompt"]
                 contents))
          (is (not-any? #{"open user"} contents))))
      (finally (kernel/dispose-all! ctx)))))

(deftest background-subagent-can-be-listed-interrupted-and-collected
  (let [started (promise)
        ctx (subagent-test-context
             (fn [{:keys [cancel-token]}]
               (deliver started true)
               (loop []
                 (cancellation/throw-if-cancelled! cancel-token)
                 (Thread/sleep 10)
                 (recur))))]
    (try
      (let [delegate (kernel/tool ctx "delegate_task")
            list-agents (kernel/tool ctx "list_agents")
            interrupt (kernel/tool ctx "interrupt_agent")
            wait-agent (kernel/tool ctx "wait_agent")
            job ((:execute delegate)
                 {:prompt "keep working" :run_in_background true}
                 {:cancel-token (cancellation/create-token)})
            run-id (:id job)]
        (is (= true (deref started 1000 :timeout)))
        (is (= [run-id]
               (mapv :id (:agents ((:execute list-agents) {} {})))))
        (is (true? (:interrupted
                    ((:execute interrupt) {:id run-id} {}))))
        (is (= :aborted
               (:stop-reason
                ((:execute wait-agent) {:id run-id :timeout_ms 1000} {}))))
        (is (empty? (:agents ((:execute list-agents) {} {})))))
      (finally (kernel/dispose-all! ctx)))))

(deftest controllable-agent-session-steers-follows-up-and-aborts
  (testing "steering enters before the next model request and follow-up waits"
    (let [started (promise)
          release (promise)
          requests (atom [])
          calls (atom 0)
          generate
          (fn [request]
            (swap! requests conj request)
            (case (swap! calls inc)
              1 (do
                  (deliver started true)
                  @release
                  {:message {:role "assistant" :content nil
                             :tool_calls
                             [(tool-call "control-call" "calculate"
                                         {:operation "add" :a 1 :b 1})]}
                   :finish-reason "tool_calls"})
              2 {:message {:role "assistant" :content "first stop"}
                 :finish-reason "stop"}
              3 {:message {:role "assistant" :content "after follow-up"}
                 :finish-reason "stop"}))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'agent.plugins.session}
                 {:ns 'agent.plugins.mock :config {:generate generate}}
                 {:ns 'example.math}
                 {:ns 'agent.plugins.runtime :config {:max-steps 5}}]})]
      (try
        (let [session (kernel/require-service ctx :agent/session)
              {:keys [result]} ((:submit! session) "start")]
          (is (= true (deref started 1000 :timeout)))
          ((:steer! session) "steer now")
          ((:follow-up! session) "do this later")
          (deliver release true)
          (let [{:keys [ok value]} (deref result 2000 :timeout)
                second-messages (:messages (second @requests))
                third-messages (:messages (nth @requests 2))]
            (is ok)
            (is (= "after follow-up" (:content value)))
            (is (some #(= "steer now" (:content %)) second-messages))
            (is (not-any? #(= "do this later" (:content %))
                          second-messages))
            (is (some #(= "do this later" (:content %)) third-messages))
            (is (= :idle (:phase ((:state session)))))
            (is (thrown-with-msg?
                 clojure.lang.ExceptionInfo
                 #"accepting queued messages"
                 ((:follow-up! session) "too late")))))
        (finally (kernel/dispose-all! ctx)))))

  (testing "abort releases a cooperative blocked provider and records no final"
    (let [started (promise)
          ctx (plugin/boot!
               {:plugins
                [{:ns 'agent.plugins.session}
                 {:ns 'agent.plugins.mock
                  :config
                  {:generate
                   (fn [{:keys [cancel-token]}]
                     (deliver started true)
                     (loop []
                       (cancellation/throw-if-cancelled! cancel-token)
                       (Thread/sleep 10)
                       (recur)))}}
                 {:ns 'agent.plugins.runtime}]})]
      (try
        (let [session (kernel/require-service ctx :agent/session)
              store (kernel/require-service ctx :session/store)
              {:keys [result]} ((:submit! session) "block")
              before (System/nanoTime)]
          (is (= true (deref started 1000 :timeout)))
          (kernel/emit! ctx :llm/stream {:type :text/delta :delta "working"})
          (kernel/emit! ctx :llm/stream {:type :reasoning/delta
                                         :delta "thinking"})
          (is (= "working" (:partial-assistant ((:state session)))))
          (is (= "thinking" (:partial-reasoning ((:state session)))))
          ((:follow-up! session) "must be discarded")
          (is (true? ((:abort! session))))
          (let [{:keys [ok error]} (deref result 1000 :timeout)
                elapsed-ms (/ (- (System/nanoTime) before) 1000000.0)
                events ((:events store))]
            (is (false? ok))
            (is (:cancelled (ex-data error)))
            (is (< elapsed-ms 1000))
            (is (some #(= "agent/aborted" (:type %)) events))
            (is (some #(= "queue/discarded" (:type %)) events))
            (is (= 1 (count ((:messages store)))))))
        (finally (kernel/dispose-all! ctx))))))

(defn- batch-config [tool-calls]
  {:plugins
   [{:ns 'agent.plugins.session}
    {:ns 'agent.plugins.mock
     :config {:responses
              [{:message {:role "assistant" :content nil
                          :tool_calls tool-calls}
                :finish-reason "tool_calls"}
               {:message {:role "assistant" :content "done"}
                :finish-reason "stop"}]}}
    {:ns 'agent.plugins.runtime :config {:max-steps 3}}]})

(defn- delay-tool [name execution-mode delay-ms completed]
  (cond->
   {:name name
    :description name
    :parameters {:type "object" :additionalProperties false}
    :execute (fn [_ _]
               (Thread/sleep delay-ms)
               (swap! completed conj name)
               {:name name})}
    execution-mode (assoc :execution-mode execution-mode)))

(deftest deterministic-parallel-tool-batches
  (let [calls [(tool-call "slow-a" "slow_a" {})
               (tool-call "slow-b" "slow_b" {})]
        completed (atom [])
        ctx (plugin/boot! (batch-config calls))]
    (try
      (let [tool-ctx (kernel/plugin-context ctx :test/delay-tools)]
        (kernel/register-tool! tool-ctx (delay-tool "slow_a" nil 200 completed))
        (kernel/register-tool! tool-ctx (delay-tool "slow_b" nil 200 completed))
        (let [started (System/nanoTime)
              result ((kernel/require-service ctx :agent/run) "parallel")
              elapsed-ms (/ (- (System/nanoTime) started) 1000000.0)
              tool-messages (filterv #(= "tool" (:role %))
                                     (:messages result))]
          (is (< elapsed-ms 350))
          (is (= ["slow-a" "slow-b"]
                 (mapv :tool_call_id tool-messages)))
          (is (= #{"slow_a" "slow_b"} (set @completed)))))
      (finally (kernel/dispose-all! ctx))))

  (let [calls [(tool-call "ordered-a" "ordered_a" {})
               (tool-call "ordered-b" "ordered_b" {})]
        completed (atom [])
        ctx (plugin/boot! (batch-config calls))]
    (try
      (let [tool-ctx (kernel/plugin-context ctx :test/ordered-tools)]
        (kernel/register-tool! tool-ctx
                               (delay-tool "ordered_a" :sequential 200 completed))
        (kernel/register-tool! tool-ctx (delay-tool "ordered_b" nil 200 completed))
        (let [started (System/nanoTime)]
          ((kernel/require-service ctx :agent/run) "sequential")
          (is (>= (/ (- (System/nanoTime) started) 1000000.0) 350))
          (is (= ["ordered_a" "ordered_b"] @completed))))
      (finally (kernel/dispose-all! ctx)))))

(defn- delete-tree! [directory]
  (let [root (.toPath (io/file directory))]
    (when (java.nio.file.Files/exists
           root (make-array java.nio.file.LinkOption 0))
      (with-open [paths (java.nio.file.Files/walk
                         root
                         (make-array java.nio.file.FileVisitOption 0))]
        (doseq [path (reverse (vec (iterator-seq (.iterator paths))))]
          (java.nio.file.Files/deleteIfExists path))))))

(deftest execution-world-contract-and-coding-tools
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "bb-agent-world-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        outside (java.io.File/createTempFile "bb-agent-outside-" ".txt")]
    (try
      (spit (io/file directory "sample.txt") "alpha\nbeta\n")
      (spit outside "secret")
      (java.nio.file.Files/createSymbolicLink
       (.toPath (io/file directory "escape.txt"))
       (.toPath outside)
       (make-array java.nio.file.attribute.FileAttribute 0))
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'agent.plugins.execution-world
                    :config {:root (str directory) :timeout-ms 1000
                             :sandbox :none}}
                   {:ns 'agent.plugins.tools}]})]
        (try
          (let [world (kernel/require-service ctx :execution/world)]
            (is (= #{:fs/read :fs/write :process} (:capabilities world)))
            (is (= "alpha\nbeta\n"
                   (:content ((:read! world) {:path "sample.txt"}))))
            (is (= "pha"
                   (:content ((:read! world) {:path "sample.txt"
                                              :offset 2 :limit 3}))))
            (let [read-tool (kernel/tool ctx "read")
                  first-result ((:execute read-tool)
                                {:path "sample.txt" :offset 1 :limit 1}
                                {})
                  read-result ((:execute read-tool)
                               {:path "sample.txt" :offset 2 :limit 1}
                               {})]
              (is (= "alpha" (:content first-result)))
              (is (= 2 (:total-lines first-result)))
              (is (:truncated first-result))
              (is (= (str "alpha\n\n[Showing lines 1-1 of 2. "
                          "Use offset=2 to continue.]")
                     ((:render read-tool)
                      {:path "sample.txt" :offset 1 :limit 1}
                      first-result)))
              (is (= "beta" (:content read-result)))
              (is (= 1 (:line-count read-result)))
              (is (= 2 (:total-lines read-result)))
              (is (false? (:truncated read-result)))
              (is (= "beta\n\n[Read lines 2-2 of 2.]"
                     ((:render read-tool)
                      {:path "sample.txt" :offset 2 :limit 1}
                      read-result)))
              (is (thrown-with-msg?
                   clojure.lang.ExceptionInfo #"beyond end of file"
                   ((:execute read-tool)
                    {:path "sample.txt" :offset 3 :limit 1} {}))))
            ((:write! world) {:path "created.txt" :content "before"})
            ((:edit! world) {:path "created.txt" :old-text "before"
                             :new-text "after"})
            (is (= "after" (slurp (io/file directory "created.txt"))))
            (is (= #{"created.txt" "escape.txt" "sample.txt"}
                   (set (:items ((:find! world) {:pattern "*.txt"})))))
            (is (= "sample.txt" (get-in ((:search! world)
                                          {:query "beta"})
                                         [:items 0 :path])))
            (is (= 0 (:exit-code ((:spawn! world)
                                   {:command "printf local-world"}))))
            (is (thrown? clojure.lang.ExceptionInfo
                         ((:read! world) {:path (str outside)})))
            (is (thrown? clojure.lang.ExceptionInfo
                         ((:read! world) {:path "escape.txt"})))
            (is (thrown? clojure.lang.ExceptionInfo
                         ((:write! world) {:path "escape.txt"
                                           :content "must-not-write"})))
            (is (= "secret" (slurp outside)))
            (is (every? #(kernel/tool ctx %)
                        ["read" "write" "edit" "bash" "grep" "find" "ls"])))
          (finally (kernel/dispose-all! ctx))))
      (finally
        (delete-tree! directory)
        (.delete outside)))))

(deftest unsupported-platform-keeps-safe-agent-tools-available
  (is (= :unavailable
         (sandbox/resolve-mode
          :auto {:os-name "Linux" :seatbelt-executable? false})))
  (is (= :none
         (sandbox/resolve-mode
          :none {:os-name "Linux" :seatbelt-executable? false})))
  (is (thrown-with-msg?
       clojure.lang.ExceptionInfo #"requires macOS"
       (sandbox/resolve-mode
        :seatbelt {:os-name "Linux" :seatbelt-executable? false})))
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "bb-agent-safe-degrade-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        ctx (plugin/boot!
             {:plugins
              [{:ns 'agent.plugins.execution-world
                :config {:root (str directory) :sandbox :unavailable}}
               {:ns 'agent.plugins.tools}
               {:ns 'agent.plugins.bb-repl
                :config {:root (str directory) :sandbox :unavailable}}
               {:ns 'agent.plugins.clojure-repl}]})]
    (try
      (let [names (set (map :name (kernel/tools ctx)))
            world (kernel/require-service ctx :execution/world)
            repl (kernel/require-service ctx :execution/repl)]
        (is (every? names ["read" "write" "edit" "grep" "find" "ls"]))
        (is (not (contains? names "bash")))
        (is (not (contains? names "bb_repl")))
        (is (= #{:fs/read :fs/write} (:capabilities world)))
        (is (false? (:available? repl))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest seatbelt-execution-world-denies-outside-user-files
  (when (= "Mac OS X" (System/getProperty "os.name"))
    (let [base (doto (io/file
                      (str ".bb-agent-seatbelt-world-" (random-uuid)))
                 .mkdirs)
          directory (.toFile (java.nio.file.Files/createTempDirectory
                              (.toPath base)
                              "bb-agent-seatbelt-world-"
                              (make-array java.nio.file.attribute.FileAttribute 0)))
          outside (java.io.File/createTempFile
                   "bb-agent-world-secret-" ".txt" base)]
      (try
        (spit outside "must-not-leak")
        (let [ctx (plugin/boot!
                   {:plugins
                    [{:ns 'agent.plugins.execution-world
                      :config {:root (str directory) :sandbox :seatbelt}}]})]
          (try
            (let [world (kernel/require-service ctx :execution/world)
                  denied ((:spawn! world)
                          {:command (str "cat " (pr-str (str outside)))})
                  allowed ((:spawn! world)
                           {:command "printf allowed > inside.txt"})]
              (is (= :seatbelt (:sandbox world)))
              (is (not= 0 (:exit-code denied)))
              (is (not (str/includes? (:stdout denied) "must-not-leak")))
              (is (= 0 (:exit-code allowed)))
              (is (= "allowed" (slurp (io/file directory "inside.txt")))))
            (finally (kernel/dispose-all! ctx))))
        (finally
          (delete-tree! directory)
          (.delete outside)
          (delete-tree! base))))))

(deftest trust-store-inherits-nearest-canonical-parent
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "bb-agent-trust-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        child (io/file directory "child")
        trust-file (io/file directory "trust.edn")]
    (.mkdir child)
    (try
      (spit trust-file (pr-str {:roots {(str directory) :allow
                                        (str child) :deny}}))
      (let [parent-ctx (plugin/boot!
                        {:plugins [{:ns 'agent.plugins.trust
                                    :config {:root (str directory)
                                             :trust-file (str trust-file)}}]})
            child-ctx (plugin/boot!
                       {:plugins [{:ns 'agent.plugins.trust
                                   :config {:root (str child)
                                            :trust-file (str trust-file)}}]})]
        (try
          (is ((:trusted? (kernel/require-service parent-ctx
                                                  :project/trust))))
          (is (not ((:trusted? (kernel/require-service child-ctx
                                                       :project/trust)))))
          (finally
            (kernel/dispose-all! parent-ctx)
            (kernel/dispose-all! child-ctx))))
      (finally (delete-tree! directory)))))

(deftest trust-command-persists-an-explicit-user-decision
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "bb-agent-trust-command-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        trust-file (io/file directory "user" "trust.edn")
        ctx (plugin/boot!
             {:plugins
              [{:ns 'agent.plugins.session}
               {:ns 'agent.plugins.mock :config {:responses []}}
               {:ns 'agent.plugins.runtime}
               {:ns 'agent.plugins.trust
                :config {:root (str directory)
                         :trust-file (str trust-file)}}]})]
    (try
      (let [trust (kernel/require-service ctx :project/trust)]
        (is (= :deny (get-in (command/dispatch! ctx "/trust")
                             [:output :decision])))
        (is (false? ((:trusted? trust))))
        (is (= :allow (get-in (command/dispatch! ctx "/trust allow")
                              [:output :decision])))
        (is ((:trusted? trust)))
        (is (= :allow
               (get-in (edn/read-string (slurp trust-file))
                       [:roots (str (.toPath (.getCanonicalFile directory)))])))
        (is (= :deny (get-in (command/dispatch! ctx "/trust deny")
                             [:output :decision])))
        (is (false? ((:trusted? trust))))
        (is (= "Usage: /trust allow | /trust deny"
               (:error (command/dispatch! ctx "/trust maybe")))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest session-catalog-indexes-metadata-without-following-links
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "bb-agent-catalog-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        outside (.toFile (java.nio.file.Files/createTempDirectory
                          "bb-agent-catalog-outside-"
                          (make-array java.nio.file.attribute.FileAttribute 0)))
        session-file (io/file directory "local.jsonl")]
    (try
      (let [ctx (plugin/boot!
                 {:plugins [{:ns 'agent.plugins.session
                             :config {:path (str session-file)}}]})]
        (try
          (let [store (kernel/require-service ctx :session/store)]
            ((:append! store) "message"
             {:message {:role "user" :content "catalog me"}})
            ((:name! store) "catalog-session")
            ((:label! store) "verified"))
          (finally (kernel/dispose-all! ctx))))
      (spit (io/file outside "outside.jsonl")
            (json/generate-string {:type "session/start"
                                   :data {:session_id "outside"}}))
      (java.nio.file.Files/createSymbolicLink
       (.toPath (io/file directory "escape"))
       (.toPath outside)
       (make-array java.nio.file.attribute.FileAttribute 0))
      (let [ctx (plugin/boot!
                 {:plugins [{:ns 'agent.plugins.session-catalog
                             :config {:directory (str directory)}}]})]
        (try
          (let [entries ((:list (kernel/require-service ctx
                                                        :session/catalog)))]
            (is (= 1 (count entries)))
            (is (= "catalog-session" (:name (first entries))))
            (is (= "verified" (:label (first entries))))
            (is (= 1 (:message-count (first entries))))
            (is (not= "outside" (:session-id (first entries)))))
          (finally (kernel/dispose-all! ctx))))
      (finally
        (delete-tree! directory)
        (delete-tree! outside)))))

(deftest context-manager-compacts-semantically-and-recovers-overflow-once
  (testing "budget compaction uses a semantic summary checkpoint"
    (let [requests (atom [])
          generate
          (fn [request]
            (swap! requests conj request)
            (if (:system-prompt request)
              {:message {:role "assistant"
                         :content "Goal: preserve the task; Pending: continue."}
               :finish-reason "stop"}
              {:message {:role "assistant" :content "done"}
               :finish-reason "stop"}))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'agent.plugins.session}
                 {:ns 'agent.plugins.mock :config {:generate generate}}
                 {:ns 'agent.plugins.context-manager
                  :config {:context-window 120 :reserve-tokens 20
                           :chars-per-token 1.0 :retain-messages 2}}
                 {:ns 'agent.plugins.runtime}]})]
      (try
        (let [result ((kernel/require-service ctx :agent/run)
                      (apply str (repeat 200 "x")))
              events ((:events (kernel/require-service ctx :session/store)))
              runtime-request (last @requests)]
          (is (= "done" (:content result)))
          (is (some #(= "session/compaction" (:type %)) events))
          (is (= "system" (get-in runtime-request [:messages 0 :role])))
          (is (str/includes? (get-in runtime-request [:messages 0 :content])
                             "Goal: preserve")))
        (finally (kernel/dispose-all! ctx)))))

  (testing "provider overflow compacts and retries only once"
    (let [runtime-calls (atom 0)
          generate
          (fn [request]
            (if (:system-prompt request)
              {:message {:role "assistant" :content "compact summary"}
               :finish-reason "stop"}
              (if (= 1 (swap! runtime-calls inc))
                (throw (ex-info "context window exceeded"
                                {:context-overflow true}))
                {:message {:role "assistant" :content "recovered"}
                 :finish-reason "stop"})))
          ctx (plugin/boot!
               {:plugins
                [{:ns 'agent.plugins.session}
                 {:ns 'agent.plugins.mock :config {:generate generate}}
                 {:ns 'agent.plugins.context-manager
                  :config {:context-window 10000 :reserve-tokens 100}}
                 {:ns 'agent.plugins.runtime}]})]
      (try
        (is (= "recovered"
               (:content ((kernel/require-service ctx :agent/run) "hello"))))
        (is (= 2 @runtime-calls))
        (is (some #(= "session/compaction" (:type %))
                  ((:events (kernel/require-service ctx :session/store)))))
        (finally (kernel/dispose-all! ctx))))))

(deftest semantic-compaction-can-be-aborted
  (let [started (promise)
        generate
        (fn [{:keys [system-prompt cancel-token]}]
          (if system-prompt
            (do
              (deliver started true)
              (loop []
                (cancellation/throw-if-cancelled! cancel-token)
                (Thread/sleep 10)
                (recur)))
            {:message {:role "assistant" :content "unexpected"}
             :finish-reason "stop"}))
        ctx (plugin/boot!
             {:plugins
              [{:ns 'agent.plugins.session}
               {:ns 'agent.plugins.mock :config {:generate generate}}
               {:ns 'agent.plugins.context-manager
                :config {:context-window 120 :reserve-tokens 20
                         :chars-per-token 1.0 :retain-messages 2}}
               {:ns 'agent.plugins.runtime}]})]
    (try
      (let [session (kernel/require-service ctx :agent/session)
            store (kernel/require-service ctx :session/store)
            {:keys [result]} ((:submit! session) (apply str (repeat 200 "x")))
            before (System/nanoTime)]
        (is (= true (deref started 1000 :timeout)))
        (is (true? ((:abort! session))))
        (let [{:keys [ok error]} (deref result 1000 :timeout)
              elapsed-ms (/ (- (System/nanoTime) before) 1000000.0)
              events ((:events store))]
          (is (false? ok))
          (is (:cancelled (ex-data error)))
          (is (< elapsed-ms 1000))
          (is (some #(= "agent/aborted" (:type %)) events))
          (is (not-any? #(= "session/compaction" (:type %)) events))))
      (finally (kernel/dispose-all! ctx)))))

(deftest session-tree-checkout-name-and-label
  (let [ctx (plugin/boot! {:plugins [{:ns 'agent.plugins.session}]})]
    (try
      (let [store (kernel/require-service ctx :session/store)]
        ((:append! store) "message" {:message {:role "user" :content "one"}})
        (let [branch-point (:active-leaf store)
              branch-id (branch-point)]
          ((:append! store) "message"
           {:message {:role "assistant" :content "two"}})
          ((:name! store) "demo")
          ((:label! store) "experiment")
          (is (= "demo" ((:name store))))
          (is (= "experiment" ((:label store))))
          (is (every? :parent-id (rest ((:tree store)))))
          (let [checkout ((:checkout! store) branch-id)]
            (is (= branch-id (:parent-id checkout)))
            (is (= [{:role "user" :content "one"}]
                   ((:messages store)))))))
      (finally (kernel/dispose-all! ctx)))))

(deftest trusted-resource-catalog-and-progressive-skill-loading
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "bb-agent-resources-"
                            (make-array java.nio.file.attribute.FileAttribute 0)))
        resource-dir (io/file directory ".bb-agent")
        skill-dir (io/file resource-dir "skills" "demo")
        skill-file (io/file skill-dir "SKILL.md")]
    (.mkdirs skill-dir)
    (spit (io/file directory "AGENTS.md") "Project context")
    (spit skill-file
          "---\nname: demo-skill\ndescription: Demo capability\n---\nDo the demo.")
    (try
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'agent.plugins.trust
                    :config {:root (str directory) :trusted true}}
                   {:ns 'agent.plugins.resources
                    :config {:root (str directory)
                             :user-dir (str (io/file directory "user"))}}]})]
        (try
          (let [catalog (kernel/require-service ctx :resources/catalog)
                snapshot ((:snapshot catalog))]
            (is (= ["AGENTS.md"] (mapv :name (:contexts snapshot))))
            (is (= ["demo-skill"] (mapv :name (:skills snapshot))))
            (is (str/includes? (:content ((:load-skill catalog) "demo-skill"))
                               "Do the demo"))
            (is (kernel/tool ctx "load_skill"))
            (spit skill-file
                  "---\nname: demo-skill\ndescription: Updated\n---\nNew body.")
            (is (= "Updated" (get-in ((:reload! catalog))
                                      [:skills 0 :description]))))
          (finally (kernel/dispose-all! ctx))))
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'agent.plugins.trust
                    :config {:root (str directory) :trusted false}}
                   {:ns 'agent.plugins.resources
                    :config {:root (str directory)
                             :user-dir (str (io/file directory "user"))}}]})]
        (try
          (let [snapshot ((:snapshot (kernel/require-service
                                      ctx :resources/catalog)))]
            (is (empty? (:contexts snapshot)))
            (is (empty? (:skills snapshot))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest external-project-plugin-cannot-self-assert-trust
  (let [error (try
                (plugin/boot! {:plugins [{:ns 'example.math}
                                         {:ns 'agent.plugins.trust
                                          :config {:trusted true}}]}
                              {:allow-external-plugins false})
                nil
                (catch Throwable error error))]
    (is (instance? clojure.lang.ExceptionInfo error))
    (is (str/includes? (ex-message error) "requires trust"))))

(deftest model-registry-selects-providers-at-runtime
  (let [ctx (plugin/boot! {:plugins [{:ns 'agent.plugins.model-registry}]})]
    (try
      (let [registry (kernel/require-service ctx :llm/registry)
            dispose-a ((:register! registry)
                       {:id :a :model "a-model"
                        :generate (fn [_] {:message {:content "a"}})})
            dispose-b ((:register! registry)
                       {:id :b :model "b-model"
                        :generate (fn [_] {:message {:content "b"}})})]
        (is (= "a" (get-in ((kernel/require-service ctx :llm/generate) {})
                            [:message :content])))
        ((:select! registry) :b)
        (is (= "b-model" (:model ((:current registry)))))
        (is (= "b" (get-in ((kernel/require-service ctx :llm/generate) {})
                            [:message :content])))
        (is (= #{:a :b} (set (map :id ((:providers registry))))))
        (dispose-b)
        (dispose-a))
      (finally (kernel/dispose-all! ctx)))))

(deftest omp-anchored-edits-reject-stale-and-overlapping-work
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "bb-agent-omp-edit-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        target (io/file directory "sample.txt")]
    (spit target "one\ntwo\nthree\n")
    (try
      (let [ctx (plugin/boot!
                 {:plugins
                  [{:ns 'agent.plugins.model-registry}
                   {:ns 'agent.plugins.execution-world
                    :config {:root (str directory) :sandbox :none}}
                   {:ns 'agent.plugins.omp
                    :config {:max-file-chars 10000 :max-edits 8}}]})]
        (try
          (let [read-tool (kernel/tool ctx "hash_read")
                edit-tool (kernel/tool ctx "hash_edit")
                first-read ((:execute read-tool) {:path "sample.txt"} {})
                anchors (mapv :anchor (:lines first-read))
                edited ((:execute edit-tool)
                        {:path "sample.txt"
                         :file_hash (:file_hash first-read)
                         :edits [{:op "replace"
                                  :start (anchors 1)
                                  :content "TWO"}
                                 {:op "insert_after"
                                  :start (anchors 2)
                                  :content "four"}]}
                        {})]
            (is (= "one\nTWO\nthree\nfour\n" (slurp target)))
            (is (= 2 (:edits edited)))
            (is (not= (:file_hash first-read) (:file_hash edited)))
            (is (thrown-with-msg?
                 clojure.lang.ExceptionInfo
                 #"hash_read"
                 ((:execute edit-tool)
                  {:path "sample.txt"
                   :file_hash (:file_hash first-read)
                   :edits [{:op "delete" :start (anchors 0)}]}
                  {})))
            (let [latest ((:execute read-tool) {:path "sample.txt"} {})
                  first-anchor (get-in latest [:lines 0 :anchor])]
              (is (thrown-with-msg?
                   clojure.lang.ExceptionInfo
                   #"overlap"
                   ((:execute edit-tool)
                    {:path "sample.txt"
                     :file_hash (:file_hash latest)
                     :edits [{:op "replace" :start first-anchor
                              :content "ONE"}
                             {:op "delete" :start first-anchor}]}
                    {})))
              (spit target "externally changed\n")
              (is (thrown-with-msg?
                   clojure.lang.ExceptionInfo
                   #"changed after hash_read"
                   ((:execute edit-tool)
                    {:path "sample.txt"
                     :file_hash (:file_hash latest)
                     :edits [{:op "replace" :start first-anchor
                              :content "ONE"}]}
                    {})))
              (is (= "externally changed\n" (slurp target)))))
          (finally (kernel/dispose-all! ctx))))
      (finally (delete-tree! directory)))))

(deftest omp-role-router-selects-a-provider-without-changing-global-selection
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory
                            "bb-agent-omp-route-"
                            (make-array java.nio.file.attribute.FileAttribute
                                        0)))
        ctx (plugin/boot!
             {:plugins
              [{:ns 'agent.plugins.model-registry}
               {:ns 'agent.plugins.execution-world
                :config {:root (str directory) :sandbox :none}}
               {:ns 'agent.plugins.omp
                :config {:roles {:default :a :plan [:missing :b]}}}]})]
    (try
      (let [registry (kernel/require-service ctx :llm/registry)
            dispose-a ((:register! registry)
                       {:id :a :model "a-model"
                        :generate (fn [_] {:message {:content "a"}})})
            dispose-b ((:register! registry)
                       {:id :b :model "b-model"
                        :generate (fn [_] {:message {:content "b"}})})
            roles (kernel/require-service ctx :omp/roles)]
        (try
          (is (= :a (:id ((:current registry)))))
          (is (= :plan (:role ((:set! roles) :plan))))
          (is (= "b"
                 (get-in (kernel/waterfall
                          ctx :llm/request
                          {:messages [] :tools [] :options {}}
                          (:generate registry))
                         [:message :content])))
          (is (= :a (:id ((:current registry)))))
          (kernel/dispose-plugin! ctx :omp/coding-foundation)
          (is (nil? (kernel/tool ctx "hash_read")))
          (is (nil? (kernel/tool ctx "hash_edit")))
          (is (nil? (kernel/service ctx :omp/roles)))
          (is (nil? (kernel/command ctx "role")))
          (finally
            (dispose-b)
            (dispose-a))))
      (finally
        (kernel/dispose-all! ctx)
        (delete-tree! directory)))))

(deftest auth-store-resolves-credentials-dynamically
  (let [ctx (plugin/boot! {:plugins [{:ns 'agent.plugins.auth-store}]})]
    (try
      (let [store (kernel/require-service ctx :auth/store)
            calls (atom 0)
            dispose ((:register! store) :demo
                     (fn [] {:api-key (str "key-" (swap! calls inc))})
                     {:source :test})]
        (is (= {:api-key "key-1"} ((:resolve! store) :demo)))
        (is (= {:api-key "key-2"} ((:resolve! store) :demo)))
        (is (= [{:source :test :id :demo}] ((:providers store))))
        (dispose)
        (is (thrown? clojure.lang.ExceptionInfo
                     ((:resolve! store) :demo))))
      (finally (kernel/dispose-all! ctx)))))

(deftest expanded-schema-composition-and-constraints
  (is (empty? (schema/errors {:oneOf [{:type "string" :minLength 2}
                                      {:type "integer" :minimum 10}]}
                             "ok")))
  (is (seq (schema/errors {:anyOf [{:type "string" :pattern "^x"}
                                   {:type "integer" :minimum 10}]}
                          "no")))
  (is (empty? (schema/errors {:type ["string" "null"]} nil)))
  (is (seq (schema/errors {:type "array" :uniqueItems true}
                          [1 1]))))

(deftest public-api-and-versioned-json-projection
  (let [ctx (api/boot
             {:plugins
              [{:ns 'agent.plugins.session}
               {:ns 'agent.plugins.mock
                :config {:responses
                         [{:message {:role "assistant" :content "ok"}
                           :finish-reason "stop"}]}}
               {:ns 'agent.plugins.runtime}]})
        output (java.io.StringWriter.)]
    (try
      (binding [*out* output]
        (protocol/json-once! ctx "hello"))
      (let [lines (map #(json/parse-string % true)
                       (str/split-lines (str output)))]
        (is (every? #(= 1 (:version %)) lines))
        (is (= "result" (:type (last lines))))
        (is (some #(= "agent.turn/start" (:event %)) lines)))
      (finally (api/dispose! ctx)))))

(defn -main []
  (let [{:keys [fail error]}
        (run-tests 'agent.test-runner)]
    (when (pos? (+ fail error))
      (throw (ex-info "Tests failed" {:fail fail :error error})))))
