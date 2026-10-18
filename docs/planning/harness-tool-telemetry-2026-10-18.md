# 补齐评测工具统计与常驻节点归属

本轮修复计量缺口，不改变发给模型的 prompt、工具 schema、模型、effort、角色或实验默认值；没有新增真实模型会话，没有补跑已停止的模型小集。它提高后续优化判断的可信度，尚不是每完成任务降本证明。

## 三处缺口和修复

1. `harness-real-eval.mjs` 与 `harness-worker-eval.mjs` 关闭 daemon 后直接让 harness-cost 只读 SQLite；子进程已保存的工具 spool 尚未归并。现在在终态收尾、关闭 store 之前调用公开 runtime 的 toolCallStats，再生成报告。原有 `/api/tool-stats` 使用同一服务，不另建解析器或统计账本。
2. 常驻 `resident-worker.ts` 未提供 openPiInstance 的 onToolCall，原有一次性 pi-worker 则已提供。现在接入相同的异步 spoolToolCall 观察钩子，记录真实工具名、耗时、错误与 target；钩子和写入失败不会改变工具执行。
3. TaskStore.recordToolCall 仅按 main 使用的 nodes 表找归属，遗漏当前 graph 的 kernel_nodes。现在 main 查找未命中时，从当前内核及 resolved binding 读取 task/node/role；独立 TaskStore 没有内核表时仍可记录，未知身份仍保留 null，不猜角色。

两个评测输出新增 toolTelemetry：成功完成统计读取为 collected=true；daemon 不可用、worker 未终止、收尾不完整或读取失败均明确记录未收集及原因/错误。该标记表示读取结果，不承诺硬杀进程、不可写文件系统等情况下的观察完整性。harness-cost 仍严格只读，新增 caveat 说明工具空表不证明零调用。工具统计失败不篡改业务验收与模型成本，调用方应将工具覆盖视为不完整。

## 真正的 CLI E2E

扩展原有 harness-eval-lifecycle owner，没有增加低层测试或测试专用 seam。真实子进程 CLI → daemon/runtime → Pi → 本地受控外部模型 → 真实 bash/read/持久化 → 独立业务验收 → 关闭后读取 cost-report.json。

- 正常修复、错误实现、缺失模型 usage 和带辅助模型的行均核对真实 bash 1 次、errors=0、任务覆盖 1。
- 主会话超时行先实际写出 observed.txt，再让模型响应等待并触发中断；关闭后该命令仍计数。该行从“第一请求尚未做事即超时”扩展为“已完成工具后超时”，期限足以执行第一条命令，不弱化终态及 usage 检查。
- 标准权限下的 worker 实际拒绝越界 read，再在隔离 worktree 修复 parser；报告保留 read 错误，SQLite 的正式归属为该 task / work / worker。全程没有伪造宿主业务回执。
- worker 在第一响应前超时、没有工具结果时，完成统计读取并返回实际空集合。

红灯 `/tmp/graph-eval-tool-rows-red.log`：业务错误实现行缺少实际 bash 统计。只补收尾后，`/tmp/graph-eval-tool-collection-green.log` 的主会话各行通过，worker 仍缺少记录；接入常驻观察后 `/tmp/graph-worker-tool-attribution-red.log` 真实出现 calls=1 但 tasks=0、taskReach=null，确认归属遗漏。补齐当前内核映射后 `/tmp/graph-eval-tool-collection-green-final.log`：生命周期与完整 graph 交付两个文件、13 测试通过，51.42 秒。完整交付用例保留真实提交、host check、独立 reviewer 与目标分支验收。

## 已结束真实轨迹的恢复核对

上一轮 parser A 的原始数据库 tool_calls 为空，spool 与 native session 各保留 43 条。使用 SQLite backup 创建一致副本，仅复制该副本所需 spool，在私有 view daemon 上请求公开 HTTP `/api/tool-stats` 两次；配置只有不可达的 localhost 模型，不启动执行，不访问真实供应商。原始评测状态不修改。

恢复结果为 43 调用、2 错误，全部归属原 main task / master / master：bash 29、read 10、get_agent_combination 2（均错误）、read_system_capabilities 1、list_projects 1。第二次读取不重复入库。复制状态的 25 次模型请求、tokens、模型身份、未知 usage/成本以及原状态的完整只读报告均保持不变；不借恢复统计把失败任务改成完成。

材料：`/tmp/graph-tool-spool-recovery-result.json`；副本位于 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-tool-spool-recovery-2zr8huuo`。原始状态及 [模型停止报告](harness-bound-model-tiering-result-2026-10-18.md)继续保留。

## 局限和回滚

常驻进程此前未生成 spool 的历史调用不会因新钩子自动补齐；仍需明确历史覆盖。归属来自归并时的 node/binding，本验证使用角色绑定不变化的会话，不证明历史重绑前后的逐调用模型归因。强制进程终止可能来不及完成异步观察，不能用计数零推断未执行。报告中的工具 reach 继续以有留存遥测的 task 为分母，不代表全部用户需求；模型 token、价格、任务质量与成本归因仍有原报告的限制。2026-10-18 只读重查原桌面 SQLite：最新事件 2026-10-13T15:13:33.153Z，留存工具 10,455 条，最新工具 2026-10-13T15:13:09.738Z；没有本轮修改后的生产使用证据，不据旧数据宣布线上收益。

回滚可撤销本提交的两个评测收尾、常驻观察与 TaskStore 映射；没有 schema 迁移、旧数据重写或生产重启。已经生成的统计仍保留；不把删账本作为回滚。

最终全量门禁 `/tmp/graph-eval-tool-collection-check.log`：272 文件、1,514 测试通过，356.51 秒；suite baseline 匹配，验收证据不变。仅扩展真正 E2E owner；已有低层测试仅随全量执行，没有改写。
