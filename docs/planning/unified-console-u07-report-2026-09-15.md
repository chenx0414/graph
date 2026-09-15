# U07 节点会话与运行记录：实施与验证报告

日期：2026-09-15。分支 `feat/unified-console`。前置 `c67c49b`（U06）。

## 交付内容

- **schema v17**：`node_entries`（seq 稳定游标、task/node/instance/activation/operation 关联、role/kind/text/data）、`node_sessions`（实例到 Pi 会话 id/文件）、`operations` 增加 `dispatched_at/settled_at/waiting_since/waiting_ms`。
- **真实 Pi 会话投影**：工人/审查实例（非会话 anchor）的每个 operation 持久化：提交给 Pi 的真实 briefing（user）、`message_end` 的真实 assistant 消息、工具调用与结果；会话 id/文件来自 `session.inspect()`。设计对话（chatting anchor）继续使用既有 `messages`，不双写。
- **等待与运行时间分离**：凭据槽等待前后维护 `waiting_since/waiting_ms`；`nodeRun` 返回每 operation 的 `runMs = settled - dispatched - waiting`，排队等待不计入运行时长。
- **只读投影 API**：`GET /api/tasks/:taskId/nodes/:nodeId/run`（`after/before/limit`，limit ≤ 500），返回定义/实例身份、会话引用、operations（状态/时间/result/usage）、invocations（含价格快照）、问题、证据与条目分页；`nodeRun()` 同时可经 Runtime 直接调用。事件流新增 `node.entry`，供界面增量更新。
- **稳定分页**：条目用 `seq` 游标，按节点过滤；两个节点交错写入 600 条各自从两端分页无重复、无遗漏。

## 验证

- `tsc` 主/Web、`vite build`、全量 `vitest run`：**66 → 67 文件 / 323 项通过**。
- `tests/console/node-run.test.ts`（4 项）：真实 Pi 工人产生 briefing/工具/assistant 条目与会话引用、operation 计时与 invocation 记录；重启后投影逐字节一致；两节点交错 600+ 条双向分页稳定；凭据槽等待记录为 `waitingSlot` 且 runMs/waitingMs 分离；HTTP 路由分页与未知节点错误。
- 原始输出：`acceptance-evidence/unified-console/u07/verification.output.txt`。

## 边界与后续

- 时间分段只区分“运行 vs 凭据等待”；更细的暂停/等待用户分段在 U08/U11 视图中展示边界，未伪造精确值。
- Pi 会话文件仍是上下文来源；投影是展示记录，不反向覆盖会话。
- 条目只保存可公开内容，不含隐藏推理或密钥。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/vitest run tests/console/node-run.test.ts
```
