# host-pipeline-defects 设计：契约、失败模式、文件归属、P2 验证

基线 `45261805`（本 worktree HEAD，工作区干净）。本文件只写结论与归属，不改代码。
每条结论都带 `file:line`；行号取自本基线，不沿用旧票号。

> 关于票号：任务说明里的 `d557f0d5` / `42d23f2a` **不是 commit**，是车道/任务 id
> （分支名 `graph/task/race-and-independent-models-d557f0d5`、`graph/task/desktop-capability-42d23f2a`，
> `git branch -a` 可查）。它们的内容已由 `fed4b4fc`、`66166049`、`e7a49ecf` 集成进 `45261805`。
> 因此 §4 的两处不是跨分支碰撞，而是「改这两个文件时不得回退基线已有语义」。
> 同理，任务给的锚点 `runtime_kernel_operation_broker.go:230` 在集成后的基线已漂移到 **:236**
> （`45261805` 在该文件 +18 行，含 `:237-246` 的 `RemoveAll` 保护块）。

---

## §1 八条缺陷定位表

证据来源两类：代码位置（本基线）与真机数据
（`/Users/macmini/Library/Application Support/Graph/state/tasks.sqlite`，只读查询，见 §7 的可复现命令）。

### P1 目录隔离 — 同一操作的第二次尝试撞上上一次的 `stdout.log`

| 项 | 内容 |
|---|---|
| 触发条件 | 同一 `deliveryId` 的第一次尝试在**过发送边界之前**失败（`paused` / `integration_blocked` / `permission` / `auth` 等），第二次尝试复用同一个 operation id 与同一个 scratch 目录 |
| 代码位置 | `backend/internal/graph/runtime_kernel_operation_broker.go:236`（`scratchDir = <StateDir>/module-operations/<id>`）、`:237-246`（只有 `previous.State == "prepared"` 才 `RemoveAll`）、`:179-197`（状态分派：`settled` 回放、`cancelled`/`dispatched`/`uncertain` 直接拒绝，`failed` **落到**重跑分支）、`:198-201`（`id = previous.Id`）、`backend/internal/graph/runtime_host_command.go:173`（`os.OpenFile(path, O_WRONLY|O_CREATE|O_EXCL, 0o600)`）、`:174`（`panic(err)`）、`backend/internal/graph/core_kernel_module_operations.go:59-63`（`FailModuleOperation`：非 dispatched 一律记 `failed`） |
| 原始错误串 | `graph.module.failed` 事件（events rowid 512048）：`open /Users/macmini/Library/Application Support/Graph/state/module-operations/1cfeb560-e387-47ec-ac73-7a4d39031232/stdout.log: file exists` |
| 真机佐证 | `kernel_module_operations`：`1cfeb560-e387-47ec-ac73-7a4d39031232`（task `288f801c…`、module `check`）`created_at=1793724531478`、`ended_at=1793751168213`、`started_at=NULL`、`state=failed`、`worker_active=0`、`error` 即上面的串 |
| 关键推断（可复核） | `RemoveAll` 的保护条件**永远不会命中要靠它保护的场景**：第一次尝试 `paused` 后 `FailModuleOperation` 已把行改成 `failed`（`core_kernel_module_operations.go:60-61`），第二次尝试读到的 `previous.State` 是 `failed`，不是 `prepared`。于是 `:243` 的清理跳过，`MkdirAll`（`:247`）成功，`O_EXCL` 打开已有 `stdout.log` 直接 panic。`started_at=NULL` 证明撞车发生在过边界之前，与被撞文件属于同一 operation id。 |
| 后果 | 同一个 delivery 永远无法再判定：`288f801c` 的 `check` 模块至今有 3 笔 `processed=0` 的投递（`e27abc25…` seq2、`2699e87a…` seq6、`72f65bc0…` seq8） |

### P2 无判定归类 — 「等待」与「没有退出码」被记成 failed

| 项 | 内容 |
|---|---|
| 触发条件 A（等待被记成失败） | 投递的源执行尚未集成：broker 抛 `paused`（`runtime_kernel_operation_broker.go:161`，`Delivery source … has not been integrated yet`） |
| 触发条件 B（无判定被记成失败） | 命令超时/被 SIGKILL，`Code=nil`（`runtime_host_command.go:257`），output 里 `passed=false`（`runtime_kernel_operation_broker.go:403`），验收读 `passed`（`core_graph_acceptance.go:234-236`）→ `status=failed`、`reason="Host check did not pass"` |
| 代码位置 | `backend/internal/graph/core_graph_runner.go:285`（只对 `RuntimeError.Code=="paused"` 静默返回）、`:288-293`（其余一律 `graph.module.failed` + `SetNodeQueuePaused` + `WakeForBlockedNode`）；`backend/internal/graph/core_graph_service_control.go:35-40`（只有 `uncertain/failed/cancelled` 可取消），`:46-52`（取消路径顺手 `MarkDeliveryProcessed`）；`backend/internal/graph/core_kernel_deliveries.go:80-82`（`processed=1` 的唯一语义是「已处理」，两种情况共用） |
| 原始错误串 | `graph.module.failed`（events 511832）：`{"deliveryId":"33332ad2-…","moduleId":"e2e","reason":"Delivery source exec-288f801c-…-implement-138 has not been integrated yet"}`；另两笔同类：rowid 506915/506917、501019、504504、509557 |
| 真机佐证 | ① 上述 5 条「等待」事件全部以 `failed` 落库，随后 4 笔操作行是 `cancelled`（其中 `ac57a0e9-2c4f-423e-a3c4-b0eb516d1b1a`）——同一事实两种口径，且需要人工 `control_graph.cancel_operation` 才能解阻塞；② `graph 42d23f2a` 的两次 50 分钟超时 `passed=0`、`code=null`（见 P3）被验收读成 failed |
| 后果 | 图把「还没轮到」和「没有结论」都当成「判断为坏」，只能靠人取消/放行；`processed=1` 也不再能当「有判定」的证据 |

### P3 超时 — 上限形同虚设、无判定、沙箱路径不留日志

| 项 | 内容 |
|---|---|
| 触发条件 | 模块声明 `timeoutMs`（本基线允许到 24 小时），或使用默认 120 000 ms |
| 代码位置 | 默认值：`runtime_kernel_operation_broker.go:320-323`（`timeoutMs := 120_000`，裸字面量，无解释）；沙箱运行器默认值：`backend/internal/graph/runtime_workspace_command.go:202-203`；**声明上限**：`backend/internal/graph/core_interface_spec_module.go:41-45`（`number < 1 \|\| number > 86400000` → 一天以内都合法）；计时起点：`runtime_host_command.go:341-345`（`BeforeStart` 之前就起表，含子进程握手）、`runtime_restricted_spawn.go:109-116`（沙箱路径同理）；超时收尾：`runtime_host_command.go:249`（stderr 追加 `Process terminated by SIGKILL: it exceeded the <N>ms timeout`）、`:257`（`finalCode = nil`）；沙箱路径不留流文件：`runtime_restricted_spawn.go:130-150`、`:157-169`（结果只在内存里，无 `OutputFiles`） |
| 原始错误串 | `Process terminated by SIGKILL: it exceeded the 3000000ms timeout` |
| 真机佐证 | 图 `42d23f2a` 的 `check` 模块定义：`{"action":"workspace.command","args":["-lc","node --run check"],"command":"bash","output":"result","sandbox":false,"timeoutMs":3000000,"version":1}`（`kernel_revisions` v1）；两次操作 `98542e2f-…`（`elapsedMs=3000101`）与 `79ffb2fc-…`（`elapsedMs=3000096`）均 `passed=0`、`code=null`；同一模块后来一次成功只用 `315554` ms（`3a14c833-…`，`passed=1`、`code=0`）——50 分钟不是这个检查需要的量，是配置允许的量 |
| 「排队不计入超时」的现状 | 程序 slot 的等待发生在 `runtime_kernel_operation_broker.go:300`（`WaitForKernelProgramExecutionSlot`），在 `RunHostCommand` 之前，**不计入**；图级 Git 锁（`backend/internal/graph/runtime_kernel_graph_lane_options.go:141` 的 `Git.Exclusive`）包在整次调用外，**不计入**。计入的是子进程握手与 `admit()`（`runtime_kernel_operation_broker.go:218-234`，含 3 次 git 调用）。所以这条契约今天靠实现顺序成立，**没有任何字段能证明它**：把计时器上移一行就静默违约 |
| 结论 | 缺三样东西：可解释的上限（不是 24h）、独立的「超时」判定（不是 `passed=false`）、两条路径都留日志（沙箱路径今日为零） |

### P4 权限探测缺少执行上下文标记

| 项 | 内容 |
|---|---|
| 触发条件 | 任一需要 accessibility 树的 desktop 子命令（`snapshot`/`click`/`type`…）在**沙箱内的节点**里被调用 |
| 代码位置 | `backend/internal/graph/runtime_agent_tools_desktop.go:277-287`（`desktopPermissionProblem` 直接 `desktop.Run([]string{"permissions"})`，不带 graphId/nodeId/executionId/沙箱标记）、`backend/internal/graph/runtime_agent_tool_desktop.go:96-113`（拒绝信封只有 `details.source/accessibility/checked`，没有「这次读数从哪来」）、`runtime_agent_tools_desktop.go:156-171`（`desktopEnvironment` 只透传 `AGENT_DESKTOP_*`） |
| 文档缺口 | `docs/agent/capabilities.md:82` 已经写下同类判据（`navigator.permissions.query` 报 `granted` **不是证据**），`:43`/`:58` 写明 standard 模式在 OS sandbox 内、`graph.command` 看不到窗口服务；但没有一句「沙箱内读到的权限态不可作宿主授权的证据」 |
| 后果 | 沙箱内必然读不到宿主 TCC 授权，工具却把这次读数当成宿主事实，回一个 `PERM_DENIED` +「去 Graph.app 打开 Accessibility」的指引——把「读数的环境」误报成「用户的配置」 |

### P5 证据链：跨作用域正文、四类 not-found、验收绑定

| 项 | 内容 |
|---|---|
| 触发条件 A | `artifact_list` 列出项目作用域 artifact（`core_artifact_read.go:23-30` 的 `List` 把同项目的 `scope='project'` 一并列出），`artifact_read` 读同一件——节点侧入口把 scope 写死成 `task` |
| 代码位置 A | `backend/internal/graph/runtime_pi_adapter_context.go:37-43`（`Get`/`Read` 固定传 `"task"`）、`core_artifact_read.go:112-127`（`Get` 按 scope 过滤，非 `task` 命中不了）、`backend/internal/graph/core_artifact_storage.go:154-166`（`assertScope`，`:163` 抛 `Raise("not_found", "Artifact not found in this task workspace")`）；二进制/超限时正文静默缺席：`core_artifact_read.go:215-221`（`Text=nil` 且 `Truncated=false`，只给 `Path`） |
| 触发条件 B | `read_work_draft` 的四种找不到共用一个消息 |
| 代码位置 B | `backend/internal/graph/core_task_work_drafts.go:53-57`（`row == nil \|\| deleted_at != nil` → 同一个 `Raise("not_found", "Work draft not found")`，且 SQL 用 `JOIN work_requests`，work 不存在也落进同一分支）、`backend/internal/graph/core_coordination_work_drafts.go:109-124`（作用域拒绝抛 `permission`，与 not_found 是两套码） |
| 触发条件 C | 最新一笔操作是 `uncertain` 时验收绑到它 |
| 代码位置 C | `backend/internal/graph/core_graph_acceptance.go:220`（`ORDER BY rowid DESC LIMIT 1`，不看 state）、`:223-224`（`state != 'settled'` → `reason="Host check is <state>"`，`status` 留 `missing`） |
| 真机佐证 C | `kernel_module_operations` 里 `0017965e-f877-4ec8-9f96-e05037c0582b`（task `baaecc6c…`、`check`）是 `uncertain`；若它恰是最新一行，验收会说「Host check is uncertain」而不是绑到同模块已 `settled` 的 `13846205-…` |
| 后果 | 同一件 artifact 列表可见、正文不可读且理由骗人；四种「读不到」不可区分，Agent 无法判断该重试、改版本还是扩权；验收被一次中断钉住 |

### P6 用例稳定 — 计数型断言

| 项 | 内容 |
|---|---|
| 代码位置 | `tests/e2e/go-node-queue.test.ts:178`（读取 `retries_used`/`resubmits_used`）、`:190`、`:198`、`:259`、`:270`、`:278`（`toMatchObject({retries_used: …, resubmits_used: …})`）、`:191`/`:199`/`:271`/`:274`/`:279`（`a.turns()` 计数）；同类调度快照：`tests/e2e/go-main-budget.test.ts:187`、`:203`（`workerActive`）、`tests/e2e/provider-usage-completeness.test.ts:59`、`tests/e2e/go-provider-reconciliation.test.ts:139` |
| 反例（该照这样写） | `tests/e2e/go-wake-notification.test.ts:228`、`:301`：显式说明「`retries_used` 有意不参与比较」，只用执行 id / submission / 产物证明「没有重跑」 |
| 后果 | 契约变成「重试次数」这种内部记账：调度一改就红，行为坏了却可能绿（AGENTS.md〈测试只许断言确定的事实〉） |

### P8 陈旧 slot 锁 — 三条同类锁，无一条可判定「持有者已不在」

| 锁 | 代码位置 | 今日的判定能力 |
|---|---|---|
| ① 机器级检查 slot（唯一字面叫 slot 的东西） | `scripts/check-queue.py:148-172`（`/tmp/graph-check-<uid>/slot.lock` + `fcntl.flock`）、`:76-78`（`pass_fds` 把锁 fd 传给子进程） | 锁文件**不记持有者**：`ls -la /tmp/graph-check-501/slot.lock` 今日仍是 0 字节、mtime `Nov 4 08:10`，持锁与空置在文件上不可区分；runner 被 SIGKILL 后其子进程仍握着继承来的 fd，排队者只看到 `[check queue] Another worktree is checking; waiting for its slot`，没有「判定 + 回收」的路。仓库里已有 pid 判活原件可复用：`:15-20`（`process_start`）、`:63`（`process_start(row.pid) == row.start`） |
| ② 守护进程内 program slot 租约（饿死在这里是字面意义） | `backend/internal/graph/runtime_execution_slots.go:11`（`PROGRAM_EXECUTION_LIMIT=4`）、`:107-123`（`OccupiedSlots`：`SELECT COUNT(*) … WHERE worker_active=1`，不看 state、不看时间）、`:173-196`（`WaitForKernelProgramExecutionSlot`：20 ms 轮询，无上限、无陈旧判定）；释放只有两条：broker 的 defer（`runtime_kernel_operation_broker.go:280`）与 `core_kernel_operation_resources.go:7-25`（**要求 `resource_receipt` 非空**，而沙箱路径从不写 receipt——`runtime_kernel_operation_broker.go:328` 只在 `sandbox:false` 分支里记） | 真机已泄漏一条：`0017965e-…` `state=uncertain`、`worker_active=1`、`started_at=1793731862272`（数小时前），`core_kernel_recovery.go:11` 只清 `state='prepared'`，`:14-15` 把它改成 `uncertain` 但**不动 `worker_active`** |
| ③ 配置保存锁 | `backend/internal/graph/server_config_service.go:47-66`（`graph.config.json.lock`，`O_CREATE\|O_EXCL`，40×50 ms 后 `Raise("config_locked", …)`） | 锁文件里没有 pid、没有心跳；保存者崩溃即永久 `config_locked`，只能人工删文件 |

| 项 | 内容 |
|---|---|
| 原始错误串 | `[check queue] Another worktree is checking; waiting for its slot`（排队不前进）；`Config is locked by another editor: <path>`（`config_locked`）；`Operation still holds execution resources; verify termination before cancelling`（`core_graph_service_control.go:39`：泄漏租约连人工取消都拒绝——真机 `0017965e` 今天正卡在这条） |
| 结论 | 「陈旧」必须可判定，而三条锁今天都**没有记录持有者**。验收里的两个判据落点是：①「持有者进程不在」→ ②由 `RecoverKernelExecutions` 在取得 owner lock 后天然可知（上一个持有者已死），①③需要补 pid+start 与心跳；③「工作目录 mtime 长时间不动」→ ①的队列目录与③的锁文件是宿主自己拥有的唯一 mtime 载体（`/tmp/graph-check-501/` 的 mtime、`graph.config.json.lock` 的 mtime），②的对应物是操作 scratch 目录 `<StateDir>/module-operations/<id>` 的 mtime |

### P9 配置口径与写保护

| 项 | 内容 |
|---|---|
| 口径不一致 ①（三套词表） | 配置文件只认三个值：`backend/internal/graph/server_config_parse.go:14-17`（`openai-completions` / `anthropic-messages` / `openai-responses`）；草稿校验同样三个（`backend/internal/graph/server_providers_draft.go:106`）；**订阅/用量目录却用第四个串**：`backend/internal/graph/server_usage.go:49`（`SubscriptionModelApiResponses = "responses"`） |
| 口径不一致 ②（同一传输两种判决） | `server_usage_models.go:71`：`Supported: api != SubscriptionModelApiResponses` → 所有 ChatGPT 订阅模型在目录里显示**不支持**，而 provider 注册（`server_providers.go:102-105`，`API: ModelApiOpenAIResponses`）与配置层都接受 `openai-responses` |
| 口径不一致 ③（未知名静默降级） | 运行时 `runtime_model_runtime.go:186-196`：`switch api` 只认 `anthropic-messages`/`openai-responses`，**default 静默走 `/chat/completions`**；配置层对未知名硬拒。同一份输入，一层拒绝、一层悄悄发到另一个端点 |
| chatgpt entry 现状 | provider 目录项存在（`server_providers.go:101-106`），模型目录里被标 unsupported（`server_usage_models.go:71`），真机配置快照里确实配过：`state/graph.config.json.bak-1793752143-before-chatgpt-removal` 含 `("chatgpt:gpt-6.1-sol","chatgpt","openai-responses")` 与 `chatgpt` 凭据 |
| 写保护现状 | 只有配置服务能写：`server_config_service.go:89-96`（临时文件 + `os.Rename`）。但真机上留下了两份绕过服务的手工快照：`state/graph.config.json.bak-1793712727`（无 chatgpt）与 `…bak-1793752143-before-chatgpt-removal`（有 chatgpt），同目录下 `graph.config.json` 已不存在——说明在一次会话里有人直接编辑过线上配置。节点/测试**不得**写 `graph.config.json`（禁区，见 §3） |

---

> 失败模式（§2）与车道归属、验证（§3–§7）在 `plans/host-pipeline-defects-design-lanes.md`。
