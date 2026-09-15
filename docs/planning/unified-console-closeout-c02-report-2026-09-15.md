# C02 暂停 / 等待用户写账 — 交付报告

- 提交：`47393c3`。schema **v19**：`nodes.pause_ms/pause_since/user_wait_ms/user_wait_since`（NULL=历史未记录）。
- 边界：`task-runtime.setPaused` 调 `openPause/closePause`；问题开启（`block()`、未知用量、task-gate 预发送）`openUserWait`，问题解决（answer/对账/结算/set_budget）`closeUserWait`。凭据排队仍只进 `waitingMs`。
- 投影：`node-run` 用 `nodeTimeLedger`，终态节点不延长未闭合分段；UI 分列「暂停」「等待用户」，NULL 显示「未记录」。
- 测试：`tests/console/node-run.test.ts` 注入时钟 1000ms/500ms、重复关闭不叠加、历史 NULL、公共 API 暂停；`unlimited.test.ts` v13 回滚补 drop 新列。
