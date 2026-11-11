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

- `inspect_rsi_status` 的 `available`、`root` 与 `reason`：打包应用跑的是 `/Applications/Graph.app` 里的副本，不是 Git 仓库，所以默认不可用；把 `GRAPH_RSI_ROOT` 指向一个 checkout（含 `backend/internal/graph/server_cli.go` 与 `app/main.go`）后，launchd 启动的 daemon 以该目录为 `--application-root`。窗口与 daemon 是同一个二进制：launchd 跑的是 App 自身在 `~/Library/Application Support/Graph/bin/graphd` 的副本，带 `daemon` 参数。改 `app/` 必须 `go -C backend run ./cmd/graphbuild app` 重新装包，**并由用户退出重开**才生效；daemon 侧改动会在下一次 App 启动时换上同一份新二进制并重启 launchd。
- `pendingRestart` 与 `canRestart`：有在途 operation 时普通请求不会重载；`pendingRestart.force` 为真时会跳过该条件；
- `apply_rsi_change` 返回的 `status`：`checks_failed` 表示检查未通过但改动仍保留在工作区（继续修复或传 `changes: []` 重跑检查），`rolled_back` 表示意外错误并已恢复文件，`unavailable` 表示没有可用 checkout；
- 桌面进程是否在轮询 `/api/app/rsi/status`，以及 `/api/app/rsi/restart-ack` 是否成功；
- 守护进程重启后 launchd 报 `EX_CONFIG 78` 并反复退出：说明 job 定义变了却只做了 `kickstart -k`，它拿内存里的旧定义去启动已被删除的路径。修法是 `bootout` + `bootstrap` + `kickstart`（`launchAgentPlan(reload=true)`）；
- 想手动验证「重启后授权还在」：不要在守护进程里的 bash 里 `launchctl kickstart`——那会杀掉本会话所在的进程，命令随之中断。把重启交给用户终端，或者干脆换二进制后让 App 自己重启守护进程；
- `activation.state=pending_reload` 表示已提交但尚未确认生效；成功请求激活后当前回合会结束，待重载期间新消息保持排队。确认后会自动续跑原请求；`rsi.continuation_ready` 与 `rsi.continuation_dispatched` 可核对是否已领取。只有 `activation.state=active` / `lastActivation` 才是后台重载确认（窗口恢复还需单独检查）；请求消失或工具返回 `applied` 都不能单独证明已生效；
- conversation 中的 `kind=rsi` 报告：它记录了分支、提交、验证结果与重载状态。

不要在 checkout 有未提交改动时强行改同一文件；RSI 会拒绝并要求先处理脏文件。上一次失败尝试留下的文件属于例外：它们在 `<stateDir>/rsi/working.json` 中登记，仍可继续修改。

## 上下文压缩失败

压缩摘要本身是一次模型调用，预算为 `min(0.8 × reserveTokens, model.maxTokens)`。如果这次生成被输出上限截断，Pi 会拒绝不完整的摘要并报 `Summarization failed: generation hit the token cap`。

检查：

- `session.compaction_failed` 事件（`reason` 是 `manual`、`threshold` 或 `overflow`）与其中的 `error`；
- 模型的 `maxTokens`：摘要预算永远不会超过它，配置过小会让长会话的摘要永远放不下；
- 会话是否已经超过窗口（UI 的“上下文”指标）。超过后每一轮都会失败，直到一次压缩成功。

上下文有两个边界，都由内核在发送前执行。超过窗口的 70%（或 `GRAPH_COMPACTION_CEILING` 指定的更小值）时先压缩：摘要替换较早的上下文，最近的窗口原样保留；超过窗口本身时不再发送，改为重置成一条指针——完整 transcript 仍在 durable 会话里，下一轮用 `history_search` 工具按需检索（无参数列出最近条目，`query` 按关键词返回片段，`entryId` 读全文）。重置是 `session.context_reset` 事件，不丢历史。估算以上一次 provider 实报的 usage 为锚点，只估它之后的新消息，并加上待发送的输入；不再用 JSON 字节数——转义后的 HTML 与工具结果会把估算放大 30–170%，在真实用量只有 60–76% 时就错误地重置会话。`/compact` 仍是手动路径，使用 `COMPACTION_INSTRUCTIONS` 的有界交接指令；Pi 自己的阈值/溢出压缩作为兜底保留。压缩事件记录已覆盖的 completion 调用序号，下一轮按调用顺序选择压缩后估算或更新的模型用量，不按整轮结束时间判断。`Already compacted` / `Nothing to compact (session too small)` 是无需操作的成功结果，记录为 `session.compaction_skipped`，不会停驻主管。真正的手动压缩失败仍作为普通执行失败上报。排队的原任务与已确认重载后的续跑不因压缩命令丢失。

## 模型不可用

检查：

- `configuredModels`；
- credential 是否配置；
- review 排除规则；
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

先定位到具体文件、行为或配置，写出提案（`propose_system_change` 工具已于 2026-11-07 删除，改由人工提交）：

- problem；
- proposed change；
- impact；
- risk；
- validation method。

用户批准后应用并验证。不要把临时绕路描述成永久修复。

## 共享可变状态与安装根

共享可变状态（Pi 扩展安装根、缓存、worktree 基座）的改动必须先**串行化**（按 canonical 路径排队），**绝不在处理单一对象时删除或重建共享树**。

- 静态推断（文件清单变化、声明入口缺失）只能当**诊断**；破坏性动作必须来自被操作对象自身的证据（npm 日志、锁文件、真实加载）。
- 测试断言不得依赖调度/入队顺序，只断言不变量。
- 2026-09-25 两次事故同源：把静态推断升级成破坏性动作（整根 rm + 并发安装）导致共享安装根损坏、Main 在调用模型前就被挡。修法与上面的原则同一：先串行化、再动手。

## 直接查运行数据与调用 API

不要猜路径，也不要先翻 `graph.db`：

- 运行库是 `<stateDir>/tasks.sqlite`（macOS：`~/Library/Application Support/Graph/state/tasks.sqlite`）。tasks、conversations、events、proposals、operations 都在里面；`conversations/` 与 `instances/` 是消息与工具结果的落盘目录。
- `state/graph.db`、`state/graph.sqlite` 是旧版本遗留的空文件，没有任何代码读写；2026-11-08 已删除，不要再作为数据源。
- `/api/*` 用会话 cookie `graph_session`，值来自 `<stateDir>/session-token`；非 GET 请求还必须带本机 `Origin`。
- 只有 `/api/app/*` 用 `x-graph-app-token`，值来自 `<stateDir>/app-token`。拿它请求 `/api/tasks` 会得到 401。

自查命令（每条都能当场判定真假）：

```sh
S="$HOME/Library/Application Support/Graph/state"
U=$(python3 -c "import json;print(json.load(open('$S/console.json'))['url'])")
sqlite3 "$S/tasks.sqlite" "select phase, count(*) from tasks group by phase;"
curl -s -H "Cookie: graph_session=$(cat "$S/session-token")" -H "Origin: $U" "$U/api/tasks" | head -c 200
```

退休（软退休）已经可用：归档一个会话会把它的任务从 `GET /api/tasks` 隐藏（过滤依据是 `conversations.archived_at`）。`POST /api/conversations/{id}/archive` 需要体 `{"requestId":"..."}`；`role` 是 project/global 的主管线程不允许归档，返回 `A supervisor thread cannot be archived as a conversation`。

## 汇报格式

对用户汇报时包含：

- 观察到的事实；
- 根因或仍不确定的部分；
- 已采取的动作；
- 证据；
- 影响；
- 下一步或需要用户决定的事项。

不要倾倒原始错误栈；Main Agent 应先整理。
