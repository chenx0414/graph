# 可复制给实现 agent 的收口任务说明

请在 `/Users/macmini/workspace/graph-unified-dev` 的 `feat/unified-console` 上继续。开工先 `git rev-parse HEAD`，在最新提交上做，不要 reset 到旧基线，不要回到 `feat/master-agent-entry`、`feat/app-console` 或 `main`。本轮开工基线是 **`76d4e7e`**。

先读 `AGENTS.md`、`CONTEXT.md`、`docs/architecture.md`、`docs/graph-mvp.md`、ADR 0007 与 0010，以及完整收口计划：

`/Users/macmini/workspace/graph-unified-dev/docs/planning/unified-console-closeout-2026-09-15.md`

对照独立验收仍开项：

`/Users/macmini/workspace/13-Graph/docs/planning/unified-console-rework4-acceptance-2026-09-15.md`

U00–U10 的已关闭缺陷不要重做。本轮只交付计划缺口：C01 默认价格快照与刷新、C02 暂停/等待用户写账、C03 旧 schema 全链路升级、C04 打包 Electron 贯通、C05 U11 交接。C01/C02/C03 可并行（C02 独占 schema v19）；C04 依赖 C01；C05 最后。

必须落实：

1. 价格快照有日期和来源；未知不填 0；刷新失败标 stale 并保留旧值；不改写历史 invocation 费用。
2. 暂停与等待用户按状态边界写账，照抄凭据等待的 since/ms 模式；历史无事实仍显示「未记录」，禁止用消息时间相减冒充。
3. 用真实旧版 `tasks.sqlite` 夹具升级后跑完整链路，禁止删库代替迁移。
4. C04 必须跑打包后的 `Graph.app` 和 Electron 凭据桥。Chromium + env key、或复制 src 再起 daemon，都不能当作成品验收。保存不得 relaunch 冒充热生效。先修 Settings/App 仍在说「重启」的文案，以及 IPC 无法传递 `null` 撤销的问题。
5. 先写失败测试再改产品。每包提交和验证报告。不要改 main、不要发布、不要覆盖 `13-Graph` 产品源码、不要改验收方旧证据。
6. 无另行指定的测试凭据时不调用付费模型。长会话摘要、真实对话质量、OAuth 保持未测并在报告写明。

结束时把最终 SHA、`git log 76d4e7e..HEAD --oneline`、全量测试输出、C04 的 APP 路径与 PID 证据、未测清单交给独立验收。是否通过由验收方决定。
