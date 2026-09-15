# U08 图/看板统一节点详情：实施与验证报告

日期：2026-09-15。分支 `feat/unified-console`。前置 `790af5e`（U07）。

## 交付内容

- `src/web/NodeDetail.tsx` 的 `NodeRunPanel`：只读节点详情，消费 U07 的 `/api/tasks/:id/nodes/:nodeId/run`。
  - 首屏回答“在做什么/为什么等待/产出了什么”：状态、程序/Agent/主 Agent 身份、模型与定义版本、运行时间（含凭据等待分列）、已知 token（不限额度显示“不限”）、费用（未知不折零）、记录数。
  - 对话与工具：真实 Pi 条目（任务说明、assistant 回复、工具调用/结果），稳定 id 合并增量；超过一页时“载入更早记录”按 `before` 游标回填。
  - 运行记录：每次 operation 的状态、runMs、等待名额时间、usage；供应商调用列表含模型与费用快照。
  - 问题与验收：开放问题（提示回任务页答复）、证据及有效性/提交。
  - 程序节点展示确认的 `input`（命令与参数）；未运行时说明命令与证据将在执行后出现。
  - SSE：订阅任务事件 `node.entry`/`operation.*`，150ms 合并刷新，无刷新可见新条目。
  - 只读：面板不含“发送/答复/派发”控制，不触发工具。
- 入口：任务图节点点击后的 `node-detail` 卡片内嵌面板；新增直接路由 `#/tasks/:taskId/nodes/:nodeId`（可刷新、可分享），带“返回任务图”。

## 验证

- `vitest run tests/console/node-detail-ui.test.ts`（真实 Chromium + 受控供应商）：任务图点击 work 节点后显示真实对话与工具条目、assistant 文本、运行记录；无发送/答复控件；直接路由 `.../nodes/work` 与 `.../nodes/check` 分别渲染 Agent 记录与程序命令（`"node"`）。
- 既有图/任务 UI 测试（m5/ui、m8/ui-flow、unlimited-ui）保持通过。
- 原始输出：`acceptance-evidence/unified-console/u08/verification.output.txt`。

## 边界

- 容器节点继续由图页展开子节点；独立详情路由目前面向实际节点。
- 时间分段只显示“运行 vs 凭据等待”，不伪造暂停/等待用户的精确时长。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/vitest run tests/console/node-detail-ui.test.ts
```
