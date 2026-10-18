# 已批准并完成：完整任务基线的辅助调用时限实验

状态：使用者答复“批准这一个 360 秒会话”，唯一会话已完成；[结果](harness-auxiliary-baseline-result-2026-10-18.md)记录完整交付与权威用量。以下保留批准范围；调用前原文、配置与源码另有冻结归档。此前四项360秒范围已在首项触发停止，不能复用其授权。这里最多只提议一个新的隔离 parser workflow，用于取得完整交付且用量完整的基线，不比较模型或reviewer身份，不宣称降本。

## 证据与默认关闭的开关

上轮LongCat prompt_suggestion在5001ms后中止，留下未知usage；源码 `src/runtime/pi-adapter.ts` 的固定上限确为5000ms。中止发生在main结束前，不能归因于自动确认抢跑。完整任务截止又中止了一条DeepSeek请求；二者都保留未知，不用估算或零费率覆盖。

新增实验开关 `GRAPH_EXTENDED_PROMPT_SUGGESTION_TIMEOUT=1` 仅把提示建议的单次上限改为20000ms；默认及任何其他值仍是5000ms。它不改模型、路由、reasoning effort、请求prompt、输出限制、重试或调用次数。决策事件新增timeoutMs/timedOut，明确本地时限是否触发；供应商自己中止与未知用量仍保留。没有为了得到完整账本而关闭辅助功能。

已有真实CLI→模型→工具写文件→独立行为verifier→SQLite/成本报告E2E的suggestion行现在驱动两次完整业务流程：外部服务6500ms后才返回usage。开关开启时只发一次辅助请求，保留input/output/cacheRead=25/10/15的权威usage；默认时同样只发一次辅助请求，5000ms中止、unknownUsage=1，业务CLI仍成功。它仅证明受控服务的时限和记账路径，不保证真实LongCat会在20000ms返回。延长等待也可能增加时延或费用。

修复前定向明确失败于unknownUsage=1而非预期0（`/tmp/graph-suggestion-deadline-red.log`）；最终默认/实验对照行通过、19.83秒（`/tmp/graph-suggestion-deadline-final-focused.log`）。完整门禁 `/tmp/graph-suggestion-deadline-check.log`：272 文件、1,514 测试通过，356.10秒，baseline匹配、验收证据不变；所有生产默认保持。

## 精确提议范围

最多一个隔离parser workflow，总模型运行上限360秒，含规划、实现、独立审查、所有辅助/恢复调用及它们的等待。提示建议每次最多20秒，包含在360秒内，不是额外追加。模型停止后仅允许至多30秒记账/进程收尾。准备、验证和归档不调用真实模型；时间限制不是金额硬上限。

- main/planner及实现worker：现有 `opencode-go:deepseek-v4.1-flash` profile。
- 独立reviewer：现有 `opencode-go:step-5-preview`，upstream step-5-preview；不换free别名。
- 继承原配置的辅助模型选择，包括LongCat提示建议，全部纳入账本；不关闭建议、替换候选或改effort。
- 完整冻结main/coder/reviewer 14/6/5资源，原身份/技能、v2缓存归档、真实worktree/提交/artifact/host check/当前integration commit独立review/目标分支交付。
- 业务原话与独立verifier保持。runner只自动确认当前合法隔离测试draft，不在main前替它构图，不确认真实用户项目。
- 所有既有提示词/工具/输出实验flags=0，唯一开启项为上述辅助20秒时限开关。未安装的reviewer精简候选不参与。

以当前错误恢复修复后的同一源码/文档版本和模型配置冻结清单/摘要；调用前后核对。资源原件保留，旧失败不覆盖。每次启动前至少4GiB可用空间，started文件排他创建，只有一个attempt，无重跑或替补入口。

## 预先停止与报告

任一未完整交付、超时、业务失败、未知/估算usage、工具统计失败、源/配置漂移、错误模型/角色绑定或清理不全，即停止且不补跑。即使业务和graph通过，最终main operation未succeeded也判完整任务失败。若辅助20秒仍中止，保留当次未知账本；不能再延长或关闭辅助来完成这次授权。

统计整树所有请求，严格冻结费用与公开逐模型权重情景分开；未知usage/价格保持未知，缺少缓存写价不推为零。一次通过仅建立当前版本的可行性与基线，不是质量等效或降本证明，不授权后续身份A/B、扩大任务集或启用生产开关。任何身份候选试验仍需先完成装配和质量验证再单独定范围。

## 批准边界

原目标将模型/路由/effort/分工变化保留为提案；此前具体真实调用范围又已触发失败即停。本提案增加了一个真实workflow并改变其辅助等待上限，需要使用者明确批准这个单会话范围。未答复不视为批准；完整门禁、冻结材料和零调用预检完成后才请求决定。


## 冻结产物入口

零调用准备入口 `/tmp/graph-prepare-auxiliary-baseline.mjs`，执行入口 `/tmp/graph-run-auxiliary-baseline.mjs`；私有计划由 `/tmp/graph-auxiliary-baseline-location.json` 定位。包含冻结配置、源码逐文件清单/归档、运行器hash和不可变执行范围摘要。归档逐文件核对原清单（含空文件和符号链接）。未记录与该摘要一致的人类批准时，真实启动拒绝；started文件排他创建，任何结束都不生成后续attempt。批准请求前完成的预检记录在私有计划目录，不将准备动作当模型调用。
