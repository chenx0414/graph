# 独立审查：聊天输入框右键粘贴（build-paste）+ 消息复制按钮（build-copy）

- 审查对象：集成合并 `ba7f98f`（base `7c72f64` ← `4383feb` build-paste + `7aeda09` build-copy）。
- 审查工作副本：`.../worktrees/0faf1367-a2ad-4259-acaf-97d0264ae96f/be1e13e0-f9b3-4740-99a8-4cdb44903b7f`，`git diff ba7f98f HEAD` 仅有此前的审查交付文件 `reviews/chat-ux-paste-copy.md`（a899050），src/ 与 tests/ 与集成合并完全一致；工作副本干净（git status 无未提交改动）。
- 机器检查证据（graph 检查节点，在 integration 工作副本运行）：
  - `node --run typecheck` 退出码 0 —— `/Users/macmini/Library/Application Support/Graph/state/checks/check-types.json`（sha256 a2474bb10d1b87b61cb5493332b6e2be75ab0cbbe8526c2f89c29c771030fdb3）
  - vitest `tests/m8/chat-ux-paste.test.ts` + `tests/m8/chat-ux-copy.test.ts` 退出码 0，2 文件 11 用例全过（5+6）—— `/Users/macmini/Library/Application Support/Graph/state/checks/check-tests.json`（sha256 4cd534783c484f1af288dd76449fe80b68ecf9270564267b5f44677772954dc7）

## 逐条 lookFor 结论

### 1. diff 只出现在各节点 input.files 列出的路径，两条并行分支互不越界 —— ✅ 通过

- `4383feb`（build-paste）改动 3 个文件：`src/web/ChatComposer.tsx`、`src/web/chat-paste.ts`（新增）、`tests/m8/chat-ux-paste.test.ts`（新增），全部在其 input.files 内。
- `7aeda09`（build-copy）改动 4 个文件：`src/web/TranscriptRows.tsx`、`src/web/chat-copy.ts`（新增）、`src/web/styles.css`、`tests/m8/chat-ux-copy.test.ts`（新增），全部在其 input.files 内（该集合还允许 `src/web/transcript-model.ts`、`src/web/ui.tsx`，两者未被改动）。
- 两条分支实际改动路径交集为空。合并完整性：`git diff 7aeda09 ba7f98f` 仅含 build-paste 的 3 个文件，即合并结果是两条分支的干净并集，无冲突覆盖。

### 2. 粘贴路径的失败分支：空剪贴板、非文本、读取被拒时输入不变且不弹错 —— ✅ 通过（一处非阻塞备注）

- `src/web/chat-paste.ts` `readClipboardText`：无 reader 返回 `''`；`try/catch` 吞掉拒绝/异常；`typeof text === 'string'` 拦截非文本结果，统一归为 `''`。
- `src/web/ChatComposer.tsx` `pasteClipboardAtCaret`：`if (!text) { requestAnimationFrame(() => textareaRef.current?.focus()); return; }` —— 不调 `onChange`、不 toast，输入保持不变且保持焦点，静默。
- `insertAtCaret` 对空 `text` 返回原 value 与 `caret: from`（`chat-paste.ts` 22-35 行），双保险。
- 测试断言（`tests/m8/chat-ux-paste.test.ts`）：无选区插入 ✓、有选区替换 ✓、空剪贴板保持不变 ✓、读取被拒（reject / reject 非 Error / 无 reader）✓ —— build-paste done 要求的四条分支各有断言，满足。
- 非阻塞备注：非文本（reader 返回非字符串）分支有实现（typeof 守卫）但聚焦测试只在标题中提及，无直接断言；不影响目标行为成立。

### 3. Agent 行复制内容等于 transcript 行携带的 Markdown 源文本，streaming 行不渲染按钮 —— ✅ 通过

- `src/web/chat-copy.ts` `copyText`：assistant 行取 `row.text`；`src/web/transcript-model.ts` 158-162 行 `text: message.text`（消息原文 Markdown，非渲染 DOM 文本）；streaming 行 `text: stream.text, streaming: true`（189-195 行），`copyText` 对 `row.streaming` 返回 `''`。
- `src/web/TranscriptRows.tsx`：`{copyable && <div className="message-actions"><CopyButton .../></div>}`，`copyable` 为空串时按钮不渲染 —— streaming 的 Agent 行无按钮 ✓。
- 用户行取 `row.message.text`（原始输入文本）✓；system / tool / tools 行返回 `''`，不渲染按钮 ✓（与「用户与 Agent 各一个」一致）。

### 4. 复制按钮不再出现「复制」文字，图标保留 aria-label 与 data-testid —— ❌ 阻塞项

- `src/web/TranscriptRows.tsx` 19-31 行 `CopyButton` 的按钮内容仍是文字 `复制`（工作副本第 29 行）。build-copy 已确认的 objective「复制按钮改用图标（不再显示文字「复制」）」与 done「气泡下方只有图标、没有「复制」文字」均不满足。
- `src/web/ui.tsx` 未按 build-copy steps 第 1 条在 `IconName` / `PATHS` 增加 copy 图标（build-copy 未触碰该文件；`grep -i copy src/web/ui.tsx` 无匹配），也没有按第 2 条渲染 `<Icon name="copy" />`。build-copy 交付的是文字按钮版本，而非本任务图冻结的图标版本。
- 保留项满足：`className="message-copy"`、`data-testid="message-copy"`、`title="复制这条消息"`、`aria-label="复制这条消息"` 均在。
- 行为部分不受影响：点击仍写入该条消息原文并走 toast（见第 3 条与 `writeClipboardText`，成功 `已复制到剪贴板`/success、失败 `复制失败：…`/danger，符合「成功与失败都走既有 toast」）。

### 5. 贴合既有 src/web 风格：TS 严格模式通过、不新增依赖、DOM 结构可读 —— ✅ 通过

- typecheck 退出码 0（上文证据）。
- 全部改动 7 个文件均在 `src/web/**` 与 `tests/m8/**`；diff 中无 `package.json`、lockfile、IPC 或主进程文件 —— 纯渲染层，无新增依赖与 IPC ✓。
- 复用 `ui.tsx` 的 `Icon` / `toast` 既有通道；`.message-copy` 样式沿用既有 CSS 变量（`--faint`、`--panel-soft`、`--accent`）；DOM 结构（`message-actions` 挂在气泡 `message-content` 之后）可读。

### 6. 已有测试的断言保持原样 —— ✅ 通过

- 两个分支只新增了 `tests/m8/chat-ux-paste.test.ts` 与 `tests/m8/chat-ux-copy.test.ts`，未修改任何既有测试文件（`git diff 7c72f64 ba7f98f --stat` 仅 7 个文件，其中 tests 下只有两个新增文件）。
- 仓库既有测试没有断言按钮文字「复制」的用例（`grep -rn "message-copy\|复制" tests/` 仅命中新文件），故无「改断言 testid/aria-label」需要执行的场景。

## 非阻塞备注

- `TranscriptRows.tsx` 的 `onClick` 直接传 `navigator.clipboard`（粘贴侧有 `typeof navigator !== 'undefined' && navigator.clipboard` 守卫，复制侧没有）；Clipboard API 不可用时 `clipboard.writeText` 的 TypeError 会被 `writeClipboardText` 的 try/catch 捕获并走 danger toast，符合「成功与失败都走 toast」，只是防御风格与 chat-paste 不一致。
- `row.streaming === false` 但 paced reveal 尚未结束（`visualStreaming` 为真）时复制按钮即出现；此时源文本已完整稳定，复制内容正确，且 streaming 行为满足不渲染按钮。
- 测试按决策仅覆盖纯逻辑（无 jsdom/浏览器）；DOM 层行为（右键手势、焦点保持、toast 呈现）由 human-paste / human-copy 人工验收覆盖。

## 结论：fail（1 项阻塞）

两项交互的核心行为（caret 处粘贴含选区替换、失败静默；复制等于原文含 Agent Markdown 源文本、streaming 不渲染按钮）均成立，文件边界与既有断言也全部合规；但 build-copy 的已确认目标「按钮改用图标、不再显示文字『复制』」未实现：`src/web/TranscriptRows.tsx` 按钮内容仍为文字 `复制`，`src/web/ui.tsx` 未增加 copy 图标。该项同时是本审查 lookFor 的明确条目，构成阻塞。

修复建议：按 build-copy steps 在 `src/web/ui.tsx` 的 `IconName` 与 `PATHS` 增加 copy 图标（两个叠加圆角矩形、stroke 风格与既有图标一致），把 `CopyButton` 内容替换为 `<Icon name="copy" />`，保留 `className`、`data-testid`、`title`、`aria-label` 不变。
