# F-03 会话列表与切换

左栏列出「每个项目一个会话 + main agent 会话」，点谁就切谁；列表来源必须是 daemon，不是缓存。

- 入口：窗口左栏 `main agent 会话` 卡片 + 会话行；数据源 `GET /api/conversations`
- 现有自动化覆盖：`app/shell_test.go`（`TestTheConversationListShowsOneConversationPerProject`、`TestTheAppOpensTheMainAgentConversation`，用 httptest 假 daemon）、`app/conversations_test.go`

## Sub-features

- 首次加载：骨架行（`skeletonSidebarRows`）→ 真实行；`status` 文案「正在读取会话…」消失。
- 角色过滤：`role=global` 的会话固定在 `main agent 会话` 卡片，`role=legacy` 不进主列表（现有测试断言）。
- 切换：点会话行 → 标题栏 `对话标题名` 变为该会话标题 → 消息流换成该会话消息。
- 空态：daemon 回 `[]` 时列表为空且不崩，`status` 仍可读。
- 归档/恢复：`POST /api/conversations/{id}/archive|unarchive` 后行消失/出现（界面菜单入口）。

## How to get to it (user POV)

打开窗口 → 左栏第一项是 main agent 会话，下面依次是项目会话（如 `13-Graph`）→ 点一下即切换。

## Driving it with verify-graph

```sh
verification/verify-graph verify --journey F-03-conversations
verification/verify-graph api GET /api/conversations --run <run>
verification/verify-graph api POST /api/projects/verify/thread --body '{"requestId":"manual-1","text":"hi"}' --run <run>
```

判过（已实测）：`session 列表标题`、`main agent 会话` 在无项目会话时仍然渲染（不白屏）；同时 `GET /api/conversations` 返回 200（空实例为 `[]`）。证据：`evidence/<run>/F-03/conversations.png` + `check-01.json` + `summary.json`。

**造一个有数据的会话（在隔离实例上）**：`POST /api/conversations` 造出来的会话 `role=legacy`，**不会**出现在左栏（界面只列 `global` 与 `project`）；要让它出现必须走 `POST /api/projects/<projectId>/thread` —— 它返回 `role=project` 的会话并在左栏占一行（title = project id）。

## Gotchas

- 隔离实例默认 0 会话：光断言「列表为空」等于没验。要么 `seed` 造会话（另包负责），要么把「空态不崩 + status 文案」作为该实例的判据，并在 `assertions.json` 里标明 `mode: empty`。
- `role=legacy` 会话在界面被过滤，API 里还在——直接对数量会把正常行为判红。
- 会话正文可能很长：断言只取 `sha256(text)` 前缀或首行，不要把正文写进证据（也不许写进 JSON）。
- **合成一行的卡片/行不能用它的 label 去点**：headless 测试器对 `main agent 会话` 这种“父容器带 label、内部有多个子文本”的元素会返回 `ui: "main agent 会话" is not the input target`。真实窗口车道（AX）没这个问题；headless 车道要先选中具体文本或直接用项目会话行。
- 项目会话标题就是 **project id**（不是会话标题）：断言 `assertText "verify"` 能过，但同时也会命中其它含 verify 的文字，尽量跟 `标签页`/分组名一起用。
