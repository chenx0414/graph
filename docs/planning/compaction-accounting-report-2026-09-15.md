# 打开 Pi 压缩并把每次摘要请求记进 Graph 账本（K01–K05）

日期：2026-09-15。工作树 `/Users/macmini/workspace/graph-unified-dev`，分支 `feat/unified-console`，基线 `c3ee716`（开工 HEAD 未回退）。源码 SHA：`66992463aa22eb1d328ed1362946d21f624bc02c`（`feat: open Pi auto-compaction…` `0a96080` + `test: prove real auto-compaction…` `6699246`）。

## 交付内容

### K01 生产打开 Pi auto-compaction

- 新增 `src/runtime/compaction.ts`：唯一入口 `compactionSettings(entry)`，只依赖当前模型的 `contextWindow`/`maxTokens`：
  - `reserveTokens = min(16384, max(maxTokens, 1024), max(256, floor(window/2)))`
  - `keepRecentTokens = min(20000, max(1024, floor(window/4)))`
  - `enabled: true`
  - 第二个 `min`/`max` 让「小于 1024 的小窗口」仍留有可用储备（触发点不会变成负数而每次空压），大窗口不会被 16k 默认储备撑爆。
- `src/runtime/pi-adapter.ts` 的 `openPiInstance(...)` 现在传 `compaction: compactionSettings(entry)`；工人、审查、主管走的是同一处 `prepare()`，因此三类会话都开。
- `retry` 保持 `{ enabled: false, provider: { maxRetries: 0 } }`（`pi-instance.ts` 未改），摘要请求仍通过 `controlledOpenAIStream(observedGate, …)`。

### K02 记账：每次摘要 HTTP 都是一条 invocation

- schema **v20**：`invocations.purpose TEXT NOT NULL DEFAULT 'completion'`；store 版本上限 19 → 20。
- `task-gate.ts` 新增 `InvocationPurpose = 'completion' | 'compaction' | 'branch_summary'` 与 `gate.setPurpose(...)`（非法值报 `invalid_input`）；`dispatch` 的 INSERT 写入当前 purpose，`settle` 的 usage/cost 逻辑不变，所以摘要调用和对话调用共用暂停、未知用量、额度三门，也共用 `total()` → 实例 `used`。
- `pi-adapter.ts` 监听 Pi 事件：`compaction_start` → `setPurpose('compaction')` + 事件 `session.compaction_started`；`compaction_end` → 复位 purpose，并把摘要写成 `node_entries`（`role:'system'`、`kind:'compaction'`，data 带 reason/tokensBefore/tokensAfter）+ 事件 `session.compacted`。分裂回合在同一个 start/end 之间产生两次 HTTP，因此两条 `purpose='compaction'`。
- 主管 `chatting`（`persistEntries === false`）不写节点条目，只记 invocation 与 `session.compacted` 事件；对话消息表由内核照常写，压缩不覆写历史。`branch_summary` 作为受支持的 purpose 值由 gate 校验并落库（产品没有 `/tree` 入口，见下）。

### K03 详情可看，且不承诺无限上下文

- `node-run.ts` 的 invocation 投影带上 `purpose`。
- `src/web/NodeDetail.tsx`：`kind:'compaction'` 渲染成单独的「上下文摘要」行（`data-testid="entry-compaction"`，提示「窗口写满后的自动摘要，原始记录仍保留」），不与助手发言混淆；供应商调用标题显示「含 N 次摘要调用」；单条调用标「上下文摘要」。全仓 `src/web` 无「不限上下文/无限会话」文案。

### K04 负载与边界

`tests/console/compaction.test.ts`（8 条，生产 `openTaskRuntime` + 真实 Pi adapter + 本地 OpenAI SSE + 真实 SQLite，无付费 key）：

1. `compactionSettings` 三档（200k/8k、2048/256、512/128）。
2. schema v20 列与默认值。
3. 工人节点真实 `threshold` 压缩：provider 请求 2 次（1 对话 + 1 摘要）；invocations = 2 条 `completion`（能力/工具边界，0 用量）+ 1 条计费 `completion` + 1 条 `compaction`；compaction 行 usage 非空、cost 已知、model 为冻结身份；实例 `used` == 所有 invocation token 之和；`node_entries` 同时保留 briefing、assistant 原文与新的 compaction 行（`entryCount` 不减少）。
4. 分裂回合（主管 chatting 两轮，第二轮长文超阈值）：恰好 2 次摘要 HTTP → 2 条 `compaction`；对话消息表两条用户消息原样保留；每个实例 `used == Σinvocations`。
5. 冻结身份：`modelId:'original-model'` 时所有 invocation（含摘要）都记 `original-model`，不回退连接 id（R08）。
6. 暂停：在 `compaction_start` 之后暂停，摘要请求 0 次、无 `compaction` invocation，节点回到 `pending`，且 `session.compaction_started` 事件证明压缩确实被触发过。
7. 有限额度：用户把额度压到摘要预留之下，摘要 0 次、开 `budget` 问题。
8. 未知用量：摘要响应缺 usage → 1 条 `compaction`（usage 为 null）+ `unknown_usage` 挂起，且不会静默重试发出第二次请求。

`tests/console/node-detail-ui.test.ts` 增加 UI 断言（compaction 行 + 「含 1 次摘要调用」）。回归：`tests/console/schema-upgrade.test.ts` 版本断言 19→20；`tests/console/unlimited.test.ts` 的 v13 回滚补 `DROP COLUMN purpose`。

### K05 复现命令与证据

```text
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit                  # rc=0
./node_modules/.bin/tsc -p tsconfig.web.json --noEmit   # rc=0
./node_modules/.bin/vite build                    # rc=0
timeout 1200 ./node_modules/.bin/vitest run       # 75 files / 377 tests passed
./node_modules/.bin/node docs/planning/acceptance-evidence/compaction-accounting/compaction-fixture.mts   # rc=0
```

- 原始输出：`docs/planning/acceptance-evidence/compaction-accounting/verification.output.txt`（含两个 tsc、vite、全量 vitest，Node v24.20.0，rc 逐条记录）。
- K04 夹具输出：`docs/planning/acceptance-evidence/compaction-accounting/compaction-fixture.output.txt`（脚本 `compaction-fixture.mts`，rc=0）。夹具模型 `contextWindow=2048, maxTokens=256`：
  - provider 请求 **2** 次（`summary=false, tools=7` 与 `summary=true, tools=0`），即真实 `threshold` 压缩。
  - purpose 列表 `["completion","completion","completion","compaction"]`；后两条计费（对话 2000+40、摘要 900+30）。
  - `instanceTotals.used = 2970 == invocationTokenTotal`（摘要计入且只计一次）。
  - `compactionEntries = [{ role:'system', kind:'compaction', reason:'threshold', tokensBefore:2040, tokensAfter:1701 }]`；`originalEntriesKept = 2`；`entryKinds = ["user:briefing","assistant:message","system:compaction"]`。

## 诚实边界

- 未调用任何真实付费供应商；全部为本地 OpenAI SSE 夹具 + 合成 key。
- 未打开 Pi provider retry；`retry` 仍全关，摘要失败按现有失败/unknown 路径处理。
- 压缩后 Pi JSONL 会话文件仍是全量上下文来源；Graph `node_entries` 只增不减，但仍受 Pi 构建的请求上下文影响（下一轮不再发送被摘要掉的原文——本夹具可读请求 body 验证，见测试第 4 条语义以外的既有 M0 覆盖）。
- 审查节点与其他 Agent 走同一 `prepare()` 路径（compaction 已开），但本轮未单独构造「审查会话长到压缩」的用例。
- `branch_summary` 是 schema/gate 支持并已落库验证的取值；产品未接 `/tree` 分支导航 UI，因此没有用户流程产生该值（M0 已覆盖其走门语义）。
- 未合并 `main`、未发布、未改动 `13-Graph` 产品源码与验收方旧证据。是否通过由独立验收决定。
