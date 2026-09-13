# 35118a5 独立验收：PA05 关闭，暂停结果仍需返工

固定比较：`git diff 071e21b...35118a5`。依据原产品化待办及上一轮 `productization-rework-acceptance-2026-09-13.md`。

结论：**PA05 可关闭；PA02-R1 的并发上限及正常恢复完成路径通过，但暂停→恢复路径存在 P1 结果错误（PA02-R2），T01–T08 暂不整体关闭。**

## 独立验证

- 项目 Node 24.20.0，47 文件 / **217 项通过一次**，双 tsc、Vite build、git diff --check 通过。含正式 CLI、Chromium、凭据别名及配置回归。交付方三次全量不是本方运行次数。
- 原八个沙箱/监听探针本轮重新运行，当前实现均保持预期行为；旧提交的负对照失败仍为预期。原独立 B 分支、配置版本、实时记录探针保持通过。
- 扩展正常恢复探针：20 个节点先排队，释放后最大真实并发 **10**；最终 **20/20 succeeded、workerActive=0、credentialSlots=0、queued=0**，无死锁。
- PA05：正式 HTTP 保存冲突返回 **400 + credentials.a.sharedLimitGroupId**；同 secretRef、不同 secretRef 同值均拒绝，原配置字节与版本保持。旧有效配置可重启；手改冲突时查看控制台可启动且无自动供应商派发，execute 拒绝。显式连通性测试仍可主动发送，这是 T05 的既有功能，不将其当作自动调度绕过。
- 未改产品源码、未调用付费供应商、未改历史任务数据库。工作树仅新增本报告及证据。

## Standards

PA05 的启动/保存共用 `assertCredentialGroups()`，修复了上一轮已确认的配置校验不一致；本轮未确认新的 Standards 硬性阻断项。

保留改进建议：`pi-adapter.ts:79–81` 仍将影响正式调度的 waiting_slot 写入错误吞掉，并称其为 telemetry。应让这类失败进入可处理的失败路径，而不是掩盖；本轮未通过正常运行反例证明该分支导致新增故障，不另立阻断。

两名并行审查者提交了中间发现后因服务额度中止，不能声称两份全面审查均已完成。主审已独立完成上述验证和下述反例复验；PA05 审查者原始本地输出一并保存。

## Spec

### PA02-R2 · P1 · 暂停门拒绝未发送工作，却被结算为成功

**位置**：`src/runtime/pi-adapter.ts:178–187`；错误转换在 `src/runtime/controlled-openai.ts:145–162`，暂停拒绝在 `task-gate.ts`。

**复现步骤**：使用真实 TaskRuntime、Pi 适配器及本地合成 provider。将 20 个 Agent 节点阻塞在凭据名额队列；用户暂停任务，再释放合成占位。等待所有异步操作收敛、名额归零后读取任务。最后用户恢复并驱动任务。

**实际结果**：

- 暂停后实际 provider 请求 **0**，所有名额最终归零，但 Agent 节点 **20/20 succeeded**。
- 操作结果为 `outcome: completed`、`output: {text: ""}`、零 usage。
- 用户恢复后 provider 请求仍为 **0**，20 个节点被跳过，后继合成 check 已执行并 succeeded。

探针的 check 是用于观察依赖推进的合成程序，不把它产生的合成证据描述成真实 A13 交付。问题在于未执行的必需 Agent 工作被成功状态满足依赖。

**原因**：发送门正确拒绝了暂停期间的请求；受控流将拒绝转为 assistant error 事件。`session.prompt()` 正常结束后，适配器没有检查末次 assistant 的失败状态或传播发送门拒绝，直接返回 completed。于是执行程序走了正常成功结算。

这是本轮“恢复时暂停/取消”关闭条件内发现的问题；不声称它由 `35118a5` 首次引入。之前只验证暂停后不发送、名额归零，没有验证节点仍然可恢复执行。本轮扩展检查揭示了这一缺口。

**实现建议**：适配器区分真正完成、发送前因暂停/取消被拒、模型失败。发送前被拒的工作应保留可恢复状态，不能写成功结果或推进依赖；恢复时重新获取名额并执行。处理 provider error 时不能一律推断未发送或零用量，保留现有 unknown usage 规则；已有部分工具效果或已知用量不得丢失。

**关闭标准**：

1. 单节点和 20 节点在名额队列中暂停，放开占位并等清理完成后，实际发送 0、成功节点 0、后继未执行；名额归零。
2. 用户恢复后，每个节点实际运行并成功；20 节点最大并发 ≤10，凭据/共享组限制同时满足，后继只在真正成功后运行。
3. 同时覆盖获得凭据后等待执行名额期间的暂停，以及取消/模型错误不被误报成功；已知及未知用量不被错误清零或重复累计。
4. 原独立 key B 分支、20 节点正常完成、PA05 配置拒绝、浏览器和历史八探针继续通过。

## 证据与范围

[证据目录](acceptance-evidence/productization-rework2-independent/) 包含固定提交、全量/历史探针输出、正常完成探针和 `product-pause-false-completion.mts`。从仓库根目录运行：

```sh
./node_modules/.bin/node docs/planning/acceptance-evidence/productization-rework2-independent/product-pause-false-completion.mts --pause
```

该探针用于采集行为，退出 0 不代表语义通过；必须检查 `succeeded`、`providerRequests` 与恢复后的节点/操作结果。原始暂停探针曾在 drive() 返回瞬间检查名额，得到尚未收敛的计数；主审已改为等待 scheduler.active()=0，再读取状态并复验。正式发现依据清理完成后的稳定状态，不是瞬时名额泄漏。

PA01、PA03、PA04 既有认可保留，PA05 本轮关闭；PA02 并发上限修复保留，仅暂停结果路径返工。T09/T10 可选，A13 历史范围保留，无需重跑昂贵供应商任务。

两轴计数：Standards 无新增已确认硬性阻断；Spec 1 项 P1（PA02-R2）。
