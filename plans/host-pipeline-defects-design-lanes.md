# host-pipeline-defects 失败模式、车道归属与验证（续）

<!-- graph:table-writes-exempt: design document - it names the table in prose and writes nothing -->


本文件是 `plans/host-pipeline-defects-design.md` 的后半：§2 失败模式、§3 文件归属、
§4 碰撞点、§5 可观测落点、§6 各车道 E2E、§7 P2 验证。前半（§1 缺陷定位）留在原文。

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

**交付实况（19a3a266，经 main 复核批准）**：下表三个文件在原计划之外，也**不删**——
回退它们等于删掉 P9 写保护与 chatgpt 的可观察性。

| 表外文件 | 为什么必须留下 |
|---|---|
| `backend/internal/graph/server_config_service.go` | P9 写保护的落点：`OpenConfigStore(...).OwnStateDir(options.StateDir)` 让「写下本进程自己的 state 目录」可判定为自有；线上 App 以 `--state-dir <userData>/state --config <userData>/graph.config.json` 启动，两者对齐，所以 App 自己保存配置不会被拦，外来守护进程写同一文件被 400 拒绝且字节不变（`go-provider-api-vocabulary.test.ts` 第二例）。 |
| `backend/internal/graph/server_start_daemon.go` | 把 `options.StateDir` 传进配置存储，是上一条判定的数据来源；没有它，写保护无从判断「谁拥有这个配置」。 |
| `backend/internal/graph/server_providers_view.go` | chatgpt 收口的**可观察面**：`unsupported` + `unsupportedReason`（含替代平台）+ fallback，评审与 E2E 都从这里读，而不是靠调用被收口的平台。 |

`server_config_parse.go` 按计划一行未改，`provider=chatgpt` 仍在配置里被接受（只改分组名）：
拒绝它会打断 `provider-independent-reviews` 的既有回退验收；收口落在目录记录与交付 JSON 上。

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
