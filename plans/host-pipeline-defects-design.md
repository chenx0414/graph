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

## §2 失败模式清单（做错走法）

### P2（无判定归类）至少三种错法

1. **靠 sleep/轮询掩盖**：把「等待源集成」当成时序问题，在 broker 里 `time.Sleep` 或让测试 `expect.poll` 等到 delivery 变 `processed=1`。
   错在：真机 `288f801c` 的 3 笔 check 投递已 `processed=0` 数小时（P1 的 `file exists` 挡着），等再久也不会变；而且这违反 AGENTS.md 的「不写 sleep、不靠等得够久」。
2. **把 unknown 当 failed（换个名字，不换判定）**：`Raise("failed", …)` 改叫 `unknown_operation` 但仍走 `FailModuleOperation`+`SetNodeQueuePaused`+`WakeForBlockedNode`（`core_graph_runner.go:288-293`），或者验收里把 `passed=false` 的 reason 从「did not pass」改成「没有结论」，`status` 仍是 `failed`。
   错在：库里仍是「一次失败」，图仍要人取消（`core_graph_service_control.go:35-40` 只接受 uncertain/failed/cancelled）。判定必须落到**状态值与事件类型**上，不是文案。
3. **用重试次数当证据**：断言「这次没有多跑」靠 `retries_used`/`turns()`/`graph.module.failed` 事件条数（`tests/e2e/go-node-queue.test.ts:190`、`:270` 的写法）。
   错在：这是内部记账（P6 同一根），调度一改就红；正确证据是操作 id/投递 id/产物摘要，见 `tests/e2e/go-wake-notification.test.ts:301` 的既有做法。

### P8（陈旧 slot）至少三种错法

1. **靠删除锁不做陈旧判定**：加一条「启动时 `os.Remove(slot.lock)`」或 `flock` 超时后 `rm` 掉 `/tmp/graph-check-*/slot.lock`，或在 recovery 里无条件 `UPDATE kernel_module_operations SET worker_active=0`。
   错在：删掉的是**别人正在用的**锁/租约，把串行化直接废弃，两个检查会同时跑同一暂存目录；真机 `0017965e` 泄漏的那一格会连带把正在跑的 3 格清掉。
2. **靠放大超时**：把 `PROGRAM_EXECUTION_LIMIT`（`runtime_execution_slots.go:11`）从 4 提到 8，或给 `WaitForKernelProgramExecutionSlot` 加「最多等 N 分钟然后放弃」。
   错在：泄漏是单调累积的（每次硬杀一条），放大只是推迟饿死；放弃等待则把「排队」变成「失败」，正是 P2 的错法换了个位置。
3. **把人工删锁当修法**：文档写「卡住了就 `rm slot.lock` / 手工 `UPDATE … worker_active=0`」。
   错在：这是现场处置，不是契约；而且 `core_graph_service_control.go:38-39` 明确拒绝在 `worker_active!=0` 时取消，人还得先破一次不变量。判据必须写进代码：持有者进程不在（pid+start 不匹配 / owner lock 重新取得）或心跳超过界 → **记事件后**回收。
4. **（补充）拿墙钟当判据**：E2E 里 `sleep 60s` 后断言「锁被回收了」。违反 AGENTS.md 的确定性要求；正确形状是「杀掉持有者 → 重启 → 同一笔排队操作被准入」这条因果链，用状态轮询落到产品事件上（`graph.operation.resources_released`、`[check queue] Reclaimed stale slot` 日志行）。

---

## §3 文件归属与不相交证明

四车道两两不相交（下表每行是一个车道的**全部**可写文件；不在表内的文件一律不动）。

### laneA — P1 目录隔离 + P3 超时与排队预算

| 文件 | 现状 LOC | 允许的改动范围 |
|---|---|---|
| `backend/internal/graph/runtime_kernel_operation_broker.go` | 428（**余量 72 行**） | `:236-247` 每次尝试独立目录 + `:320-323` 默认值/上限来源 + `:388-410` record/output 增字段 |
| `backend/internal/graph/runtime_host_command.go` | 472（**余量 28 行，超限就抽文件**） | `:341-345` 计时起点（移到子进程真正开始后）、`:249`/`:257` 超时收尾带独立标志、`:173` 流文件打开方式 |
| `backend/internal/graph/runtime_restricted_spawn.go` | 178 | `:109-116` 计时起点、`:157-169` 沙箱路径也落 `stdout.log`/`stderr.log` 并回 `OutputFiles` |
| `backend/internal/graph/core_interface_spec_module.go` | 139 | `:41-45` 超时上下界（把 24h 换成可解释的界，并让 check 的默认值有出处） |
| `tests/e2e/go-operation-scratch-isolation.test.ts`（新建） | — | P1 的重派取证 |
| `tests/e2e/go-operation-timeout-budget.test.ts`（新建） | — | P3 的超时判定 + 日志 + 排队不计入 |

### laneB — P2 无判定归类与收口 + P8 陈旧锁回收

| 文件 | 现状 LOC | 允许的改动范围 |
|---|---|---|
| `backend/internal/graph/core_graph_runner.go` | 333 | `:285-293` 等待/无判定不再发 `graph.module.failed`、不再 block |
| `backend/internal/graph/core_kernel_module_operations.go` | 89 | `:59-63` 状态枚举与 `FailModuleOperation` 判定（`unknown` 的落库） |
| `backend/internal/graph/core_graph_service_control.go` | 185 | `:35-52` 取消路径不再用 `processed=1` 冒充判定 |
| `backend/internal/graph/runtime_execution_slots.go` | 203 | `:107-123` 占用统计按 state、`:173-196` 陈旧判定与回收钩子 |
| `backend/internal/graph/core_kernel_recovery.go` | 87 | **只有 `:11` 这一条**（`worker_active` 释放条件）；`:17-86` 的执行/调用/唤醒恢复 = 禁区 |
| `backend/internal/graph/core_kernel_operation_resources.go` | 35 | `:7-25` 让沙箱路径的租约也能回收 |
| `scripts/check-queue.py` | 174 | `:148-172` 记 pid/start/cwd + 心跳、判定并回收、打印回收日志 |
| `tests/e2e/go-operation-verdict.test.ts`（新建） | — | P2 归类 |
| `tests/e2e/go-stale-slot-reclaim.test.ts`（新建） | — | P8 三条锁 |

### laneC — P4 探测上下文 + P9 配置口径与写保护

| 文件 | 现状 LOC | 允许的改动范围 |
|---|---|---|
| `backend/internal/graph/runtime_agent_tools_desktop.go` | 314 | `:277-287` 探测带执行上下文；**不动** `ResolveDesktopBinary`/`RunDesktopCommand`/`desktopEnvironment` |
| `backend/internal/graph/runtime_agent_tool_desktop.go` | 113 | `:96-113` 拒绝信封 `details` 增上下文块 |
| `backend/internal/graph/server_config_parse.go` | 241 | `:14-17` 词表与错误串（**不得删掉拒绝语义**） |
| `backend/internal/graph/server_providers.go` | 184 | `:101-106` chatgpt 项的归宿（移除或标 unsupported，二选一并写进文档） |
| `backend/internal/graph/server_usage.go` | 328 | `:43-50` 传输词表统一 |
| `backend/internal/graph/server_usage_models.go` | 372 | `:66-72` 的 `Supported` 判决 |
| `backend/internal/graph/runtime_model_runtime.go` | 413 | `:186-196` 未知名不再静默降级（**只改分派，不改任何传输形状**） |
| `docs/agent/capabilities.md` | — | 增一节：沙箱内读数不可作宿主授权证据（挨着 `:82` 的既有判据） |
| `docs/agent/models-and-providers.md` | — | 三个 api 取值 + chatgpt 的 concluded 状态 |
| `tests/e2e/go-provider-api-vocabulary.test.ts`（新建） | — | P9 |
| `tests/e2e/go-desktop-permission-context.test.ts`（新建） | — | P4 |

### laneD — P5 证据链与验收绑定 + P6 用例稳定

| 文件 | 现状 LOC | 允许的改动范围 |
|---|---|---|
| `backend/internal/graph/core_artifact_read.go` | 222 | `:112-127` 跨作用域解析、`:178-221` 正文缺席时给明确拒绝 |
| `backend/internal/graph/runtime_pi_adapter_context.go` | 294 | `:37-43` 不再把 scope 写死 `task` |
| `backend/internal/graph/core_task_work_drafts.go` | 87 | `:53-57` 四类 not-found 分开 |
| `backend/internal/graph/core_coordination_work_drafts.go` | 125 | `:109-124` 与上者对齐错误码 |
| `backend/internal/graph/core_graph_acceptance.go` | 404 | `:220` 绑「最近一次有判定的操作」、`:223-240` 读 laneB 的 verdict 字段（**跨车道读接口，见 §5**） |
| `tests/e2e/go-node-queue.test.ts` | — | P6：`:178`、`:190`、`:198`、`:259`、`:270`、`:278` 的计数断言换成行为断言 |
| `tests/e2e/go-artifact-cross-scope.test.ts`（新建） | — | P5 A |
| `tests/e2e/go-work-draft-not-found.test.ts`（新建） | — | P5 B |

### 不相交证明

- A ∩ B = ∅：A 是 `runtime_kernel_operation_broker.go` / `runtime_host_command.go` / `runtime_restricted_spawn.go` / `core_interface_spec_module.go`；B 是 `core_graph_runner.go` / `core_kernel_module_operations.go` / `core_graph_service_control.go` / `runtime_execution_slots.go` / `core_kernel_recovery.go` / `core_kernel_operation_resources.go` / `scripts/check-queue.py`。逐名比对无交集。
- A ∩ C = ∅（C 全部在 `server_*` / `runtime_agent_tool*_desktop.go` / `runtime_model_runtime.go` / docs）。
- A ∩ D = ∅（D 全部在 artifact / work_draft / acceptance + `go-node-queue.test.ts`）。
- B ∩ C = ∅、B ∩ D = ∅、C ∩ D = ∅：同上逐名比对。
- 交叉读接口（允许的耦合，不是文件碰撞）：laneB 产出 `verdict` 字段，laneD 在 `core_graph_acceptance.go` 里读它；laneA 产出 `timedOut`/`verdict`，laneB 的归类用它。字段名在 §5 一次定死，先落字段的一侧不改对方的文件。
- 派发顺序：A、B 并行（单订阅并发不超 2）；C、D 由 main 在 A、B 结算后手工派发。因此 D 读 `verdict` 时 B 已合流。

### 禁区（任何车道都不许碰）

| 禁区 | 具体路径 |
|---|---|
| deferred 工具链 | `backend/internal/graph/runtime_pig_deferred_tools.go`、任何 `deferred` 工具装载/暴露路径 |
| desktop / TCC 机制 | `backend/internal/graph/runtime_agent_tools_desktop.go:104-204`（`ResolveDesktopBinary`/`desktopCapabilityBinaries`/`RunDesktopCommand`/`desktopEnvironment`）、`.agents/skills/agent-desktop/**`、`.agents/agent-desktop-*`；测试里不许调用 `tccutil`、不许跑 `agent-desktop permissions --guide` |
| models/controlled_* | `backend/internal/graph/runtime_controlled_*.go`（`messages`/`responses`/`usage`/`output`/`stream`/`fallback`/`fetch`/`content`/`openai`）——传输形状一个字节都不改 |
| 恢复 / 未知用量 | `core_kernel_recovery.go:17-86`（执行恢复、call→unknown、阻塞唤醒）、`reconcile_usage`（`core_graph_service_control.go` 的 `reconcile_usage` 分支）、`core_kernel_operation_resources.go` 之外的一切预算/用量账本（`core_kernel_budget.go`、`core_budget_ledger.go`、`core_time_ledger.go`） |

---

## §4 两处碰撞点：不是跨分支，而是「不得回退」

### 4.1 `backend/internal/graph/runtime_kernel_operation_broker.go`（laneA）

`45261805` 已经在这个文件里落了两件事，改动时必须保留其**意图**（不是保留字面）：

1. **模块投递等集成，不判失败**（`:152-164`，`fed4b4fc` 的成果）——合并后片段：
   ```go
   merged := kernelRow(kernel.Db, "SELECT sha FROM git_commits WHERE task_id=? AND operation_id=? AND kind='integration'", graphID, *executionID)
   if merged == nil {
       // A short wait, not a repair: the delivery stays pending and the same one is
       // retried. It cannot block here instead: this operation runs under the
       // graph's Git lock (Git.Exclusive), and the source execution's own
       // integration needs that same lock (SettleWorkspace). ...
       if sourceState == "running" {
           Raise("paused", "Delivery source "+*executionID+" has not been integrated yet")
       }
       Raise("integration_blocked", "Delivery source "+*executionID+" did not reach the integration branch")
   }
   ```
   P3 改这一带（超时/收尾）时**不得**把 `paused` 这支降级成失败，也不得把它改成阻塞等待（会在 Git 锁内自锁）。
2. **一次尝试不继承另一次尝试的证据**（`:237-246`）——合并后片段：
   ```go
   if previous != nil && previous.State == "prepared" {
       if err := os.RemoveAll(scratchDir); err != nil { panic(err) }
   }
   ```
   P1 要改的是**条件**（今日永不命中，见 §1），不是删掉这段意图。

merge 时必须贴的合并后片段：`ExecuteModuleOperation` 的 `:176-260`（状态分派 + 目录准备 + admit）与 `:300-346`（slot / 超时 / 两条运行器分支）。

### 4.2 `backend/internal/graph/server_config_parse.go`（laneC）

基线片段（`:14-17`）：
```go
api := configAsString(entry["api"], path+".api")
if api != "openai-completions" && api != "anthropic-messages" && api != "openai-responses" {
    configInvalid(path + ".api must be \"openai-completions\", \"openai-responses\" or \"anthropic-messages\"")
}
```
**不得回退**：未知 api 必须继续被**硬拒**（`configInvalid`，带路径），不得改成「接受任意串、运行时再猜」——那正是 P9 ③ 的反面。
P9 允许的改动只有：词表与 `server_usage.go:49` 对齐（`responses` → `openai-responses` 一侧）、错误串同步、以及 chatgpt entry 的结论（移除 or 标 unsupported）。
禁改：`ParseGraphConfig` 的其余校验（`:80-241` 的 credentials/limits/projects/preferences 一致性）。
merge 需贴的合并后片段：`:6-67`（`configParseModel` 全文）。

### 4.3 附带：合并时的物理冲突预警

A 与 D 都会碰「`verdict` 字段的出现」，但落点不同文件（A: broker 的 output/record；D: acceptance 的读取）。若 merge 时两侧都改了 `core_graph_acceptance.go`，说明有车道越界，按 §3 归属回退到 owner 侧。

---

## §5 可观测落点（先定名，再实现）

字段名一次定死；四条车道都按这套名字写代码和断言。

### P2（无判定）

| 落点 | 名字 | 取值 |
|---|---|---|
| 操作行状态 | `kernel_module_operations.state` | 新增 `unknown`（无退出码、被中断、等待源集成、被取消而无判定），与 `failed` 严格分开 |
| 操作输出 | `outputs.<out>.verdict` | `"passed"` \| `"failed"` \| `"unknown"`（`passed` 字段保留一版，避免一次性破 UI） |
| 操作记录 | `result.json` 的 `verdict` / `noVerdictReason` | `noVerdictReason` ∈ `no_exit_code` \| `waiting_integration` \| `interrupted` \| `cancelled_without_verdict` |
| 事件 | `graph.operation.unjudged` | `{moduleId, deliveryId, operationId, reasonCode}`；**`graph.module.failed` 只留给真的有判定的失败** |
| 投递 | `kernel_module_inbox.processed_by` | 新增列，`judgment` \| `cancel` \| `cancel_operation`；`processed=1` 不再能单独说明「有判定」 |
| 验收 | `AcceptanceStatus.status` | `"unknown"`（与 `failed`/`stale`/`missing` 并列），`reason` 指出无判定的来源 |
| 运行视图 | `GET /api/tasks/<graph>/nodes/<node>/run` 的 `operations[].verdict` | 同 `outputs.verdict` |

### P3（超时）

| 落点 | 名字 | 说明 |
|---|---|---|
| 操作输出/记录 | `timeoutMs` | 本次尝试**实际生效**的上限（不是定义里的原值） |
| 操作输出/记录 | `timedOut` (bool) | 真发生了超时；`code` 仍为 `null` |
| 操作输出/记录 | `waitMs` | 花在排队（program slot + Git 锁）上的时间，明确**不计入** `timeoutMs` |
| 操作输出/记录 | `elapsedMs` | 已有（`runtime_kernel_operation_broker.go:407`），语义收紧为「命令本身的时间」 |
| 事件 | `graph.operation.settled` 增 `timedOut` | 与 `passed` 并列，消费方可区分「跑了、判定为坏」与「没跑完」 |
| 日志 | `outputFiles.stdout/stderr` | 两条运行器分支都必须有（沙箱路径今日没有） |

### P8（陈旧 slot）

| 落点 | 名字 | 说明 |
|---|---|---|
| 事件（守护进程内租约） | `graph.operation.resources_released` 增 `reason` | 已有事件（`core_kernel_operation_resources.go:27-30`，`source:"supervisor"`），新增 `source:"recovery"`、`reason` ∈ `owner_restart` \| `lease_stale` |
| 行字段（守护进程内租约） | `kernel_module_operations.lease_heartbeat_at` | 持有期间由操作自身推进；`OccupiedSlots` 只统计「`worker_active=1` 且心跳不过期」 |
| 锁文件（检查 slot） | `/tmp/graph-check-<uid>/slot.lock` 内容改成 JSON | `{pid, start, cwd, heartbeatAt, runId}`（复用 `scripts/check-queue.py:15-20`/`:63` 的 pid+start 判活） |
| 日志行（检查 slot） | `[check queue] Reclaimed stale slot held by pid <pid> (<reason>)` | 与既有的 `[check queue] Another worktree is checking; waiting for its slot` 同一命名族 |
| 锁文件（配置保存） | `graph.config.json.lock` 内容改成 JSON | 同上 `{pid, start, createdAt}`；陈旧则记日志后接管 |
| 查询 | `GET /api/tasks/<graph>/nodes/<node>/run` 的 `operations[].workerActive` | 保留，但语义明确为「租约有效」，不得用于表达调度顺序 |

---

## §6 各车道 E2E 路径与「先红」预期

统一要求：真进程（`tests/helpers/cli-daemon.ts` 的 `launchCli`）+ 真 SQLite + 真 provider fixture，不 mock 本仓组件；产物落到 `state/` 与测试根目录，跑完给出可复现命令。轮询只能等产品事件最终会落定的值（AGENTS.md）。

| 车道 | E2E 文件 | 先红时应当看到的错误串 |
|---|---|---|
| A | `tests/e2e/go-operation-scratch-isolation.test.ts` | `expected attempt #2 of operation <id> to run in its own directory; got: open <state>/module-operations/<id>/stdout.log: file exists`（真机同串见 §1 P1） |
| A | `tests/e2e/go-operation-timeout-budget.test.ts` | `expected operations[0].verdict to be "unknown" with timedOut=true; got passed=false verdict=<nil>`；`expected outputFiles.stdout for a sandboxed timed-out operation; got none`；`expected definition with timeoutMs=86400000 to be rejected; it was accepted` |
| B | `tests/e2e/go-operation-verdict.test.ts` | `expected no graph.module.failed event for reason "Delivery source … has not been integrated yet"; got 1`；`expected kernel_module_operations.state = "unknown"; got "failed"`；`expected AcceptanceStatus.status = "unknown" for check; got "failed"` |
| B | `tests/e2e/go-stale-slot-reclaim.test.ts` | `expected the queued program operation to be admitted after the lease holder was killed; still waiting (occupied=4)`；`expected log line "[check queue] Reclaimed stale slot held by pid …"; got "[check queue] Another worktree is checking; waiting for its slot"`；`expected config save after a crashed saver to succeed; got config_locked` |
| C | `tests/e2e/go-desktop-permission-context.test.ts` | `expected error.details.executionContext = {graphId,nodeId,executionId,sandbox:true}; got undefined` |
| C | `tests/e2e/go-provider-api-vocabulary.test.ts` | `expected api "responses" to be rejected with '.api must be "openai-completions", "openai-responses" or "anthropic-messages"'; it was accepted`；`expected chatgpt catalog models to be marked unsupported/supported consistently; got mixed` |
| D | `tests/e2e/go-artifact-cross-scope.test.ts` | `expected artifact_read of a project-scope artifact listed by artifact_list to return text; got error not_found: Artifact not found` |
| D | `tests/e2e/go-work-draft-not-found.test.ts` | `expected error code "draft_version_not_found"; got "not_found: Work draft not found"`（四类各一条） |
| D | `tests/e2e/go-node-queue.test.ts`（改） | 红不是新失败，而是**旧断言必须先证会随行为坏掉**：先让「重启后再发一次请求」的行为坏（临时把 `attempt` 判据改坏或注入一次重发），旧计数断言仍可能绿；换成行为断言后同一次注入必红。附修复前后两次运行输出（`retries_used` 版 vs verdict/摘要 版） |
| D | （P5 C，并入 `go-artifact-cross-scope.test.ts` 或独立） | `expected acceptance.source.id to be the last settled operation <id>; got "Host check is uncertain"` |

「先红」的记录方式：每条用例先在本车道改代码**之前**跑一次，把失败输出存到 `state/rsi/reports/` 下（文件名带缺陷号），提交时引用该文件路径 + 提交前/后的两段输出。

---

## §7 P2 验证项：用真事件表与 `kernel_module_operations` 判定

数据库：`/Users/macmini/Library/Application Support/Graph/state/tasks.sqlite`（只读）。
可复现命令（本机已跑，输出即下文结论）：

```sh
DB="/Users/macmini/Library/Application Support/Graph/state/tasks.sqlite"
# 1) 有没有「同一 operationId 被判定两次」
sqlite3 -readonly "$DB" "SELECT json_extract(data,'\$.operationId') op, type, COUNT(*) FROM events
  WHERE type IN ('graph.operation.dispatched','graph.operation.settled','graph.operation.cancelled','graph.operation.interrupted')
  GROUP BY op,type HAVING COUNT(*)>1;"
# 2) 状态分布 / 泄漏租约
sqlite3 -readonly "$DB" "SELECT state,COUNT(*) FROM kernel_module_operations GROUP BY state;"
sqlite3 -readonly "$DB" "SELECT id,module_id,state,worker_active,started_at FROM kernel_module_operations WHERE worker_active=1;"
# 3) 投递是否都留下操作行
sqlite3 -readonly "$DB" "SELECT i.module_id,i.processed,COUNT(*) inbox,SUM(o.id IS NOT NULL) with_op
  FROM kernel_module_inbox i JOIN kernel_deliveries d ON d.id=i.delivery_id
  LEFT JOIN kernel_module_operations o ON o.delivery_id=d.id GROUP BY 1,2;"
# 4) 两次 50 分钟超时的真实结果（result 是内容寻址，取 digest 再查 kernel_content）
sqlite3 -readonly "$DB" "SELECT id,state,started_at,ended_at,substr(result,22) FROM kernel_module_operations
  WHERE module_id='check' AND ended_at-started_at>2900000;"
```

### 事实 1：「操作 settled 之后是否真的还有下一次判定」——**不成立，P2 只保留归类规则，不改调度器**

- 查询 1 结果为空：`graph.operation.dispatched/settled/cancelled/interrupted` 中**没有任何 operationId 出现超过一次**。状态分布 `settled=49`、`cancelled=18`、`uncertain=1`、`failed=1`。
- 即：一个操作一旦 `settled`，真库里从未被再次派发、再次结算或事后取消。`runtime_kernel_operation_broker.go:181-187` 的 `settled` 回放也保证了同一 delivery 不会再跑。
- 因此「settled 后再判定一次」这个前提**不成立**，P2 不需要、也不允许动调度器。P2 的产物只剩归类规则：等待→`unknown`、无退出码→`unknown`、取消而无判定→`unknown`，`failed` 只留给「命令跑完且非零」。
- 需要更正任务里的一个前提：**没有「settled 后被再判定」的实例**，真正的病是「从未判定却已按 failed 收口」。

### 事实 2：desktop 两次 50 分钟超时 `code=None` 但图记 failed 并继续——**成立**

- 定义（`kernel_revisions` v1，图 `42d23f2a`）：`check` 模块 `timeoutMs: 3000000`、`sandbox: false`、`bash -lc "node --run check"`。
- 操作 `98542e2f-90d4-4a79-9812-9bf34c184739`：`passed=0`、`code=null`、`elapsedMs=3000101`、stderr 尾 `Process terminated by SIGKILL: it exceeded the 3000000ms timeout`。
- 操作 `79ffb2fc-091e-4c00-b55f-c8bdb9bd1392`：同样 `passed=0`、`code=null`、`elapsedMs=3000096`。
- 之后同一模块第三次 `3a14c833-1778-47a9-b847-4950b23e6d6d`：`passed=1`、`code=0`、`elapsedMs=315554`；图 `42d23f2a` 有 `graph.completed` 事件。
- 结论：无退出码 → `passed=false` → 验收 `failed`（`core_graph_acceptance.go:234-236`），而图照常推进。这条必须改成「超时 = 无判定」，且超时预算要收窄到可解释的量。

### 事实 3：`288f801c` 消费投递 `33332ad2`（`processed=1`）后「未创建任何操作行」——**不成立，需更正**

- 操作行**存在**：`ac57a0e9-2c4f-423e-a3c4-b0eb516d1b1a`，`module_id=e2e`，`delivery_id=33332ad2-e7f2-41eb-b574-ee133f9c04e1`，`created_at=1793751078177`、`ended_at=1793751078364`、`state=cancelled`。
- 时间线（`events`）：`1793751078364` 记 `graph.module.failed`（原因「Delivery source … has not been integrated yet」）→ `1793751123939` 该图 `graph.output`（review-139 结算）→ `1793751162949` 才出现 `graph.operation.cancelled`（人工 `control_graph` 取消，`core_graph_service_control.go:46-52`）。
- `processed=1` 是**取消路径**写的（`core_graph_service_control.go:48` → `core_kernel_deliveries.go:80-82`），不是判定写的。所以真实缺陷是「`processed=1` 被当成有判定」，而不是「没有操作行」。
- 同一张图还有 3 笔 check 投递 `processed=0`（`e27abc25…`、`2699e87a…`、`72f65bc0…`），其中 `e27abc25` 就是 P1 里 `1cfeb560…` 那条 `file exists` 的受害者。
- 第四节汇总：`decision`/`pass` 这类 router 模块 `processed=1` 且 `with_op=0` 是正常形态（router 不派发操作），不能当缺陷。

### P2 定案（写进 laneB 的任务契约）

1. 归类规则进代码：`failed` 只表示「命令跑完且非零」；`unknown` 表示无判定，来源用 `noVerdictReason` 记。
2. 不修改调度器、不改 `settled` 回放、不改 `kernel_queue` 的状态机。
3. `processed=1` 增加 `processed_by`，取消路径写 `cancel_operation`；验收/查询不得再用 `processed` 当「有判定」。
4. 验收侧读 `verdict`（laneD 落地），不为无判定伪造 `failed`。
5. E2E 证「等待不再记 failed」「超时不再记 failed」两条因果链，证据用操作 id / 投递 id / 事件类型，不用次数。

---

## 附：未改代码声明

本次只新增本文件（`plans/host-pipeline-defects-design.md`），未改任何源码、测试、配置。
真机数据只做只读查询（`sqlite3 -readonly`、`ls`、`python3 json.load`），未写入 `graph.config.json`、未动 `state/` 下任何文件（见 §3 禁区、§1 P9 写保护）。
