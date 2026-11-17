# F-05 输入区（composer）

输入框能打字、能挂附件、能换模型、能暂停在途回复——但**验证时不要真的发一条真模型请求**。

- 入口：窗口中栏底部：`消息`（textfield）、`附件`、`模型`、`暂停`
- 现有自动化覆盖：`app/composer_*_test.go`（`composer_menu_test.go`、`composer_tokens_test.go`、`composer_trigger_test.go`、`composer_attachments.go` 相关测试）

## Sub-features

- 输入：键入文本 → 输入框 value 等于输入（含中文与 emoji）。
- `/` 触发菜单与 `@` 触发条目补全（`composer_trigger.go`、`GET /api/projects/{id}/entries?q=`）。
- `模型` 选择器：列出 `/api/settings` 里可用模型（view-only 实例可能 0 个 → 空态）。
- `暂停`：仅在有在途回复时可用（否则禁用）。
- 附件：选择文件 → 计入消息附件（`serveAttachment`）。

## How to get to it (user POV)

打开窗口 → 底部输入框 → 直接打字；点「模型」换模型；回复中时「暂停」可点。

## Driving it with verify-graph

```sh
verification/verify-graph verify --journey F-05-composer
verification/verify-graph ui render F-05-composer          # 只看渲染结果，不判
```

判过（已实测）：`verify --journey F-05-composer` 通过 —— 选中项目会话后 composer 出现（`消息` + `模型`），`type` 把 `验证用文本 verify-graph 123` 真的敲进了输入框，并且**辅助功能读到的 value 逐字等于这串文本**（`result.json` 里 `access[{name:"消息",value:"验证用文本 verify-graph 123"}]`，不是“看到一段文字”而是控件真持有这个值）。证据：`evidence/<run>/F-05/{composer-typed.png,result.json,summary.json}`。

**负断言**：本 feature 的判过条件是「只键入、不发送」。`checks` 里的 `GET /api/conversations` 在键入前后都能 200；真正证明“没发送”的是 journey 之后的消息条数没变（发送会多一条 `user` 消息，需要 `checks` 前后对比或 `seed` 提供基线）。

## Gotchas

- `消息` 是 textfield 的 AX name，不是 placeholder（placeholder 是另一串）。它的内容**不是**可读文本，而是控件的 **value**：
  用 `assertText "验证用文本 …"` 永远不过（第一版就是这么红的，它并不证明“没入力”——证明的是“断言看错了地方”）；正确写法是
  `{"verb":"assertAccess","name":"消息","value":"验证用文本 verify-graph 123"}`，并把 `access[]` 写进 `result.json` 当证据。
- 没选中会话时 composer 不在树上：先 `clickIf <项目会话>`（或等 `消息` 出现），否则 `type` 无处可去。
- `main agent 会话` 这种父容器带 label 的卡片在 headless 测试器里点不动（`not the input target`）；用项目会话行或具体子文本。
- view-only 实例没有模型、没有在途回复：`停止`/`暂停` 必然禁用，这是**正确**状态，别判红。
- 真发送会消耗真 token 并写用户数据：本 feature 的判过条件明确是「不发」。要验证派发链，走 `seed`（替身模型）或真模型 eval，不在这里。
