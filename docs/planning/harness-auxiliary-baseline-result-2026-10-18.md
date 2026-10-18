# 完整任务辅助时限实验：单会话基线结果

使用者批准一个360秒隔离parser workflow，已执行且正常结束，不追加会话。**任务、graph、独立业务验收、最终main操作均通过，所有54请求有权威usage；形成当前实验配置的一次完整基线。没有可比较的前后任务成本或质量等效证据，不认定总体降本目标完成。**

## 完整交付与冻结

耗时318125ms，timedOut=false、taskSuccess=true、业务verification=verified、graph phase=completed；main两次operation均succeeded/worker_active=0。实现work和独立review两次execution均completed，retry/resubmit均0；integration SHA与target SHA一致：`9983211eb565807cb408e4bdedfa9bd422c07744`。工具统计收尾collected=true，cleanupIncomplete=false。

planner/worker均DeepSeek当前profile，独立reviewer为非free upstream Step 5 Preview；实际绑定与获批范围一致。完整main/coder/reviewer资源14/6/5，原身份与全部既有实验flag=0；仅GRAPH_EXTENDED_PROMPT_SUGGESTION_TIMEOUT=1。未使用身份精简候选。1496项冻结源码/文档/配置调用前后校验一致，资源逻辑摘要`de57b345f76ce241c037d3eb2c3ca873372a1ee026d573c32e194fdde5034b39`。allRuntimeDependenciesProven仍false，不推广为所有外部能力经过实际操作验证。

## 整树usage与成本

| 实际模型 | 请求 | input | output | cacheRead | 未知/估算usage |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeepSeek | 41 | 95232 | 27477 | 1908480 | 0/0 |
| Step 5 Preview | 11 | 24400 | 10325 | 253952 | 0/0 |
| LongCat辅助建议 | 2 | 1772 | 157 | 256 | 0/0 |
| 合计 | 54 | 121404 | 37959 | 2162688 | 0/0 |

已记录cacheWrite=0。范围包含main、原配方worker/reviewer、辅助建议和恢复，不排除失败调用/重复查询。严格冻结费用有52请求未知，故正式每完成任务费用=null；不能把两条已知免费辅助费用0当整树成本。

使用已批准计划冻结的同日官方公开逐模型权重，经现有harness-eval-summary CLI以scope=workflow汇总：off-peak每完成任务情景 **0.11416914 USD**，peak **0.15066558 USD**，usageComplete/pricingComplete均true。DeepSeek使用相应peak/off-peak权重，Step 5使用固定输入1/输出2.7/cacheRead0.1 USD/百万tokens，LongCat限时免费权重0；cacheWrite价格仍null，因本次写tokens=0不产生未知项。这是公开价格加权情景，不是发票、订阅实际增量或长期免费保证。

完成分母为本次完整workflow成功1/attempt1，不是以内部tasks两行算两次业务任务。过去失败尝试不消失，本页情景只对应明确的新单会话范围；跨历史累计若包含未知usage仍不能得到精确每完成任务成本。不能把318秒成功对比旧360秒中断直接算节省率。

## 辅助时限与工具错误的解释

两条LongCat建议均asked=true、timeoutMs=20000、timedOut=false、error=null，profile到decided分别3548/4164ms。**它们都未超过原5秒上限，故本次没有触发延长等待分支，不能将usage完整或任务成功归因于20秒开关。** 默认关闭保持；受控6500ms E2E证明的分支行为与真实模型本轮未触发分开记录。

宿主统计70次调用、3次错误：bash2和get_task_status1。两次bash失败是对未修parser的真实失败断言，不直接等同harness缺陷；状态误查check模块的错误已经给出graph_inspect operations恢复参数。会话还保留一次Pi `git`参数schema校验失败（缺subcommand），它在执行前被拒绝，未进tool_calls宿主计数。故宿主3个错误不是所有模型可见错误数；需要明确分母和覆盖，不能据此声称错误率下降。原始会话与账本均保留，不用补估tokens修正供应商权威usage。

## 原始证据

- 冻结计划：`/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-auxiliary-baseline-1X5CFd`，包含人类批准、排他started、finished、parser.json、verification-audit.json和offPeak/peak的comparison及summary JSON。
- 运行现场：`/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-VycB9y`，保留原SQLite、会话、业务项目、cost-report.json和execution-setup.json。
- 编排日志：`/tmp/graph-auxiliary-baseline-live.log`。attempted=1，noFurtherAttempts=true，validBaseline=true。
- 本轮只更新结果文档，没有运行代码或测试变更。完整报告提交门禁 `/tmp/graph-auxiliary-baseline-report-check.log`：272文件、1514测试通过，376.16秒，baseline匹配、验收证据不变。未修改生产模型/effort/路由/配方默认；未部署或开启生产开关。

下一阶段仍需固定任务集与可比较对照、质量指标、来源×billing精确归因及真实使用证据。本次基线消除了“尚无完整绑定成功任务且全usage已知”的证据缺口，没有消除总体降本与质量等效缺口，也不授权扩样或其他模型/身份试验。
