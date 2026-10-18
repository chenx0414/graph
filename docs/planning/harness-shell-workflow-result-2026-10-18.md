# 完整任务 shell 短视图对照：已按条件停止

结论：A完整成功，B实际触发7次短视图但未交付；CLI两项取消，不补跑，默认关闭。没有证明每完成任务降本或质量等效，整体目标仍未达成。

## 授权与冻结

使用者明确答复“批准这四个600秒shell对照会话”，对应 `call_0de89b39b5dd4f15a586a3ef0e87333c`。最多parser A/B、CLI B/A，每项600秒模型工作窗口，辅助建议上限20秒计入窗口；准备/资源安装/终止清理在外单独计时。任一失败、辅助错误或未知用量即取消余项，不延时、不补跑、不更换任务。

scopeDigest=`ac7df2f80587a118e6eab10850443e2c4d403fb4397300afc8cf39fd25a4f292`。私有proposal/plan/config、1499项源码/文档清单及逐字验证的源归档保存在 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-shell-workflow-bKUEgc`。config不进入仓库。未批准与摘要漂移负控均在发送前拒绝；批准后只修改authorization记录，范围摘要未变。started排他文件及逐项started文件记录实际flags。

A默认输出；B仅开现有 `GRAPH_COMPACT_SHELL_RESULTS=1`。两组均为完整原reviewer身份，planner/worker固定DeepSeek、独立reviewer固定Step 5 Preview非free upstream；辅助继承同一配置。14/6/5原资源与同一原资源归档不变，其他实验关闭；模型、effort、输出上限、分工和内部重试策略未改。没有要求模型节省tokens、禁止重定向或强迫制造大输出。

## 完整任务结果

| 指标 | parser A 默认 | parser B 短视图 |
| --- | ---: | ---: |
| 完整成功 | 是 | 否 |
| 业务验收 | verified | behavioral CLI check failed |
| 工作窗口耗时含终止开销 ms | 577780 | 600386 |
| 两次main operation | succeeded / succeeded | succeeded / interrupted |
| 首main operation ms | 277791 | 261900 |
| 第二main operation ms | 298163 | 337599 |
| graph最终持久状态 | completed | stopped |
| 实现 / 独立审查执行 | completed / completed | 均未执行 |
| 请求（整树） | 58 | 54 |
| 未知 / 估算usage | 0 / 0 | 1 / 0 |
| input | 125155 | 151931（已记录部分） |
| output | 47764 | 38576（已记录部分） |
| cacheRead | 2400896 | 3042944（已记录部分） |
| cacheWrite | 0 | 0 |
| 宿主工具调用 / 错误 | 69 / 2 | 57 / 4 |
| 短视图变换 / 保存核对 | 0 / 0 | 7 / 7 |
| 严格费用 / 每完成任务费用 | null / null | null / null |
| off-peak每完成任务权重 USD | 0.099440516 | null |
| peak每完成任务权重 USD | 0.145479932 | null |

A冻结账本有56条未知价格，B有53条；严格费用保持null。公开逐模型权重沿用本轮冻结情景，不是发票或订阅现金支出。B off-peak/peak已记录小计0.054658332/0.109316664 USD，缺少最后一次请求usage且成功数0，每完成任务均null。不能因B少调用reviewer而称便宜，也不能排除失败成本或把未知算零。两项合计112请求、完整成功1；完整总体费用仍未知。

A graph=`9e69f165-f15a-4d30-8c14-b0f834e4348d`，integration/target均 `ce9e60e0c42186da47730147d0a33222ab5a9fca`，目标工作区干净。B graph=`205d275a-54bb-4197-b344-695af91435be`，integration/target仍为原始 `5722f850203b958507bd19ea0de892b614c5265c`，没有交付业务修复。B报告中的workflow.phase=running为停止前快照；最终SQLite是stopped，owner paused=1、所有worker_active=0、cleanupIncomplete=false。

B唯一未知usage是DeepSeek main completion（invocation `069673f3-6654-4889-93ab-ebe56b550d23`），不是Step或LongCat。A两条、B一条LongCat提示建议均成功，timeoutMs=20000、timedOut=false。监测进程检测未知/辅助错误时可经本隔离实例公开pause/stop/interrupt入口停止；本次由正常600秒deadline终止，watchdog观察到scope终态后退出，没有watchdog-stop记录或额外控制回执。

## 失败链与可归因边界

B两次graph_send分别把value传为字符串 `"{}"`、`"{\"round\":1}"`，而work.job协议要求对象；宿主均拒绝 `work.job: must be object`，未形成队列或执行。随后graph_patch又把changes传成一段序列化JSON字符串，收到 `Graph change requires a reason`；并未实际修改正式graph。原value接口允许JSON原生值，字符串也可能是其他合法协议的数据，因此不能默默JSON.parse或修改协议来掩盖此类错误。

两组两个main operation的实际tool_declarations均54项，包含graph_send/get_task_status。A已用原生对象成功发送并交付；B“schema驱动客户端只能发送字符串”的判断没有被实际工具行为支持。它在错误后进行了更多源码探索，不能把错误解释为工具未加载，也不能将全部超时或费用归因短视图。后续可直接改善错误诊断，使模型区分JSON对象与序列化字符串，仍需真实完整流程回归；本次没有实施这种修复，也没有据此补跑。

A两条bash错误来自独立验证过程：临时目录写入失败与后续命令非零退出；B另有一条bash非零退出。完整会话错误扫描与宿主数量一致，本轮未发现额外schema层拒绝，但不回填旧会话覆盖。工具错误的后续探索是任务费用的一部分，不删除。

## 短视图确实触发，整任务仍失败

B7条实际返回的短视图合计5652字节；对应磁盘SDK返回文本合计45688字节，长度核对7/7。保存的是SDK返回文本，不能冒称所有进程原始stdout全文；原生Full output路径、退出码与非文本部分的保留由现有真实E2E验证。保存文件没有经过旧lazy结果256文件清理窗口。

最终会话参数中观察到3条read显式访问shell handle；不能以早期“尚未观察到回读”的进度替代终态，也不能把回读费用排除。按实际wire累计，A/B tool_results分别3484046/5453918字节，其中read1848940/3595408、bash642169/955384。B首视图变短后总重发体积仍更大，但路径、轮次及完整交付状态不同，不能作同任务成功成本或精确来源×billing归因。它显示仅看短视图长度会遗漏探索与回读成本。

此前[非触发command对照](harness-compact-shell-2026-10-18.md)仍为零触发，不挪用其有利波动；本次不再是零触发，但没有成功候选费用。此前两个成功原身份基线在运行时代码/config/context相同、三份规划文档不同的情况下，公开off-peak权重就相差23.7%；这是观察差异，不是方差估计、显著性门槛或优化收益。

## 资源与实际执行

两组实际revision均引用coder@2、reviewer@2及获批模型，编译定义main@1/coder@2/reviewer@2资源数14/6/5、ID集合与冻结清单相同。比较实际capability/prompt引用，两组解析版本完全一致。FFF声明0.10.6解析0.11.0、browser声明0.6.13解析0.6.17，与[既有归档缓存证据](harness-runtime-cache-2026-10-18.md)一致：source范围不是精确pin，不把声明版本冒充实际代码版本。

A实际绑定DeepSeek worker与Step reviewer，执行无重试/补交；B虽编译相同配方却无节点绑定、无execution，因此roleIntegrity=false。B的identityIntegrity=true来自空集合判断，不能将它作为“reviewer身份实际发送”的证据。resourceIntegrity仅证明安装清单，不证明所有MCP或全部资源实际调用成功，allRuntimeDependenciesProven仍false。补充审计的初版误读snapshot.agentCombination为资源表，已保留初版并改为实际capability/prompt引用核对；最终报告不沿用错误解释。

## 证据与后续

finished.json明确attempted=2，余项CLI B/A取消、noFurtherAttempts=true；orchestrator及watcher均终态。A匹配capabilities/extensions缓存经现有归档逐字验证后释放，恢复元数据保留；B现场和所有state/session/project/账本保留。sourceStable两组true，没有生产默认、模型、推理强度、schema或runtime源码修改。

结果/费用：parser-a/b.json、observations.json、finished.json、offPeak/peak-summary.json与独立by-variant汇总；补充terminal-audit.json、runtime-resource-audit.json；私有配置不公开。旧180/360秒范围不复用，600秒范围也已结束。

准备的现有HTTP/Pi/bash/read/重启保留E2E3项通过、4.15秒；新增只读观测器通过真实CLI受控外部服务验证（4本地请求、付费0），实际1次变换、原始日志中段回读与业务验收通过。临时探针早两次失败分别是bare上下文误用write_file及错误请求下标，未改生产代码，失败材料保留，不冒充本次真实模型质量证明。

提交前 `node --run check` 全量通过：272文件、1514测试，363.92秒；baseline匹配、验收证据不变。日志 `/tmp/graph-shell-workflow-check.log`。仍缺候选完整成功成本、CLI对照、质量等效和生产混合任务证据。下一步优先复现JSON结构值误用的恢复路径，不延长范围追逐有利结果。

## 本轮逐工具计数

下表为调用/错误；0表示该workflow未调用，不代表生产覆盖率。

| 工具 | A | B |
| --- | ---: | ---: |
| artifact_list | 3/0 | 1/0 |
| artifact_promote | 1/0 | 1/0 |
| artifact_publish | 3/0 | 1/0 |
| artifact_read | 2/0 | 0/0 |
| bash | 29/2 | 31/1 |
| fffind | 0/0 | 1/0 |
| get_agent_combination | 2/0 | 1/0 |
| get_task_status | 4/0 | 2/0 |
| graph_control | 1/0 | 0/0 |
| graph_inspect | 7/0 | 2/0 |
| graph_patch | 0/0 | 1/1 |
| graph_send | 3/0 | 2/2 |
| inspect_graph_system | 1/0 | 0/0 |
| inspect_rsi_status | 1/0 | 0/0 |
| list_projects | 1/0 | 0/0 |
| mcp | 0/0 | 1/0 |
| propose_graph | 1/0 | 1/0 |
| read | 6/0 | 10/0 |
| read_system_capabilities | 1/0 | 1/0 |
| validate_proposal | 1/0 | 1/0 |
| workspace_commit | 1/0 | 0/0 |
| write_file | 1/0 | 0/0 |
