# 已批准并停止：修复装配与计量后的模型分层可行性小集

状态：使用者已答复“批准这 4 个 360 秒会话”。本范围已执行首项 parser A，因最终 main operation 超时及未知 usage 触发停止，其余三项取消，不补跑。详见[本轮结果](harness-model-tiering-v2-result-2026-10-18.md)。以下保留获批范围；运行前的原文及源码清单已冻结在私有计划归档中。这是新范围，不延伸已停止的四会话授权。原范围的 parser A 在 180 秒未交付，其余三项已按停止条件取消；[原结果](harness-bound-model-tiering-result-2026-10-18.md)保持失败，不用本提案覆盖。

## 为什么再次提出

原对照在 worker/reviewer 派发前结束，不能比较免费 worker。其后已补齐用户角色 setup 的 recipe/definitionVersion 区分、错误查询恢复、工具 spool 收尾/常驻 worker 归属、逐工具请求重发计量，以及直接由完整交付 E2E 执行的 JSON 示例。最新全量门禁为 272 文件/1,514 测试通过，348.49 秒。只有真实模型完成整个流程后才能评价任务成本，继续增加受控测试本身不能提供该证据。

本提案把两组都固定在同一当前版本上，仅比较 worker profile。它不比较新旧文档，不把与旧样本的差异归因于文档、错误恢复或输出压缩。180 秒不足以完成旧对照的事实保留；新时限明确增加到 360 秒，不能把增加时限后的成功描述为旧时限通过。

## 精确批准范围

最多四个新的隔离 workflow，顺序 parser A、parser B、CLI B、CLI A；每项模型运行上限 360 秒，含 main、节点、辅助及恢复调用。准备/归档不调用真实模型，模型中断后仅等待至多 30 秒的 usage/进程收尾，不继续工作。时间限制不是供应商金额硬上限；整组最多 24 分钟模型运行，可能在首项就停止。

| 角色 | A | B |
| --- | --- | --- |
| main/planner | opencode-go:deepseek-v4.1-flash，当前 profile | 相同 |
| coding worker | 同一 DeepSeek 当前 profile | opencode-go:longcat-2.5-preview-free，当前 profile |
| 独立 reviewer | opencode-go:step-5-preview，upstream step-5-preview | 相同 |

沿用现有 Go 凭据；不新增或打印凭据。Step 5 使用此前提案指定的非 free upstream，复制已有 medium profile 的请求参数，移除旧免费别名的零费率；不可用即停，不换成 step-5-preview-free。high/medium 是 catalog grade，不是 reasoning effort；不新增 effort 覆盖、模型切换、fallback 配置或角色拆分。LongCat 的限时免费不能推广为长期费用承诺。

保留完整 main/coder/reviewer 的 14/6/5 项资源、冻结 v2 归档、原配方系统 prompt 和能力、真实 worktree、提交/代码 artifact、host check、独立当前 integration commit 审查与目标交付。各角色 fresh context。所有输出/提示词/工具加载实验 flag 为 0。用户业务任务原话和独立行为 verifier 保持原样，执行约束单列为 user-role setup，发送前保存；不强迫采用新示例、不指定更弱检查、不事先替 planner 构建图。

main 发布符合冻结角色/模型/worktree约束的 proposal 后，隔离 runner 仅对这些新临时测试项目通过公开确认服务接受当前 draft，再由 main 自己派发、检查与交付。不会确认用户真实项目或更改生产默认。

## 冻结与可复核性

文档目录由运行源码根推导，没有独立的文档版本配置。当前模型比较不需要加入新的文档 override：在首项前冻结全部 src、scripts、docs、examples、根规则、package/lock 的文件清单与 SHA-256，保存可复核的文档/示例副本；两组使用同一份内容。模型配置、case、runner、资源快照另有 hash。

每项开始前和结束后核对清单；内容漂移、缺失、未知新文件或模型配置变更即停止后续会话，已发生调用与失败仍计入报告，不偷偷重跑。运行使用当前 checkout 的实际自有组件，不以缺少 RSI 的简化 source 拷贝替代生产上下文。冻结并不阻止用户编辑；检测到编辑就保留现场并停止比较。

先将已结束临时评测的可恢复依赖展开副本归档，验证归档后才清除该展开副本，保留 state/session/project/原账本与结果。每项启动前至少 4 GiB 可用空间；不足就停止，不发起调用。每个完成的私有运行可同样归档依赖以释放空间，不清除原始证据。

## 停止与计量

任何一项未完整交付、超时、业务行为失败、工具统计收尾失败、源/文档漂移、角色模型或审查独立性不符合、权限/证据不明，立即停止全部剩余项。不补跑、不更换候选、不延时、不追加任务，不在失败会话继续修补。供应商错误保留在当次账本，不创建替代会话。

只有 graph phase=completed、目标项目独立 verifier 通过、最终 main operation succeeded、清理无遗漏，才算完整任务成功。worker 修好或只发布 draft 不算成功。统计整棵任务的全部规划、辅助、重试、压缩、RSI、审查与返工；不从分子排除失败尝试。

严格账本成本与公开逐模型费率情景分开。未知 usage、未知价格、缺失缓存写价均保留未知；usage 不完整时每完成任务情景为 null，不把免费/订阅理解为零未知用量。权重来源沿用本日已核对的 OpenCode Go 官方费率，只是公开价格加权情景，不是发票。逐工具 wire 体积用于解释重发，不用于分摊账单。

即使四项通过，也仅证明两类任务的可行性；小样本不能证明“无可测质量下降”、生产 task mix 等效或默认切换。后续重复对照、扩大任务集或生产启用需要另行决定。

## 批准要求

原目标明确要求模型、路由、effort 与分工变更先提出提案；此前具体授权又已触发失败即停。本提案重新使用这些角色模型且把每项时限从 180 秒增至 360 秒，需使用者批准这个新范围后才执行。未答复不视为批准。
