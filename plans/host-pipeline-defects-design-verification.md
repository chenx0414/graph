# host-pipeline-defects 碰撞点与验证（续）

<!-- graph:table-writes-exempt: design document - it names the table in prose and writes nothing -->


本文件接 `plans/host-pipeline-defects-design-lanes.md`：§4 碰撞点、§5 可观测落点、
§6 各车道 E2E、§7 P2 验证。

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
