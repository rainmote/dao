# OMP-inspired coding foundation 插件

`agent.plugins.omp` 把 Oh My Pi 中最适合当前架构的两项能力移植为一个可逆插件：

1. 内容哈希锚定的完整文件读取与批量编辑；
2. 角色到 provider 的请求路由。

插件不替换默认 agent loop、ExecutionWorld 或现有 `edit` 工具。把它从 profile 的
`:plugins` 中移除后，工具、命令、service 和 interceptor 会按微内核 effect 机制一并撤销。

## 配置

```clojure
{:ns agent.plugins.omp
 :config {:max-file-chars 500000
          :max-edits 32
          :default-role :default
          :roles {:default :chatgpt
                  :plan [:anthropic :chatgpt]
                  :slow :anthropic
                  :smol :deepseek}}}
```

每个角色可配置一个 provider，也可配置按优先级排列的候选 vector。路由只会选择已经在
`:llm/registry` 注册的第一个候选；找不到候选时请求会明确失败，不会静默用错模型。
没有配置映射的角色继续使用 registry 当前选中的 provider。

交互模式使用：

```text
/role
/role plan
/role default
```

嵌入调用也可以为单次请求传入 `:model-options {:role :plan}`，其优先级高于当前 `/role`
状态。路由不会改变 model registry 的全局选择，因此一次计划请求不会污染后续普通请求。

## 锚定编辑流程

先调用 `hash_read`：

```json
{"path":"src/example.clj"}
```

它返回文件级 `file_hash`，以及类似 `12:AB12CD34` 的逐行锚点。然后把快照与一个或多个操作
交给 `hash_edit`：

```json
{
  "path": "src/example.clj",
  "file_hash": "12AB34CD56EF",
  "edits": [
    {
      "op": "replace",
      "start": "12:AB12CD34",
      "end": "14:78EF90AB",
      "content": "(defn updated []\n  :ok)"
    },
    {
      "op": "insert_after",
      "start": "20:11223344",
      "content": ";; verified"
    }
  ]
}
```

支持 `replace`、`delete`、`insert_before` 和 `insert_after`。一个调用内的操作先全部验证，
在内存中按从后向前顺序应用，最后只写文件一次。以下情况会在写入前拒绝：

- 没有先调用 `hash_read`；
- 文件级 hash 已过期；
- 行号存在但内容 hash 不匹配；
- 操作范围互相重叠；
- 超过文件大小或单次操作数上限。

成功后会返回新的 `file_hash`。为了避免跨调用沿用已经变化的行号，后续编辑同一文件前仍应
重新执行 `hash_read`。

## 安全边界

- 所有读取和写入都经过 `:execution/world`，不会直接访问宿主文件系统；
- `hash_edit` 使用 ExecutionWorld 解析后的写入目标；
- 默认 profile 已把 `hash_edit` 加入 project trust 和 approval 列表；
- 插件不启动额外进程，不绕过已有 Seatbelt、容器或远程 ExecutionWorld；
- 快照只存在当前插件实例内，不写入 session，也不会携带到下一次启动。

当前 ExecutionWorld 没有 compare-and-swap 写入原语。插件会在最终写入前重新读取并校验
hash，可拦截正常的外部修改；但另一个进程若恰好在“最后一次校验”和“写入”之间修改文件，
仍存在很小的竞争窗口。需要强一致性时，应由后续 ExecutionWorld provider 提供原子条件写。
空文件没有可用的行锚点，初始化内容应继续使用 `write`。

## 与完整 OMP 的边界

当前版本没有伪装成已实现以下能力：

- **DAP**：需要在现有长驻 stdio provider 上增加调试 session 状态机、事件订阅与单独的
  交互审批边界；不能把调试器写内存、启动进程等能力混入只读代码查询。
- **可写 subagent/worktree**：需要子 context、独立 ExecutionWorld 和合并协议，否则并行
  写入会破坏当前确定性的工具批语义。
- **Advisor 二次调用**：当前 provider 的 stream 是全局事件；在工具内部调用第二个模型会把
  两条流混入前端。应先增加 scoped stream/channel，再实现 Advisor。
- **Rust 原生搜索与 AST**：属于性能后端，不应在 Babashka 插件中复制伪实现。

LSP 已由独立的 stdio provider、runtime 和 tool adapter 实现，见
[LSP 插件文档](lsp-plugin.md)。下一阶段可在同一 provider 上单独实现 DAP transport，仍不需要
修改 OMP coding foundation 本身。
