# F-04 对话流渲染与消息操作

消息流把 markdown 真的渲染成结构（表格、代码块、列表），并有复制/赞/踩/朗读/更多这些操作。

- 入口：窗口中间栏（`对话标题` 下的滚动区），数据源 `GET /api/conversations/{id}` / `/history`
- 现有自动化覆盖：`app/chat_*_test.go`（`chat_activity_test.go`、`chat_node_test.go`、`chat_live_state_test.go`、`chat_scope_test.go`、`background_notice_test.go` 等）

## Sub-features

- Markdown 表格：渲染成 `row`/`cell`，表头 cell 名就是原文（实测 AX 里能看到 `#`/`问题`/`提交`）。
- 代码块：等宽块 + 复制按钮。
- 消息动作条：`复制`、赞、踩、朗读、更多（AX button 名）。
- 后台通知行：`后台任务通知` 分组 + 摘要文本（`background_notice_test.go`）。
- 长会话分页：向上滚动触发 `GET /history?before=…`（`chat_source.go`），加载更多不重复。
- 实时流：`/events/stream`（SSE）推来的消息追加到流末。

## How to get to it (user POV)

打开窗口 → 中间栏就是当前会话的消息流 → 滚到任意一条消息，悬停出现操作按钮。

## Driving it with verify-graph

```sh
verification/verify-graph api --run <run> --get /api/conversations/<id> --save evidence/<run>/F-04/conversation.json
verification/verify-graph ui expect --text "复制" --role button --json
verification/verify-graph ui scroll --label "对话标题名" --dy -800 --json
verification/verify-graph ui screenshot --out evidence/<run>/F-04/messages.png
```

判过：AX 里出现的表头 cell 名集合 = API 里那几条消息的 markdown 表头（逐字），且消息条数 ≥ 1；滚动后消息条数单调不减且无重复 id。

## Gotchas

- 断言 `find --text` 会命中整段消息正文（上千字），必须用 `role + name` 精确匹配。
- 表格 cell 的 AX name 是纯文本，不含 `|`；比较前先去掉 markdown 分隔行。
- 空白态实例没有消息：「渲染正确」只能靠 `seed` 或用户实例的证据，报告里要标明用的是哪种。
- 1500+ 条历史时会话很长，截图只能证明视口，别声称「全部渲染」。
