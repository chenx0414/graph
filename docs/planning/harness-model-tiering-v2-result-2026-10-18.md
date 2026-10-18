# 完整资源模型分层 v2：首项停止结果

使用者明确批准最多四个 360 秒隔离 workflow，顺序 parser A、parser B、CLI B、CLI A，失败即停、不补跑。本轮仅执行 parser A，其余三项取消。**业务行为通过、正式 graph 完成，但最后 main operation 超时；按预先冻结的成功定义，完整任务失败。没有 worker 模型成本或质量比较结论，总体降本目标仍未达成。**

## 已发生的流程

main/planner 与实现 worker 均为 `opencode-go:deepseek-v4.1-flash`；独立 reviewer 为 `opencode-go:step-5-preview`，实际绑定为 work/worker、review/reviewer。冻结 v2 完整资源 main/coder/reviewer 为 14/6/5，377 项能力目录校验通过；所有实验开关为 0。1,490 项源码、文档及配置冻结校验在调用前后均通过；没有生产默认变更。

main 发布并经隔离 runner 确认 graph；实现与审查 execution 均 completed，重试/补交次数均 0。graph phase=completed，integration/target SHA 同为 `e404564f219a9a4047dfde25332a78d97223da8c`，项目独立 parser verifier=verified。第一 main operation succeeded；确认后的 main operation interrupted，worker_active=0，清理完整。

360 秒上限后 elapsedMs=360845，runner 的 completed=false、timedOut=true、taskSuccess=false。不能因子 graph 完成而改变本轮任务成功口径。成本报告的 completedTasks=1 是内部 graph 行计数，并非一个完整评测成功；主任务成功数为 0。

graph 完成后 main 继续状态查询及源码探索，末尾出现两次失败 get_task_status、inspect_rsi_status 和一次失败 apply_rsi_change。它们留在该次失败的成本和工具记录中，不从分子删除；没有借此继续修复、延时或补跑。源码清单结束校验仍一致。本记录描述观察，不把单次结果推断为某条文档或模型导致失败的因果证据。

## 整树用量与工具

| 实际模型 | 请求 | 已记录 input | output | cacheRead | 未知 usage |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeepSeek | 55 | 103948 | 31805 | 2543488 | 1 |
| Step 5 Preview | 12 | 15442 | 10450 | 201280 | 0 |
| LongCat 提示建议辅助调用 | 1 | 未知 | 未知 | 未知 | 1 |
| 合计 | 68 | 119390 | 42255 | 2744768 | 2 |

已记录 cacheWrite=0，estimatedUsage=0。LongCat 不是本轮 coding worker，而是冻结配置继承的 prompt_suggestion 辅助调用；事件记录 Request was aborted/stopReason=aborted。保持主角色绑定并不代表辅助模型不会调用；辅助请求也必须纳入整树。不能以零记录 tokens 把该未知用量算作零，不给 LongCat worker 质量结论。

68 请求的冻结费用均未知，严格成本=null。未知 usage 加上完整成功数为 0，使每完成任务价格情景也为 null；不拿已记录部分费用作为完整费用，不宣称降本。内部 graph 的 23 请求没有未知 usage，但排除 main/辅助后计算的局部成本不是本目标指标。

工具统计收尾 collected=true，共 90 次调用、6 次错误。错误来自 bash 1、get_resource 2、get_task_status 2、apply_rsi_change 1。工具 taskReach 的分母是 main 与 graph 两条内部任务记录，不是两次独立业务试验。68 请求均有逐工具结果 profile；wire 重发工具结果共 4,329,154 字节，其中 read 2,034,486、bash 719,705、read_system_capabilities 499,644、graph_inspect 371,818。它们是重发体积，不能直接分摊 cache/uncached 账单或换算节省金额。来源×billing 精确归因仍未解决。

## 已记录部分的角色价格权重诊断

沿用获批计划冻结的当日公开权重，仅为已记录 usage 计算角色小计（USD），不是发票或完整任务费用：

| 角色 | 请求 | 未知 usage | off-peak 已记录小计 | peak 已记录小计 |
| --- | ---: | ---: | ---: | ---: |
| main（含辅助） | 45 | 2 | 0.038121408 | 0.076242816 |
| DeepSeek 实现 worker | 11 | 0 | 0.004184256 | 0.008368512 |
| Step 5 独立 reviewer | 12 | 0 | 0.063785000 | 0.063785000 |

worker/reviewer 按真实 kernel_provider_calls 的 node/model/usage 汇总；main 已记录部分来自 owner task，未知 LongCat 辅助调用没有可计费 tokens，不能理解为零用量。cacheWrite 已记录0，不用缺失写价制造费用。原始计算在私有计划的 role-recorded-weighted-subtotals.json；它显式保留 completeTaskCost/costPerCompletedTask=null。

本样本已记录部分的实现成本小于规划/收尾与独立审查，不能套用其他团队“worker占69%以上”的比例，也不能用换免费 worker 推导整树数倍降本。机会排序应先看已出现的状态查询恢复和收尾探索，以及 reviewer 的实际任务/提示词成本；后者若改 prompt、模型或分工仍需原定 flag/提案边界。单次失败样本且未知用量未补齐，不支持生产模型替换或真实质量比较。

## 证据与边界

- 私有冻结计划：`/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-model-tiering-v2-6I16Wq`，包含人类批准记录、冻结配置/源码归档、parser-a.json、parser-a-observation.json、finished.json、result-audit.json；配置含凭据引用，不复制进仓库。
- 原始运行：`/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-T4OVCg`，保留 state、sessions、project、cost-report.json、execution-setup.json 及完整资源。
- 编排日志：`/tmp/graph-model-tiering-v2-live.log`。编排正常终止，finished.json attempted=1，剩余三项未调用，不自动恢复。
- 冻结资源逻辑摘要：`de57b345f76ce241c037d3eb2c3ca873372a1ee026d573c32e194fdde5034b39`。allRuntimeDependenciesProven 仍为 false，不宣称全部外部能力经过实际操作验证。

本轮没有修改运行代码或测试；对实际 SQLite 终态、模型/角色绑定、usage、工具统计及 runner 报告交叉核验。运行完成后才更新提案和结果文档，原冻结材料保留。之前 180 秒失败结果保持原样。本轮没有完整成功样本或 LongCat worker 样本，不能证明成本下降、质量等效或支持默认切换；继续保持生产模型和所有实验默认值。
