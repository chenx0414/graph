# Graph Troubleshooting

## 开始前

先读取实时事实，而不是先猜：

1. `read_system_capabilities`
2. `inspect_graph_system`
3. `get_graph_state`
4. `list_problems`
5. 相关 task、node run、operation 和 session
6. 本 docs 索引和相关主题页

## 任务没有推进

检查：

- task phase、node status 和依赖；
- 会话是否已归档，或 chatting 主管是否在空队列上热重试；
- 是否有 open internal problem；
- 是否达到并发或预算边界；
- operation 是否处于 dispatched/running；
- worker/session 是否仍存在；
- 最近是否有 result handoff、artifact 或 evidence；
- 是否连续多轮没有实质进展。

如果 operation 结果不明，按 recovery 规则核查，不直接 retry 可能有副作用的动作。

## 工具不可用

检查：

- definition 是否绑定正确 capability version；
- capability status 是否 invalid 或 unavailable；
- node run 中是否记录了 load fact；
- host policy、read-only、network 或 pause 是否阻止调用；
- tool 是否在 disabled list；
- provider 是否真的收到对应 tool schema。

区分“未发现”“已注册”“已启用”“本次已加载”和“可执行”。这些状态不是同义词。

## RSI 不可用或重载未生效

检查：

- `inspect_rsi_status` 的 `available`、`root` 与 `reason`：打包应用运行的是 `Graph.app/Contents/Resources/app` 里的副本，不是 Git 仓库，所以默认不可用；把 `GRAPH_RSI_ROOT` 指向一个 checkout（含 `src/server/cli.ts` 与构建好的 `dist/web/index.html`）后，启动器会改从该 checkout 运行 daemon；
- `pendingRestart` 与 `canRestart`：有在途 operation 时普通请求不会重载；`pendingRestart.force` 为真时会跳过该条件；
- `apply_rsi_change` 返回的 `status`：`checks_failed` 表示检查未通过但改动仍保留在工作区（继续修复或传 `changes: []` 重跑检查），`rolled_back` 表示意外错误并已恢复文件，`unavailable` 表示没有可用 checkout；
- 桌面进程是否在轮询 `/api/app/rsi/status`，以及 `/api/app/rsi/restart-ack` 是否成功；
- `activation.state=pending_reload` 表示已提交但尚未确认生效；成功请求激活后当前回合会结束，待重载期间新消息保持排队。只有 `activation.state=active` / `lastActivation` 才是重载确认；请求消失或工具返回 `applied` 都不能单独证明已生效；
- conversation 中的 `kind=rsi` 报告：它记录了分支、提交、验证结果与重载状态。

不要在 checkout 有未提交改动时强行改同一文件；RSI 会拒绝并要求先处理脏文件。上一次失败尝试留下的文件属于例外：它们在 `<stateDir>/rsi/working.json` 中登记，仍可继续修改。

## 上下文压缩失败

压缩摘要本身是一次模型调用，预算为 `min(0.8 × reserveTokens, model.maxTokens)`。如果这次生成被输出上限截断，Pi 会拒绝不完整的摘要并报 `Summarization failed: generation hit the token cap`。

检查：

- `session.compaction_failed` 事件（`reason` 是 `manual`、`threshold` 或 `overflow`）与其中的 `error`；
- 模型的 `maxTokens`：摘要预算永远不会超过它，配置过小会让长会话的摘要永远放不下；
- 会话是否已经超过窗口（UI 的“上下文”指标）。超过后每一轮都会失败，直到一次压缩成功。

Graph 会在每次回合开始前，按上一次已计量的上下文判断是否需要压缩，并用 `COMPACTION_INSTRUCTIONS` 主动调用一次压缩：这套指令要求摘要控制在约 1500 tokens、允许丢弃已解决的细节，从而避免 Pi 默认“保留全部历史”的更新提示让摘要逐次膨胀直到超出输出上限。Pi 自己的阈值/溢出压缩仍作为兜底保留。手动压缩失败会作为一次普通执行失败上报，而不是变成无法解释的用量未知停驻。

## 模型不可用

检查：

- `configuredModels`；
- credential 是否配置；
- model grade 和 review 排除规则；
- 当前 instance 的 model；
- provider/network 错误；
- quota window。

缺少模型时向用户提出明确 model access 请求，不能静默换成不相关模型。

## 上下文或 handoff 失败

检查：

- context mode 和 source node；
- predecessor handoff policy；
- artifact/evidence version；
- required facts；
- capability/tool/runtime digest；
- Fresh/Fork 限制。

独立审查必须 Fresh、evidence-only 和模型排除；不能因为 handoff 缺失而继承实现 transcript。

## 恢复不明

核查外部结果并保留证据：

- Git refs、index、worktree；
- artifact registry；
- operation journal；
- command/MCP 输出；
- session file 和 worker process。

明确时才重试；不明确时创建或处理 recovery problem。

## 需要系统变更

先定位到具体文件、行为或配置。用 `propose_system_change` 给出：

- problem；
- proposed change；
- impact；
- risk；
- validation method。

用户批准后应用并验证。不要把临时绕路描述成永久修复。

## 汇报格式

对用户汇报时包含：

- 观察到的事实；
- 根因或仍不确定的部分；
- 已采取的动作；
- 证据；
- 影响；
- 下一步或需要用户决定的事项。

不要倾倒原始错误栈；Main Agent 应先整理。
