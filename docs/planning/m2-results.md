# M2 全部图模式与验证器

日期：2026-09-11。对应 [实施计划 G06–G08](../implementation-plan.md#m2-全部图模式与验证器)。基于 M1 的提交 `19511f7`。本轮在持久任务内核上实现版本化图、容器、回环、主管修订、连续调度、三类验证器与八种模板；生产 Pi、Git 集成和 Web 仍按原计划交付。

## 可运行结果

```sh
pnpm test:m2
pnpm check
```

最终复验中 `pnpm check` 通过：TypeScript 检查及 14 个文件、76 项测试，其中 M0 27 项、M1 22 项、M2 27 项。`git diff --check` 无格式错误。测试使用真实临时 SQLite、scripted 外部动作和新进程恢复，不调用收费模型。

## 入口及责任

沿用 M1 的 Task Runtime interface，并增加：

- `runtime.host.drive()`：持续派发就绪节点。某一节点完成后立即尝试独立后继，不必等待同一批次中的慢兄弟分支。`runReady()` 仍只等待当前批次，以兼容 M1 测试。
- `runtime.supervisor(taskId).revise({ baseVersion, reason, nodes, containers?, loops?, requestId })`：确认后的受限图修订。验收门槛仍来自已确认提案，不能经此入口改写。
- 内建程序动作 `graph.verify`：由内核调用 `evaluateVerifier`，经过同一暂停门、程序名额、意图日志和结果结算。调用方注册的普通 adapter 不能覆盖它。

模板模块 `src/core/templates.ts` 只生成普通节点、容器和回环数据，复用同一调度器。

## G06 — 版本化图、激活与子图

| 出口 | 证据 |
| --- | --- |
| 顺序、条件路由、扇出扇入、嵌套可运行 | `tests/m2/graphs.test.ts` 嵌套路由；`tests/m2/templates.test.ts` 流水线/扇出/路由 |
| 同节点回环不重建实例 | `tests/m2/loops.test.ts` 返工后 `instanceId` 不变，额度累计 |
| 旧循环成功不能错误放行新循环 | 第二轮检查看到更高的 `outputVersion`；旧验收证据在新轮次不再作为当前有效证据 |
| 等待后的激活仍在全局 10 名额内 | `tests/m2/scheduling.test.ts` 嵌套工人与主管峰值不超过 10 |

容器没有 Agent 实例；未选路由分支记为 `skipped` 且不派发。产物 activation、operation、SHA-256 和输出版本跨数据库重开保留。

## G07 — 主管等待与返工循环

| 出口 | 证据 |
| --- | --- |
| 慢分支不阻塞独立后继 | `host.drive()` 下 `afterFast` 在慢兄弟仍 `workerActive` 时已成功 |
| 主管恢复不造成第 11 个活跃 Agent | 11 个工人依赖主管计划，峰值 ≤ 10；M1 主管等待释放名额仍然成立 |
| 无实质进展有具体阻塞证据 | 连续三轮相同失败形成 `stalled` 问题，附 blockers 与 resume 目标 |
| 耗尽工作不能换名或新建实例逃逸 | 修订删除额度耗尽且未完成的节点被拒绝；`resume` 不能清除预算问题 |

回边与前向依赖分开：前向图仍校验为 DAG，返工对原节点创建新激活，受影响下游失效，输入未变的成功兄弟分支不重跑。进程重启后未完成的回环沿用原实例继续。

## G08 — 三种验证器与预设模板

| 出口 | 证据 |
| --- | --- |
| 有效阻塞反例不能被多数票压过 | 对抗式检查全部通过仍因未解决有效反例返工 |
| 必需维度不能跳过 | 建议项失败不阻塞；缺失/旧产物引用成为返工而非不明外部结果 |
| 全部候选不合格返工 | 评委硬性要求全部失败不产生 winner |
| 胜者吸收后重新验证 | 复验门依赖吸收产物；沿用候选旧 digest 不能通过 |
| 模板可嵌套且不另建调度器 | 八种模板生成普通图数据，均由 `host.drive()` 跑完 |

合法否决的外层 `OperationResult.outcome` 为 `completed`，`output.outcome` 为 `rework`，不带验收证据。这表示检查执行完成、工作需要返工，不会被当成通过，也不会记为外部结果不明。

## 持久化

schema 升级到版本 7：`graph_revisions.base_version`、`nodes.stall_count`、`activations.progressed`。图版本不可覆盖。退役节点保留历史；新激活不能与旧激活并行。

## 本轮边界

M2 使用 scripted adapter 验证机制。生产 Pi/模型目录、自动 Git 集成和 Web 分别在 M3–M5。主管规划对话、真实模型切换和代码合入仍待后续工作包。
