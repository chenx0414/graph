# 独立审查（第 4 轮）：聊天输入右键粘贴 + 消息复制按钮图标化 —— pass

- 审查对象：集成分支 tip `692c024`（`graph/task/0faf1367-a2ad-4259-acaf-97d0264ae96f`，工作副本 `state/worktrees/0faf1367-a2ad-4259-acaf-97d0264ae96f/integration`，工作树干净，`git diff 692c024 HEAD` 为空）
- 审查范围：`build-paste`（`4383feb`）与 `build-copy`（`7aeda09` + 图标修复 `0850bf9`）合入后的两项交互
- 检查证据绑定：`check-types.json`（typecheck 退出码 0）、`check-tests.json`（两个聚焦测试文件 11 用例全绿，均在同一 integration 工作副本运行）
- 结论：**pass** —— 6 条 lookFor 全部成立，无阻塞项

> 说明：本审查副本（`be1e13e0…`）自身停在过期合并 `ba7f98f`，不含图标修复 `0850bf9`；reviews/chat-ux-paste-copy-review@1 与 reviews/chat-ux-paste-copy-review-3@1 两份 fail 均以该过期状态为对象。本轮审查对象是 checks 实际验证的集成 tip `692c024`，其中已包含 `0850bf9`（经 `09fddda` 合入）。

## lookFor 逐条核对

### 1. diff 只出现在各节点 input.files 列出的路径，两条并行分支互不越界 —— 成立

`git diff --stat 7c72f64 692c024 -- src tests` 共 8 个文件：

- `4383feb`（build-paste）：`src/web/ChatComposer.tsx`、`src/web/chat-paste.ts`、`tests/m8/chat-ux-paste.test.ts` —— 恰好等于 build-paste 的 input.files。
- `7aeda09` + `0850bf9`（build-copy）：`src/web/TranscriptRows.tsx`、`src/web/chat-copy.ts`、`src/web/styles.css`、`src/web/ui.tsx`、`tests/m8/chat-ux-copy.test.ts` —— 是 build-copy input.files 的子集（`src/web/transcript-model.ts` 未改动，允许）。

两个文件集交集为空，无共享新文件（`chat-paste.ts` / `chat-copy.ts` 各自独立），无 `package.json`、无 IPC / 主进程文件改动。

### 2. 粘贴路径的失败分支：空剪贴板、非文本、读取被拒时输入不变且不弹错 —— 成立

- `src/web/chat-paste.ts:37-48` `readClipboardText`：无 reader、读取抛错（含权限拒绝）、非 string 结果统一归为 `''`，不抛错、不上报。
- `src/web/ChatComposer.tsx:220` 前的 `if (!text)` 分支：`onChange` 不被调用，输入值与选区不变，无任何 toast / 报错，仅恢复焦点。
- `tests/m8/chat-ux-paste.test.ts` 四条分支各有断言：无选区插入（插到 caret）、有选区替换（caret 到插入文本后）、空剪贴板（value 不变、caret 停在选区起点）、读取被拒/非文本（resolve 为 `''`，不抛）。
- `ChatComposer.tsx:406-410` `onContextMenu` 只挂在 textarea 上并 `preventDefault()`：不新增自定义菜单，应用其他区域右键行为不受影响。

### 3. Agent 行复制内容等于 transcript 行携带的 Markdown 源文本，streaming 行不渲染按钮 —— 成立

- `src/web/chat-copy.ts:14-18` `copyText`：`kind === 'assistant'` 返回 `row.text`，即 `src/web/transcript-model.ts` 中 assistant 行携带的源文本（durable 行取 `message.text`，非渲染后 DOM 文本）；用户行取 `row.message.text` 原始输入。
- streaming 判定：`transcript-model.ts:175-182` 的 live 行 `streaming: true`，`copyText` 对 `row.streaming` 返回 `''`；`TranscriptRows.tsx:57/265` 的 `{copyable && …}` 条件渲染使按钮不出现。
- `tests/m8/chat-ux-copy.test.ts` 对 Markdown 源文本等于复制内容、用户原文、streaming 行不可复制、系统/工具行不可复制各有断言。

### 4. 复制按钮不再出现「复制」文字，图标保留 aria-label 与 data-testid，点击仍写原文并有 toast —— 成立

- `0850bf9` 把 `TranscriptRows.tsx` 的按钮内容由文字「复制」替换为 `<Icon name="copy" size={14} />`；`className="message-copy"`、`data-testid="message-copy"`、`title`、`aria-label="复制这条消息"` 均保留（`TranscriptRows.tsx:19-31`）。
- `src/web/ui.tsx:42` 新增 `copy` 图标（两个叠加圆角矩形 + 描边路径），与既有 PATHS 的 stroke 风格一致；`IconName` 联合类型同步扩展。
- 点击行为不变：`writeClipboardText(text, navigator.clipboard, toast)`，成功 `toast('已复制到剪贴板', 'success')`，失败 `toast('复制失败：…', 'danger')` —— 均走既有 `ui.tsx:146` 的 toast 通道（`ToastTone = 'info' | 'success' | 'danger'` 兼容）。
- 本轮集成 diff 中不存在任何断言按钮文字「复制」的测试，无需改写断言。

### 5. 贴合既有 src/web 风格 —— 成立

TS 严格模式通过（typecheck 证据退出码 0）；无新增依赖；`chat-paste.ts` / `chat-copy.ts` 为纯逻辑模块、DOM 交互留在组件层，与 `docs/architecture.md` 渲染层边界一致；组件内 DOM 结构简单可读（`message-actions` 容器 + 单按钮）；`styles.css` 的 `.message-copy` 沿用 `--faint` / `--panel-soft` 等既有变量，并补 `:focus-visible` 可达性样式。

### 6. 已有测试的断言保持原样 —— 成立

`git diff --stat 7c72f64 692c024 -- tests` 仅两个新增文件（纯插入，0 删除）：`tests/m8/chat-ux-paste.test.ts`（+27）、`tests/m8/chat-ux-copy.test.ts`（+103）。既有测试文件未被触碰。

## 非阻塞观察

1. **paced reveal 窗口**：`AssistantResponse` 的 `visualStreaming = row.streaming || paced.revealing`（`TranscriptRows.tsx:225` 附近）表示模型层 `streaming` 结束后还有一段渐进呈现期；此窗口内按钮已渲染（复制内容为完整 Markdown 源，符合"复制等于原文"的既定决策）。"streaming 中不渲染按钮"按 transcript 行的 `streaming` 语义成立，渐进呈现属渲染节奏细节，留给人工验收按实际观感判断。
2. **textarea 内原生右键菜单被抑制**：`onContextMenu` 无条件 `preventDefault()`，右键在输入框内是纯粘贴手势，失败分支连原生菜单也不出现。这与"输入框内右键即粘贴、不新增自定义菜单"的目标一致，其他区域不受影响。
3. **按钮位置**：按钮位于气泡容器底部（`.message-actions`，`margin-top: 5px`），"气泡下方"的视觉效果由人工验收最终确认。

## 证据清单

| 项 | 证据 |
| --- | --- |
| typecheck 退出码 0 | `/Users/macmini/Library/Application Support/Graph/state/checks/check-types.json` |
| 两个聚焦测试 11 用例全绿 | `/Users/macmini/Library/Application Support/Graph/state/checks/check-tests.json` |
| 文件边界 | `git diff --stat 7c72f64 692c024`（8 个 src/tests 文件 + 3 个 review 文档） |
| build-paste 实现 | `4383feb`：`src/web/chat-paste.ts`、`src/web/ChatComposer.tsx:206-233,406-410` |
| build-copy 实现 | `7aeda09` + `0850bf9`：`src/web/chat-copy.ts`、`src/web/TranscriptRows.tsx:19-31,57-58,265-266`、`src/web/ui.tsx:42`、`src/web/styles.css` |
| 审查对象版本 | 集成 tip `692c024e886d771ba69274a807e5532b8380cbb0`（工作树干净，与 checks 运行副本一致） |
