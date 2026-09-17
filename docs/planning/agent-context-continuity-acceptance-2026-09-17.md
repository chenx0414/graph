# Agent 上下文连续性独立验收：不关闭，带可分派返工

日期：2026-09-17。被测分支 `feat/app-ux`。规格提交 **`6009313dcc74387691b6f1746799192640c4a23f`**（`docs: research agent context continuity`），实现提交 **`1ff37bdedec0b81d53165f702ee71f69e7fbec2e`**（`feat: build agent context continuity and MCP networking`）。HEAD 即实现 SHA。工作树 `/Users/macmini/workspace/13-Graph`。固定比较：`git diff 6009313...1ff37bd`。

依据 [Graph Agent 上下文模型一手研究](subagent-context-model-source-research-2026-09-17.md) MVP 边界、[ADR 0014](../adr/0014-agent-context-continuity.md)。同提交另含 [ADR 0013](../adr/0013-capability-declared-mcp-network.md)，作为附加范围单独判定。审查身份：独立验收，不是实现方。未改产品源码、未合入、未发布、未调用付费模型。

| 审查轴 | 结论 | 剩余缺陷 |
| --- | --- | --- |
| Standards | 不通过 | S01 用户可见英文文案；execution.ts 已超 800 行 |
| Spec（ADR 0014 / 研究 MVP） | 不通过 | R01 fork digest 只记不闸；R02 事件/continue 语义；R03–R05 模型未写完 |
| Spec（ADR 0013 MCP 联网） | **关闭** | 无阻塞项 |

**上下文连续性整包不关闭。** Continue/Fresh/Fork 骨架、v22 表、共享预算和 `createBranchedSession` 已独立复验；关闭条「prompt 前比较 source/child digest 并 fail closed」以及 `context.rejected` 事件未满足。MCP 联网按 ADR 0013 可单独视为关闭。

## 规格钉住的交付（上下文）

`6009313` 是研究；关闭合同是 ADR 0014 + 研究「MVP 应实现」：

1. `ContextHandoffVersion`、`AgentContextBinding`、`ContextResolution`、`BudgetScope`；schema v22。
2. continue / fresh 全套 lineage 与事件：`context.requested`、`context.mode_selected`、`context.handoff_frozen`、`context.branch_created`、`context.branch_resumed`、`context.rejected`、`review.independence_checked`；与 operation 同一事务。
3. Fork 只做一次 `createBranchedSession` 快照，新 session file / 新 session ID；禁止两进程写同一 file。
4. 任何新 prompt 前比较 source/child `buildSessionContext()` canonical digest；不一致 fail closed。
5. Fork 默认同一 definition / capability / model；不同必须显式 rebrand；共享 `BudgetScope`，禁止用 fork 重置额度。
6. 独立审查必须 Fresh + evidence-only + 既有模型排除；`independence != none` 不得带 `transcript_range` / `tool_call`。
7. mode 由 Graph resolver 选择，模型只能提交 purpose / facts / independence。
8. Fork 写入使用独立工作副本。
9. MVP 不做递归 fork、同 file tree UI、并发写 session、缓存承诺。

## 本次独立验证

- Node **24.20.0**；`node --run typecheck`、`git diff --check 6009313..HEAD` 均为 rc=0。
- 针对测试 **30/30** 通过：`context-model`、`restricted-process`、`capabilities`、`resource-catalog`、`schema-upgrade`、`node-detail-ui`。
- 全量 **82 文件 / 425 项通过**，本次独立执行一轮，71.67 秒。
- 源码探针（非实现方测试）：
  - `pi-instance.ts` fork 路径计算 `sourceContextDigest` 与 `childContextDigest` 后写入 manifest，**不相等时不抛**。
  - `context.rejected` 只是 `RuntimeError` code，随后 `adapter_error` block，**没有** `store.event(..., 'context.rejected', ...)`。
  - `recordContextSession` 在尚无 `source_context_digest` 时发 `context.branch_resumed`，首次 Fresh 也会走这条。
  - 节点详情 / 图 / App 出现 `source leaf`、`handoff`、`fork agent`、`Fresh · review`。
- v13/v17 真实 sqlite 升级链仍绿（含 v22）。
- 全量测试弄脏 9 张 `master-agent-entry/*.png`，已按被测 HEAD 恢复。跟踪工作区干净。

证据：[agent-context-independent](acceptance-evidence/agent-context-independent/)。

## 已关闭（本轮可保留）

| 项 | 独立证据 |
| --- | --- |
| Resolver 不接受模型写 `mode` | `validateContextRequest`；proposal 含 transcript 的独立审查被拒 |
| Fork = `createBranchedSession`，新 session ID | `context-model.test.ts`：`fork.session.sessionId !== source.session.sessionId` |
| source/child digest 被记录且本次夹具中相等 | 同测试 `childContextDigest === sourceContextDigest` |
| Fork 共享 BudgetScope，不能靠新实例逃额度 | 同测试 scope 行数=1；`assertWithinBudget` 跨实例合计 |
| 独立审查不得继承 transcript | proposal 校验 + `resolveAgentContext` 抛 `context_rejected` |
| Continue = 已有 session 再跑 | `instance.session_id` 存在则 `mode: 'continue'` |
| 生产仍一 operation 一 Pi 进程 | 既有 `openPiProcess` 路径；全量仍绿 |
| schema v22 升级 | `schema-upgrade.test.ts` v13/v17 |
| **ADR 0013 MCP 联网** | 本地 MCP 只达声明域名；未声明无网；unrestricted 可出站仍不能 bind；并发无网 worker 不借代理；scan 拒 URL/`*`；有网 MCP 要 `mcp:id:tool` grant |

上一轮能力包 P1（v2 digest 缺省 fail-open）在本 HEAD 上仍有 `pi-process.test.ts`「production process path requires and verifies the persisted capability digest」，未在本 diff 范围内回归验收，不记入本包关闭。

## Standards

### S01 — 硬违规（P1）

用户可见文案须中文。

- `src/web/NodeDetail.tsx`：`source leaf` / `source` / `child` / `handoff`；pill 直接渲染 `purpose`、`independence`、`reasonCode`。
- `src/web/App.tsx`：`Fork ·`、`Fresh · review`、`Fresh · ${independence}`。
- `src/web/GraphCanvas.tsx`：`fork agent` / `fresh agent`。

修复：中文标签（例如「Fork 快照」「Fresh 独立上下文」「来源叶」「交接摘要」），枚举映射中文，补 UI 断言。

### S02 — 硬违规（P2，随手可收）

`src/core/execution.ts` 已超过 800 行上限；本提交把 handoff 事件 INSERT 继续堆进去。新协议应留在 `context.ts`。

判断项：`context.ts` ~450；`capabilities.ts` / `restricted-process.ts` 变大但仍 <800。`setInstanceBudget` 改共享 scope 上限（见 Spec R05）。

**Standards 统计：硬 2（S01 阻塞文案，S02 文件体量）。**

## Spec

### R01 — 实现错误（P1）

规格：「在任何新 prompt 前比较 source/child 的 `buildSessionContext()` canonical digest」；「validate child context equals frozen source context」。

`openPiInstance` 在 `createBranchedSession` 后只把两个 digest 写入 `contextInfo`，不相等也不拒绝。实现方测试只覆盖相等的成功路径。

关闭标准：不相等立即 fail closed，不发模型请求。补测试：人为改坏 source leaf 或 child 文件后打开 fork，抛错且 provider 请求数为 0。

### R02 — 实现错误（P1）

规格事件表含 `context.rejected`；`context.branch_created` / `context.branch_resumed` 语义分开。

现状：拒绝变成 `adapter_error`；首次 Fresh 发 `branch_resumed`；binding.mode 只有 `fresh|fork`，continue 被回填成 fresh。

关闭标准：

- 结构失败写 `context.rejected`（payload：`reason`、`requiredFacts`、`policy`），节点进入可观察的上下文拒绝，而不是笼统 adapter_error。
- 仅当 fork 首次得到 `sourceContextDigest` 时发 `branch_created`；continue 恢复发 `branch_resumed`；纯 Fresh 首次不要冒充 branch_resumed。
- 解析结果 `selected_mode=continue` 必须能在 UI/投影里与初始 fresh 区分（resolution 表已有 continue，binding 不要把 continue 实例标成 fresh 作为唯一事实）。

### R03 — 部分缺失（P2）

规格 SQL：`model_policy_digest`、`tool_policy_digest`、`constraints_digest`、`UNIQUE(task_id,version)`、`BudgetScope.root_task_id`。v22 有表但字段不全；handoff `version` 恒为 1。Fork 无 rebrand 时只比 model + definition +（源已有才比）capability digest；源 digest 为空可静默分叉（`pi-adapter.ts` `sourceBinding?.capability_digest &&`）。

### R04 — 部分缺失（P2）

规格：Fresh handoff 缺 acceptance / decision / artifact / output schema 应 fail closed；独立审查要正式 `ReviewIndependencePolicy`。现状：handoff 包就是 briefing 快照，缺项不闸；独立性主要靠 catalog `review: true`，不是凡 `purpose=review|verify`。Briefing 对审查不注入父 transcript，模型排除仍在，作为限制可接受，但不能标「独立策略已一等化」。

### R05 — 部分缺失（P2）

`setInstanceBudget` 会改写共享 `budget_scopes.limit_tokens`，一个实例改预算会动同源 scope。规格是共享上限、禁止重置已用量，不是让 fork 改写源的天花板。递归 fork 未禁（只要求源节点已成功）。

### 范围蔓延

同提交落地 ADR 0013（研究 6009313 未要求）。判定：**合格附加项，单独关闭**，不要当成上下文 MVP 已完成。图上标 fork/fresh 不是同 file tree UI，可接受。

**Spec 统计：P1 两条（R01、R02）；P2 三条；ADR 0013 关闭。**

## 给第三方实现 agent 的返工包

工作位置：`/Users/macmini/workspace/13-Graph`，分支 `feat/app-ux`，基线 `1ff37bd`。不要改 `main`，不要删其他 feature 分支，不要付费供应商调用。不要重做 ADR 0013 已关闭的联网路径。只修本报告 P1；P2 除非用户扩大范围。

### P1-A  fork digest 闸门

- `openPiInstance`：`sourceContextDigest !== childContextDigest` 时抛错，在 `prompt` 之前，且不写成功 binding。
- 测试先红后绿：成功 fork 仍相等；不相等 fail closed、无 provider 请求。

### P1-B  事件与 continue 语义

- 新增 `context.rejected` 事件（与 operation 失败同一事务边界，或明确先事件后 block）。
- 修正 `recordContextSession` 的 created/resumed 判定。
- 投影/UI 用 `selected_mode` 表达 continue，不要把已有会话显示成「Fresh 独立上下文」。
- 测试：审查带 transcript 的 proposal 仍拒；运行时拒绝可在事件流看到 `context.rejected`；主 Agent 第二轮 `selectedMode === 'continue'`。

### P1-C  中文 UI（S01）

- 改 NodeDetail / App / GraphCanvas 用户文案。
- `tests/console/node-detail-ui.test.ts` 或图测试断言中文，禁止 `handoff ` / `fork agent` / `Fresh ·`。

### 验证命令

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
node --run typecheck
./node_modules/.bin/vitest run tests/console/context-model.test.ts tests/console/node-detail-ui.test.ts tests/m0/restricted-process.test.ts tests/m3/capabilities.test.ts tests/console/schema-upgrade.test.ts
./node_modules/.bin/vitest run
```

全量必须绿。若 vitest 再次改 `docs/planning/acceptance-evidence/master-agent-entry/*.png`，按当前 HEAD 恢复，不要把截图噪声提交进来。

### 关闭标准（下一轮独立验收）

1. typecheck + 全量 vitest 绿。
2. fork digest 不相等 fail closed，且无模型请求。
3. `context.rejected` 事件可查；首次 Fresh 不再发 `branch_resumed`；continue 在节点详情为「继续原会话」。
4. 用户可见界面无本报告列出的英文标签。
5. 诚实清单：P2（完整 policy digest、handoff 缺项闸门、ReviewIndependencePolicy、共享预算改写、递归 fork）若未做必须写明，不得标已完成。
6. 不得回退 ADR 0013：未声明域名仍无网；unrestricted 仍不能 bind。

## 已认可限制（不作为本轮 P1）

- 未做真实付费账单上的 fork cache 行为（研究已标未验证假设）。
- 未做递归 fork、branch merge、同 file tree UI、session GC。
- 无 Git 项目时写入隔离沿用既有 per-instance worktree，本包未单独立项。
- ADR 0013 的 `${ENV}` 主机解析在 catalog 扫描测试中有覆盖；未对每个云厂商做联网实测。

## 收尾

未修改产品源码。本报告在 `docs/planning/`；独立证据目录匹配现有 `*-independent/` gitignore。跟踪工作区在复原截图后干净。

**两轴统计：Standards 硬 2；Spec P1 2、P2 3。上下文整包不关闭。ADR 0013 关闭。**
