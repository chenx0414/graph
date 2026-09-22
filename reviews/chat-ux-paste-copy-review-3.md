# 独立审查（chat-ux 右键粘贴 build-paste + 消息复制按钮 build-copy）

结论：**fail**（1 项阻塞，5 项通过）

- 审查对象：集成合并 `ba7f98f`（base `7c72f64` ← `4383feb` build-paste + `7aeda09` build-copy）。当前工作副本 HEAD `c7c8c4c`，`git status` 干净；`git diff ba7f98f..HEAD` 仅有此前两份审查交付文件（`reviews/chat-ux-paste-copy.md` a899050、`reviews/chat-ux-paste-copy-review.md` c7c8c4c），`src/` 与 `tests/` 与集成合并完全一致，本报告的代码结论对 `ba7f98f` 与当前 HEAD 同时成立。
- 合并完整性：`git diff ba7f98f 7aeda09` 仅含 build-paste 的 3 个文件（反向），`git diff 7c72f64..ba7f98f` 为两条分支的干净并集（7 个文件），无冲突覆盖、无额外改动。

## 机器检查证据（graph 检查节点，integration 工作副本运行；digest 已在本地重算核对一致）

| 检查 | 结果 | 证据文件 | sha256 |
| --- | --- | --- | --- |
| check-types | `node --run typecheck` 退出码 0 | `/Users/macmini/Library/Application Support/Graph/state/checks/check-types.json` | `a2474bb10d1b87b61cb5493332b6e2be75ab0cbbe8526c2f89c29c771030fdb3` |
| check-tests | vitest 退出码 0，2 文件 11 用例全过（paste 5 + copy 6） | `/Users/macmini/Library/Application Support/Graph/state/checks/check-tests.json` | `d640b80398f446a9a3c98b164ad48d0939e7f091ff0a39815468723285857979` |

DOM 层行为不在本门禁内，由 human-paste / human-copy 人工验收覆盖。

## 逐条 lookFor 结论

### 1. diff 只出现在各节点 input.files 列出的路径，两条并行分支互不越界 —— ✅ 通过

- `4383feb`（build-paste）改动 3 个文件：`src/web/ChatComposer.tsx`、`src/web/chat-paste.ts`（新增）、`tests/m8/chat-ux-paste.test.ts`（新增）—— 与 input.files 完全一致。
- `7aeda09`（build-copy）改动 4 个文件：`src/web/TranscriptRows.tsx`、`src/web/chat-copy.ts`（新增）、`src/web/styles.css`、`tests/m8/chat-ux-copy.test.ts`（新增）—— 均在其 input.files 内（该集合另允许 `src/web/transcript-model.ts`、`src/web/ui.tsx`，两者未被改动，未触碰不越界）。
- 两条分支实际改动路径交集为空；两个 input.files 集合交集为空。无 `package.json`/lockfile/IPC/主进程/`node_modules` 改动。

### 2. 粘贴路径的失败分支：空剪贴板、非文本、读取被拒时输入不变且不弹错 —— ✅ 通过

- `src/web/chat-paste.ts:25-38` `readClipboardText`：无 reader 返回 `''`；`try/catch` 吞掉拒绝/异常（含 reject 非 Error）；`typeof text === 'string'` 守卫把非文本结果归为 `''`。
- `src/web/ChatComposer.tsx:216-219` `if (!text) { requestAnimationFrame(() => textareaRef.current?.focus()); return; }` —— 不调 `onChange`、不 toast、不抛错，输入不变并保持焦点，静默符合决策。
- `src/web/chat-paste.ts:27-35` `insertAtCaret` 对空 `text` 返回原 value、caret 停在选区起点，双保险。
- 测试（`tests/m8/chat-ux-paste.test.ts`）覆盖 build-paste done 要求的四条分支：无选区插入、有选区替换、空剪贴板保持不变、读取被拒（reject / 非 Error reject / 无 reader）各 1+ 断言；另有读取成功 1 条。
- 接口与冻结接口一致：`insertAtCaret({ value, start, end, text }) → { value, caret }`。

### 3. Agent 行复制内容等于 transcript 行携带的 Markdown 源文本，streaming 行不渲染按钮 —— ✅ 通过

- `src/web/chat-copy.ts:15-19` `copyText`：assistant 行返回 `row.text`（`src/web/transcript-model.ts:158-162` durable 行 `text: message.text`，即消息 Markdown 原文；Markdown 渲染器消费同一 `row.text`，不读渲染 DOM 文本）；streaming 行返回 `''`（`transcript-model.ts:189-195` 的流式行 `streaming: true`）。
- 用户行返回 `row.message.text`（原始输入文本）；system / tool / tools / rsi 行返回 `''`。
- `src/web/TranscriptRows.tsx:266-268`（Agent）与 `:57-59`（用户）`{copyable && <div className="message-actions"><CopyButton …/></div>}`，`copyable` 为空串不渲染 —— streaming 的 Agent 行无按钮。
- 测试断言：Agent 行等于 Markdown 源文本、用户行等于原始输入、streaming 行 `''`、系统/工具行 `''`（`tests/m8/chat-ux-copy.test.ts`）。

### 4. 复制按钮不再出现「复制」文字，图标保留 aria-label 与 data-testid，点击仍写原文并有 toast —— ❌ 阻塞项

- `src/web/TranscriptRows.tsx:19-31` `CopyButton` 的按钮内容仍是文字 `复制`（第 29 行为字面量「复制」）。build-copy 冻结的 objective「复制按钮改用图标（不再显示文字「复制」）」与 done「气泡下方只有图标、没有「复制」文字」均不满足。
- `src/web/ui.tsx` 未按 build-copy steps 第 1 条在 `IconName`（5-9 行）与 `PATHS`（11-43 行）增加 copy 图标：`grep -in copy src/web/ui.tsx` 无任何匹配；steps 第 2 条要求的 `<Icon name="copy" />` 也不存在。build-copy 交付的是文字按钮版本，而非任务图冻结的图标版本。
- 保留项满足：`className="message-copy"`、`data-testid="message-copy"`、`title="复制这条消息"`、`aria-label="复制这条消息"` 均在（`TranscriptRows.tsx:23-26`）。
- 行为部分成立：点击经 `writeClipboardText(text, navigator.clipboard, toast)` 写入该条原文，成功 `已复制到剪贴板`/success、失败 `复制失败：…`/danger，走既有 toast 通道（`src/web/chat-copy.ts:25-39`）。
- 影响：人工验收 human-copy 若按「按钮只有图标」的界面预期核对会直接看到文字「复制」；该条同时是本审查 lookFor 的明确条目，构成阻塞。
- 修复建议（对齐 build-copy steps）：在 `src/web/ui.tsx` 的 `IconName` 与 `PATHS` 加 copy 图标（两个叠加圆角矩形、stroke 风格与既有图标一致），把 `CopyButton` 内容替换为 `<Icon name="copy" />`，保留 `className`、`data-testid`、`title`、`aria-label` 不变；若有断言按钮文字「复制」的既有用例改为断言 testid 或 aria-label（当前 `grep -rn "复制" tests/` 仅命中新文件，无既有用例需要改）。

### 5. 贴合既有 src/web 风格：TS 严格模式通过、不新增依赖、DOM 结构可读 —— ✅ 通过

- typecheck 退出码 0（上表证据）；全部改动落在 `src/web/**` 与 `tests/m8/**`。
- 组件内只 import 既有 `src/web` 模块（`chat-paste.ts`/`chat-copy.ts` 为本任务新增的纯逻辑模块，两个分支各用各的，无共享新文件）；无新增依赖与 IPC。
- 复用 `ui.tsx` 的 `Icon`/`toast` 既有通道与既有 CSS 变量（`--faint`、`--panel-soft`、`--accent`）；DOM 结构 `message-stack → message-content（气泡）→ message-actions` 可读。

### 6. 已有测试的断言保持原样 —— ✅ 通过

- `git diff 7c72f64..ba7f98f --stat` 中 tests/ 下只有两个新增文件；无任何既有测试文件被修改（build-copy steps 第 3 条的「改断言」场景在本仓库不存在，无需执行）。

## 非阻塞备注

1. `TranscriptRows.tsx:27` 直接传 `navigator.clipboard`，无 `chat-paste.ts` 式的 `typeof navigator !== 'undefined'` 守卫；Clipboard API 不可用时的 TypeError 会被 `writeClipboardText` 的 try/catch 捕获并走 danger toast，仍符合「成功与失败都走 toast」，仅为防御风格不一致。
2. `row.streaming === false` 但 paced reveal 未结束（`visualStreaming` 为真，`TranscriptRows.tsx:265`）时复制按钮即出现；此时 `row.text` 已是完整稳定的 Markdown 源，复制内容正确，streaming 行不渲染按钮的主分支已满足。
3. `tests/m8/chat-ux-paste.test.ts` 的「非文本」用例标题提及非文本，但断言落在拒绝/无 reader 分支；非文本（reader resolve 非字符串）分支由 `typeof text === 'string'` 守卫实现但无直接断言。build-paste done 要求的四条分支断言齐备，不阻塞。
4. 测试按决策仅覆盖纯逻辑（无 jsdom/浏览器）；右键手势、焦点保持、toast 呈现由 human-paste / human-copy 人工验收覆盖。

## 结论

两项交互的核心行为（caret 处粘贴含选区替换与失败静默；复制等于原文含 Agent Markdown 源文本、streaming 不渲染按钮）、文件边界、既有断言、风格约束全部成立；但 build-copy 已确认目标「按钮改用图标、不再显示文字『复制』」未实现：按钮内容仍为文字 `复制`，`src/web/ui.tsx` 未增加 copy 图标。该项是本审查 lookFor 的明确条目，构成阻塞。

独立结论：**fail**（阻塞 1 项：复制按钮图标化未实现）。
