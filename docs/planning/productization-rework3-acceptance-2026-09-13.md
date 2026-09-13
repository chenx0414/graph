# fe8e2c4 独立验收：零发送暂停已修复，部分发送后暂停仍阻塞

固定比较：`git diff 35118a5...fe8e2c4`。规格：原产品化待办与 `productization-rework2-acceptance-2026-09-13.md` 的 PA02-R2 关闭条件。

**结论：PA02-R2 的零发送暂停误报成功已修复；新增确认 PA02-R3（P1）：已有调用后暂停进入没有内置核查路径的 recovery。T01–T08 暂不整体关闭。**

## 独立验证通过部分

- 项目 Node 24.20.0：47 文件 / **218 项通过一次**，双 tsc、build、git diff --check 通过；包含正式 CLI/Chromium 集成。交付方“两次通过”不计作本方次数。
- 八个历史沙箱/监听探针当前实现保持预期；旧实现负对照的预期失败不算本提交失败。
- 修正版 `pause-resume-verified.mts` 按阶段断言：20 个排队节点暂停并收敛后 **0 请求、0 成功、后继 pending、全部操作 not_sent、名额归零**；恢复后 **20 请求、20 成功、后继成功、最大并发10、名额归零**。
- 接受交付方对旧探针末尾断言的说明：旧脚本把恢复前的“请求为0”条件放到了恢复后，确实与关闭标准冲突。本轮保存新探针、不改写旧历史探针，以每阶段独立断言为准。
- 20 节点正常恢复完成、独立 key B、配置版本、实时记录及 PA05 冲突保存探针通过。
- 专项审查的真实 TaskRuntime/Pi + 本地 HTTP400：有权威用量时保留50 tokens、failed结果、execution_failed问题、后继pending；无权威用量时保留unknown_usage与null用量、后继pending。模型错误不再误报成功。
- waiting_slot 写入不再吞错误，上一轮的正式状态写入建议已处理。

未调用付费供应商、未改产品源码、未改历史任务数据库。已通过部分与A13原有证据范围保留，T09/T10仍可选。

## Standards

**1 项 P1，与下述 PA02-R3 同一根因，不重复计数。**

新 `pi-adapter.ts` 在 session.prompt 返回后抛出 gateRefusal，finally 已负责关闭 session、能力与命令资源；Execution 的通用异常分支却将该操作记为 worker_active=1、result=null。正式状态没有反映已完成的本地清理，且内置 Pi 没有对应 reconcile 实现。与 ADR0003 程序维护状态一致性、ADR0007 持久化恢复事实、原待办的暂停/恢复闭环要求不符。

已知 invocation 用量仍在账本中，**不能声称50 tokens被删除**；问题是结果及静止事实未传递到可结算/恢复路径，实例 used 仍为0且操作保留预留。

## Spec

### PA02-R3 · P1 · 已有调用后暂停，恢复与核查均无法推进

位置：`src/runtime/pi-adapter.ts:196` 的 gateRefusal 抛出；`src/core/execution.ts:489–518` 的 noInvocations 分支与通用异常处理；`Execution.reconcile()` 对缺少 adapter.reconcile 的拒绝。

**独立复现**：`partial-pause.mts` 使用真实 TaskRuntime、生产 Pi 适配器和本地合成 provider。第一轮请求已被接受，返回工具调用及权威50 tokens；在返回前请求用户暂停。下一轮模型发送被暂停门拒绝。等操作离开发送状态后读取事实，再用户恢复并尝试宿主核查。

观察：

```text
providerRequests: 1
invocation usage: input25 + cacheRead15 + output10 = 50
operation: unknown, workerActive:true, result:null, reserved:2000000
task while paused: pausing
work node: blocked, used:0
user resume -> dispatched:0，work仍blocked，check仍pending
host.reconcile -> reconciliation_unavailable
```

本探针不声称工具已产生文件效果；它证明已有权威模型调用后，下一次发送前被拒的场景。账本保留先前调用，当前却没有可用的内置恢复路径。仅把“无 invocation”作为 not_sent 条件是正确的安全约束；不能通过删除 invocation 或把整个操作改为未发送来修复此问题。

**原因**：`quiescent` 只在 `await dispatch()` 正常返回后设为true。适配器通过异常上抛门拒绝，即使其 finally 正常清理，Execution 仍用false记录 workerActive。已有invocation不符合新not_sent条件，于是结果为空并开recovery。生产Pi adapter未提供reconcile，用户恢复不运行blocked节点，现有问题答复也不能完成此核查。

**实现建议**：把部分执行后的暂停作为有证据的结果/状态交接，保留既有调用用量、会话和可能的工具效果，并明确worker是否已停止；提供能继续原实例的正式路径。没有权威用量时仍保留unknown_usage及可用核对入口，不把未知折零。不能只把workerActive清零而仍无恢复入口，也不能把部分完成冒充整体成功。

**关闭标准**：

1. 已知50 tokens的第一次调用后暂停，后续不发送；本地清理完成后不虚报worker仍活跃，先前invocation保持。
2. 使用产品支持的恢复/核查路径，原实例可继续并最终完成；已知用量最终准确累计一次，预留和名额释放，后继仅在工作真正完成后执行。
3. 覆盖暂停前工具已成功产生效果的多轮会话，恢复不盲目重复效果；未知用量继续阻塞并可通过现有认证答复路径处理。
4. 零发送暂停、20并发恢复上限、模型error、PA05配置与历史探针保持通过。无需昂贵供应商任务。

## 交付范围与证据

本轮只新增这一项阻断；PA01、PA03、PA04、PA05关闭结论保留，PA02的并发上限与零发送暂停修复保留。继续返工部分发送后的暂停/恢复，不重做产品。

[独立证据目录](acceptance-evidence/productization-rework3-independent/) 包含提交绑定、全量/历史探针、修正版阶段断言和部分调用反例。根目录运行 `./node_modules/.bin/node docs/planning/acceptance-evidence/productization-rework3-independent/partial-pause.mts`，退出0表示采集完成，需检查状态与reconciliation错误。

两轴计数：Standards 1项P1、Spec 1项P1，指向同一PA02-R3，合计一个返工项。

补强复验：`after-tool-pause.mts` 中首轮工具确实写入 partial.txt，第二次模型发送前暂停；主审重新运行同样得到 unknown/workerActive:true/result:null、恢复0派发、reconciliation_unavailable。输出与源码已保存，证明该问题也覆盖真实部分文件效果，而非仅有模型用量。
