# TUI 架构与扩展接口

## 结论

本项目可以把 TUI 作为普通插件实现，而且当前实现没有把终端逻辑塞回 agent loop。默认
profile 挂载 `agent.plugins.tui`，它只消费已有的 session、event、command 与 tool 契约，并
提供三个 service：

- `:frontend/interactive`：全屏交互宿主；
- `:ui/prompt`：审批与插件可复用的 select/confirm/input/custom overlay；
- `:ui/extensions`：可逆的 renderer、shortcut、status、widget 注册表。

实现借鉴 Charm/Bubble Tea 的 `Model -> Update -> View` 单向状态流。终端层直接使用
Babashka 已内置的 JLine，避免为了启动 TUI 再要求用户安装 JVM 或动态解析 Maven 依赖。
因此 `charm.clj` 可以作为以后替换 renderer/backend 的候选，而不是业务插件必须依赖的
基础设施。这个取舍保留了 Charm 式架构，也让默认 `bb agent` 保持单二进制启动。

Pi 的关键经验同样被保留：agent state 与 durable session 分离，partial message 和工具
update 走 live event；命令与 UI renderer 是 extension effect；模型可见的 tool content 与
终端 presentation 分开。

## 使用

默认 profile 不带 `--once` 时直接进入 TUI：

```bash
bb agent
bb agent --session .bb-agent/sessions/demo.jsonl
```

未显式传入 `--session` 时，CLI 会自动创建 `.bb-agent/sessions/<时间>-<ID>.jsonl`，因此退出
后仍可通过 `/sessions` 恢复；打开 session selector 前会刷新 catalog。若某个 profile 明确
只需要临时会话，可在 session 插件配置中设置 `:ephemeral true`。

不需要模型凭据的演示：

```bash
bb agent --config examples/tui-mock.edn --mode tui
```

TUI 插件配置：

```clojure
{:ns agent.plugins.tui
 :config {:root "."
          :screen :alternate ; 或 :main
          :theme :midnight  ; :midnight、:paper、:matrix
          :mouse true       ; 鼠标/触控板滚动 transcript
          :hardware-cursor false}}
```

渲染器始终把终端光标定位到当前编辑位置，便于中文/日文/韩文 IME 正确放置候选框；默认
仍显示块状假光标。若所用终端只有在硬件光标可见时才跟随 IME，可设置
`:hardware-cursor true`。

快捷键：

| 按键 | 行为 |
|---|---|
| `Enter` | idle 时提交；运行中作为 steer 在下一次模型请求前进入；overlay 中确认 |
| `Alt+Enter` | 运行中加入 follow-up，在当前运行自然结束后继续 |
| `Ctrl+N` | 插入换行 |
| `Ctrl+S` | `Enter` 的显式 steer 别名 |
| `Esc` | 关闭 overlay，或中止当前运行 |
| `Ctrl+C` | 运行中中止；idle 时第一次清空/提醒，500ms 内第二次退出 |
| `Ctrl+D` | 空编辑区退出，否则向前删除 |
| `Ctrl+O` | 展开/折叠工具参数、实时输出与 reasoning |
| `Ctrl+T` | 主题选择器 |
| `Tab` | slash command 或路径补全 |
| `↑/↓` | 单行输入历史；多行输入上下移动 |
| `PageUp/PageDown` | 按页滚动 transcript |
| 鼠标滚轮/触控板 | 滚动 transcript |

向上滚动后，状态栏会显示 `history ↑N`。流式文本和工具事件继续到达时，TUI 会固定当前
历史视口，不再强制跳回底部；持续按 `PageDown` 或向下滚动即可回到最新消息。

首次打开尚未作出信任决定的项目时，TUI 会先显示 `Trust project`、`Open restricted` 和
`Exit`。只有选择信任后，Bash、写入工具和项目资源才会启用；选择受限模式会保存拒绝
决定，之后仍可用 `/trust allow` 修改。

`/model`、`/sessions`、`/tree` 和 `/theme` 会打开选择器。选择另一个 session 时，TUI
安全销毁当前插件 context，然后用所选 JSONL 重新启动；当前 provider 选择会被保留。
`:screen :alternate` 在退出后恢复原终端内容，`:screen :main` 则保留在主屏。

## 插件扩展

UI 扩展通过 `agent.ui` 注册，所有注册都绑定插件 effect；插件卸载后会自动撤销：

```clojure
(ns my.ui
  (:require [agent.ui :as ui]))

(def plugin
  {:id :my/ui
   :requires #{:ui/extensions}
   :start
   (fn [ctx _]
     (ui/set-status! ctx :connection "online")
     (ui/set-widget! ctx :hint ["Ctrl+G: notify"]
                     {:placement :below-editor})
     (ui/register-shortcut!
      ctx "ctrl+g"
      {:description "Show notification"
       :handler (fn [_] (ui/notify! ctx "Hello"))})
     (ui/register-tool-renderer!
      ctx "deploy"
      (fn [result {:keys [width]}]
        [(str "Deploy " (:status result) " · width " width)]))
     nil)})
```

可注册的表现层包括：

- `register-message-renderer!` 与 `register-entry-renderer!`；
- `register-tool-renderer!`；工具定义也可以直接声明 `:render-tui`；
- `register-shortcut!`、`set-status!`、`set-widget!`；
- `notify!` 与 `set-theme!`；
- 阻塞式 `select!`、`confirm!`、`input!`、`custom!` prompt。

工具的 canonical value、模型文本和 TUI 表现是三层独立契约：`:execute` 返回结构化值，
`:render-model` 生成送回模型的内容，`:render-tui` 或 UI registry 生成终端视图。旧工具的
`:render` 仍作为 `:render-model` 的兼容别名。

默认工具视图会按 `call-id` 把 call、live update 与 result 合并为一张执行卡片；完成时原地
从 `running` 更新为 `done/error`，不会再分别显示一次调用和一次结果。折叠态保留工具名、
参数摘要、耗时与结果摘要，`Ctrl+O` 展开后显示调用 ID、完整参数、实时输出和完整结果。
`bash` 会突出 command/cwd/exit code，`read` 显示文件与预览统计，`write/edit` 显示目标和
改动规模，`grep/find/ls` 显示范围与结果数量。

终端循环采用事件驱动刷新：没有输入、流式事件或 resize 时不重新构建界面。durable
session 会预先投影为增量 timeline，并按 entry 缓存 Markdown/工具渲染；新的消息或工具
实时输出只重算新增或变化的 entry，长会话不会在每次模型 delta 时重新解析全部历史。

内建工具结果把“给模型的文本”和“供 UI 恢复的结构化详情”分开保存。以 `read` 为例，
模型会收到已读行范围、总行数和继续读取的 offset；TUI 卡片则从持久化 details 显示
`lines 1-20/340` 等摘要，重开 session 后不会退化成模糊的字符计数。

完整示例见 `plugins/example/ui_demo.clj`。

## 与 Pi、Charm 的对应关系

| 关注点 | Pi / Charm 思路 | 本项目落点 |
|---|---|---|
| 状态流 | Bubble Tea/Charm 的 Model、Update、View | 单一 state atom、消息队列、纯 `update-state`/`render-screen` |
| Agent 流式状态 | partial message 与 lifecycle events | `:agent/session` subscription + `:llm/stream` 聚合状态 |
| 工具呈现 | start/update/end 与 custom renderer | durable call/result + live update/end + `:render-tui` |
| 扩展生命周期 | extension 注册与 reload | kernel tracked effect 与逆序 disposer |
| Dialog | selector/input/custom component | `:ui/prompt` overlay service |
| 流式输入 | Enter steer、Alt+Enter follow-up，队列可见 | `:agent/session` 双队列 + `:queue/changed` |
| Unicode 编辑 | grapheme 删除、按终端显示宽度移动 | JLine 输入 + grapheme/visual-column editor |
| 终端恢复 | 每行 reset、异常/信号恢复终端 | diff renderer + 幂等 cleanup/shutdown hook |
| 终端后端 | Charm ANSI/component ecosystem | Babashka 内置 JLine、raw mode、差量 ANSI renderer |

参考：

- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi interactive mode](https://pi.dev/docs/latest/usage)
- [Babashka 1.12.215 与 charm.clj 示例](https://blog.michielborkent.nl/babashka-1.12.215.html)
