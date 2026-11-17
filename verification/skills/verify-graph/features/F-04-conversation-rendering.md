# F-04 对话流渲染与消息操作

中间栏把 daemon 里的会话渲染成消息流：用户那句与 assistant 的回答都要逐字出现，且这一轮必须真的调用过模型、记下 token。

- 入口：窗口中间栏（`对话标题` 下的滚动区），数据源 `GET /api/conversations/{id}`、`GET /api/conversations/{id}/trajectory`
- Journey：`scenarios/F-04-conversation.json`（`instance: execute` + `seed`）
- 现有单测：`app/chat_activity_test.go`、`app/chat_node_test.go`、`app/chat_live_state_test.go`、`app/chat_scope_test.go`、`app/background_notice_test.go`

## Sub-features

- 一轮真实对话：用 `launch --mode execute --seed` 起本地替身模型，`POST /api/projects/verify/thread` 建项目会话，再 `POST /api/conversations/{id}/messages` 发一句；assistant 回答写回同一会话。
- 消息流渲染：选中项目 `verify` 后，用户句与 assistant 句都在渲染树里逐字出现（不是只断言「页面能打开」）。
- 这一轮的用量：`GET /api/conversations/{id}/trajectory` 必须有 turn，`totals.input/output > 0`。
- 消息动作条（`复制`/赞/踩/朗读/更多）、markdown 表格/代码块：**尚未进入 journey**，只有 `app/chat_*_test.go` 的单测覆盖；本文件的「判过」不声称它们已被真窗口验证。

## How to get to it (user POV)

打开窗口 → 左栏点项目 `verify` → 中间栏就是该项目会话的消息流 → 滚到任意一条消息，悬停出现操作按钮。

## Driving it with verify-graph

```sh
cd verification
./verify-graph verify --journey F-04-conversation                 # 自动起 execute + 替身模型并跑完一轮
./verify-graph verify --journey F-04-conversation --lane window   # 同一 journey 在真实窗口里点开项目会话
./verify-graph evidence verify --run <run>                        # 重算证据 sha256
```

证据在 `evidence/<run>/F-04/`：`seed.json`（那轮对话的 conversation/task/turns/tokens）、`result.json`（渲染树文案与步骤）、`conversation.png`、`assertions.json`、`manifest.json`。

判过：`seed.json.outcome.assistantText` 与本轮场景 `seed.expect` 逐字相等；`messages >= 2` 且 `turns >= 1`、`input/output` token 非零；渲染树同时出现用户句与 assistant 句；`/api/startup.mode == "execute"`、`/api/health.ok == true`。

## Gotchas

- 必须点项目 `verify` 才会切到这条会话；默认打开的是 `main agent` 的 global 会话（空），直接等消息会超时。
- 替身模型的回答是固定的 `已就绪。这条回答来自验证用的替身模型，不消耗真实额度。`；场景用 `seed.expect` 钉住它，防止「换了一条回答也算过」。
- `find --text` 会命中整段消息正文（上千字），要用 `role + name` 精确匹配；消息正文的比较走 API/`seed.json`，不要只靠截图。
- 空白 `view` 实例没有 assistant 轮次；「渲染正确」不能靠空实例证明，必须像本 journey 一样 seed。
- 1500+ 条历史时会话很长，截图只能证明视口，别声称「全部渲染」；分页（`GET /history?before=…`）目前只有单测，没有 journey。
