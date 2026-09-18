# Fresh 前驱交接策略独立验收：不关闭，带可分派返工

日期：2026-09-18。被测分支 `feat/app-ux`。规格提交 **`23ab134614fca9ec462d3c1cd707b6b2a6763501`**（`docs: research fresh predecessor handoff policies`），实现提交 **`4bd01e9d0b80d71db6d05d3e6f572e2c73195e84`**（`feat: add fresh predecessor handoff policies`）。HEAD 即实现 SHA。工作树 `/Users/macmini/workspace/13-Graph`。固定比较：`git diff 23ab134...4bd01e9`。

依据 [Fresh Agent 前驱交接策略研究](fresh-handoff-policy-research-2026-09-18.md)「建议验收」1–10、「校验与 fail closed」和「推荐决策」1–8。研究当时未形成 ADR；实现也未补 ADR。审查身份：独立验收，不是实现方。未改产品源码、未合入、未发布、未调用付费模型。

| 审查轴 | 结论 | 剩余缺陷 |
| --- | --- | --- |
| Standards | 有条件通过 | S01 术语未进 CONTEXT.md；节点详情残留 `bytes` / schema 英文 |
| Spec | 不通过 | R01 省略边默认与强制覆盖相反；R02 缺 `context.rejected` 与规定事件；R03 禁止从审查源出结果交接 |

**整包不关闭。** 显式 `result_handoff` 边能把结构化摘要注入下游 Fresh，审查边在 proposal 层拒绝 `result_handoff`，缺失提交会挡住下游模型请求。但省略边被静默填成 `evidence_only`（普通流水线默认反了），缺失交接不写 `context.rejected`，并且「验证结论 → 返工实现」被实现闸死。

## 规格钉住的交付

1. `evidence_only` / `result_handoff` 是 Fresh 的一等边策略；不复制前驱 transcript。
2. Main Agent 在 proposal 中**逐 incoming 边显式选择**；Fresh 节点全部 incoming 依赖必须有 policy。
3. 普通实现流水线**默认** `result_handoff`；独立 review/verify / `model-excluded` **只能** `evidence_only`。
4. 前驱只生成一份冻结 `ResultHandoff`；证据边不投影 `workSummary`。
5. 缺失、过期或 digest 不匹配 fail closed：下游不发模型请求，并产生 `context.rejected`。
6. 事件：`context.handoff_policy_selected`、`context.result_handoff_frozen`、`context.evidence_only_frozen`、`context.result_handoff_missing`、`context.handoff_rejected`。
7. 多前驱可混用；容器依赖展开到 leaf；返工后旧 handoff 失效。
8. UI 显示 policy、source operation、outputVersion、schema、digest。
9. Fork digest / 共享预算不回归。

## 本次独立验证

- Node **24.20.0**；`node --run typecheck`、`git diff --check 23ab134..HEAD` 均为 rc=0。
- 针对测试 **15/15** 通过：`context-model`（10）、`schema-upgrade`（3）、`node-detail-ui`（2）。
- 全量第一轮 **86 文件 / 450 项**：**1 失败**（`tests/m8/app-shell-ux.test.ts` 作曲家三次 Enter 转向，poll 超时）。该文件不在本 diff 内。单独复跑同一用例 **390ms 通过**，记为偶发 flake，不记本包缺陷。
- 生产夹具：`WORK_SUMMARY_SENTINEL` 出现在下游第三轮 provider 请求；缺 `submit_result` 时 `provider.requests.length === 1`，下游未派发。
- 源码探针：省略 `predecessors` 时 `validatePredecessorPolicies` 直接 `continue`，运行时默认 `evidence_only`；`settleResultHandoff` 把前驱标 `result_handoff_invalid`，无 `context.rejected`；事件名为 `context.predecessor_policy_selected`。
- v13/v17 升级链含 schema v24 `result_handoffs` 仍绿。
- 跟踪工作区干净。

证据：[fresh-handoff-independent](acceptance-evidence/fresh-handoff-independent/)。

## 已关闭（本轮可保留）

| 建议验收 | 结论 | 独立证据 |
| --- | --- | --- |
| 1 流水线读取结构化摘要 | **关闭（显式边）** | `context-model`：`provider.requests[2]` 含 `WORK_SUMMARY_SENTINEL`；`result_handoffs.digest` 64 hex |
| 3 review 使用 result-handoff 被拒 | **关闭** | proposal 抛 `/require evidence_only/` |
| 4 缺失时下游不发模型请求 | **部分** | 请求数=1；无 `context.rejected`（见 R02） |
| 8 UI 记录 source/operation/version/digest | **关闭（有显式 policy 时）** | NodeDetail「结果交接 / 仅证据交接」；图边标签中文 |
| 10 Fork digest/预算不回归 | **关闭** | 既有 fork 相等 digest、共享 scope；policy digest 失配 fail closed |

## Standards

### S01 — 硬违规（P2，可随 P1 一起改）

`docs/agents/domain.md`：领域名称进 `CONTEXT.md`。本 diff 引入 `PredecessorHandoffMode` / 结果交接 / 仅证据交接，术语表未更新。

NodeDetail 新块仍有用户可见 `bytes`、`result_handoff@1`。图边「仅证据」与详情「仅证据交接」用词不一致。

`predecessor-handoff.ts` ~423 行、NodeDetail ~405 行，超过 200–400 典型值，未到 800。

**Standards 统计：硬 1（术语/文案），判断若干。不单独阻塞关闭，但 P1 返工时应一并修。**

## Spec

### R01 — 实现错误（P1）

规格：「proposal 必须覆盖全部会向 Fresh 输入的依赖 leaf」；「Main Agent 必须按具体边显式决定」；「普通实现流水线默认 `result_handoff`」。

`validatePredecessorPolicies` 在 `predecessors` 为空时跳过。`predecessorPoliciesForNode` 把未声明边填成 `evidence_only`。`ContextRequest` 注释也写了这个默认。

结果：普通 `dependsOn: ['work']` 且不写 `context.predecessors` 的实现流水线**永远看不到** `ResultHandoff`，与验收 1 的产品默认相反。图边也只标注显式 policy。

关闭标准：Fresh-capable Agent 的每个 incoming 依赖必须有 policy，否则 `invalid_proposal`。未写明时的产品默认改为 `result_handoff`（审查/verify/`model-excluded` 除外，仍强制 `evidence_only`）。补测试：省略 policy 的实现下游 proposal 失败或按默认生成结果交接。

### R02 — 实现错误（P1）

规格验收 4：「缺失时 downstream 不发送模型请求，并产生 `context.rejected`」。事件表含 `context.result_handoff_missing`、`context.handoff_rejected`、`context.evidence_only_frozen`、`context.handoff_policy_selected`。

现状：前驱 `settleResultHandoff` 把 operation 改成 `failed` / `result_handoff_invalid`，问题挂在**前驱** `execution_failed` 上。下游确实不发请求。没有 `context.rejected`。实现事件是 `context.predecessor_policy_selected` + `context.result_handoff_frozen`。Continue/Fork 仍发空的 policy_selected，未记录「policy 不适用」。

关闭标准：下游 Fresh 在缺/过期/digest 不匹配时写 `context.rejected`（可另发 `result_handoff_missing`），阻塞该下游节点；不得静默降级为 evidence-only。补测试断言事件类型与 `questions[].nodeId === 'next'`（或规格等价的下游 id）。

### R03 — 实现错误（P1）

规格场景表：「验证结论 → 返工实现 | `result_handoff`」。

`validatePredecessorPolicies` 禁止 **source** 为 review/verify / 非 `none` independence 的节点作为 `result_handoff` 来源。审查**入边**强制 evidence_only 是对的；审查**出边**给返工实现被一并禁掉。

关闭标准：只禁止审查节点的 **incoming** `result_handoff`。允许 verifier → rework 实现边为 `result_handoff`。补 proposal 正反用例。

### R04 — 部分缺失（P2）

验收 2：evidence-only 投影单测隐藏 `workSummary`；没有生产路径断言审查模型请求不含前驱 final text / tool history。验收 5–7、9：代码能展开容器 leaf、按 activation/outputVersion 查找，但无混合多前驱、容器、返工失效、超长正文拒绝的测试。未写 ADR。`independence === 'fresh'` 也被强制 evidence_only，规格只点名 `model-excluded`。

**Spec 统计：P1 3，P2 1。**

## 给第三方实现 agent 的返工包

工作位置：`/Users/macmini/workspace/13-Graph`，分支 `feat/app-ux`，基线 `4bd01e9`。不要改 `main`，不要付费供应商调用。不要重做已关闭的 fork digest / 共享预算 / ADR 0013。只修本报告 P1；P2 与 S01 建议同一提交带上，以免再开一轮只为术语表。

### P1-A  显式边 + 流水线默认

- Fresh Agent 每个 `dependsOn` 必须有 `context.predecessors` 条目，否则 `invalid_proposal`。
- 若产品选择「可省略并默认」：省略的**实现**边默认 `result_handoff`，审查边默认 `evidence_only`；并在 proposal 冻结后的 digest 里留下实际生效 policy。不要继续把实现边省略成 evidence_only。
- 补测试覆盖省略边。

### P1-B  缺失交接的事件与阻塞点

- 缺 `ResultHandoff` / digest 失配：下游节点 `context.rejected`，不发该节点模型请求，不自动降级。
- 对齐或别名规格事件名；至少独立复验能搜到 `context.rejected`。
- 前驱因未提交而失败可以保留，但验收 4 的观察点是下游拒绝事件。

### P1-C  审查出边

- 删除「审查源不能作为 result_handoff 来源」闸。
- 保留「审查节点 incoming 必须 evidence_only」。
- 用例：`review → rework` 的 `result_handoff` proposal 合法。

### P1-D  术语与文案（S01）

- `CONTEXT.md` 增加前驱交接策略、结果交接、仅证据交接。
- NodeDetail 去掉裸 `bytes`；统一「仅证据交接」。

### 验证命令

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
node --run typecheck
./node_modules/.bin/vitest run tests/console/context-model.test.ts tests/console/schema-upgrade.test.ts tests/console/node-detail-ui.test.ts
./node_modules/.bin/vitest run
```

全量必须绿。若 `app-shell-ux` Enter 转向再失败，先单独复跑一次排除 flake，再判断是否回归。不要把 `master-agent-entry/*.png` 噪声提交进来。

### 关闭标准（下一轮独立验收）

1. typecheck + 全量 vitest 绿。
2. 省略 policy 不再把实现流水线变成静默 evidence_only。
3. 缺 ResultHandoff 时有 `context.rejected`，下游请求数为 0。
4. `review → implement` 的 `result_handoff` 合法；`implement → review` 的 `result_handoff` 仍非法。
5. CONTEXT.md 有对应术语。
6. 诚实清单：容器/多前驱/返工/审查模型请求不含 workSummary 的生产夹具若未做必须写明。

## 已认可限制（不作为本轮 P1）

- 研究明确未冻结 DB 迁移号与 ADR 文件名；v24 `result_handoffs` 可接受，但下一轮应补 ADR。
- OpenAI handoff ≠ Graph 前驱交接；本包未引入控制权转移。
- 全量第一轮 app-shell Enter 转向失败，复跑通过，不记缺陷。

## 收尾

未修改产品源码。本报告在 `docs/planning/`；独立证据目录匹配 `*-independent/` gitignore。

**两轴统计：Standards 硬 1；Spec P1 3、P2 1。整包不关闭。**
