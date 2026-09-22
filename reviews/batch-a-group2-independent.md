# Independent Review — 批 A 第二组（聊天框输入体验）

Requirement version: 1
Reviewer: reviewer@8 (independent)
Reviewed HEAD: `c7e00c5` (merge of impl-composer-input `154142a` + impl-preferences `b70e55e`)
Scope: ① undo/redo, ② ↑/↓ sent-prompt history, ③ Markdown render preference, ④ candidate-prompt preference

## Verdict

**pass**

The four product features meet their acceptance criteria on the code paths that actually ship. The previous independent-review defect (browse cursor not reset after a parent-owned submit) is fixed in `154142a` and covered by a regression test that now passes. All four frozen program checks are green.

## Frozen program checks

| Check | Result | Digest (sha256 of check json) | Evidence path |
|-------|--------|-------------------------------|---------------|
| check-types | code 0 | `a2474bb10d1b87b61cb5493332b6e2be75ab0cbbe8526c2f89c29c771030fdb3` | `/Users/macmini/Library/Application Support/Graph/state/checks/check-types.json` |
| check-undo | code 0, 10/10 | `74b7651ef4f40a4d6517b9a57f4476c03e360d98185e69fd651e9b941e8b8729` | `/Users/macmini/Library/Application Support/Graph/state/checks/check-undo.json` |
| check-history | code 0, 16/16 | `7e43cbab15f116322163c5de11acf6d189861a8e8fc4b2c3ed09cc8c4d28b84b` | `/Users/macmini/Library/Application Support/Graph/state/checks/check-history.json` |
| check-prefs | code 0, 11/11 | `dc7b956451b94828735bc28085139f2636b0c42f691c7247ba1362aa5a06c7bb` | `/Users/macmini/Library/Application Support/Graph/state/checks/check-prefs.json` |

Predecessor handoffs used: `impl-composer-input` rework (`b5480847@1`), `impl-preferences` (`a29ab927@1`). The original composer handoff (`7f4526cc@1`) is superseded for the submit path by the rework.

---

## ① Undo / redo — PASS

Acceptance: 输入框内 cmd+Z 撤销、cmd+shift+Z 重做，覆盖输入、右键粘贴、删除与清空.

Evidence:

- `src/web/chat-undo.ts`: explicit snapshot stack (`past` / `future`), cap `COMPOSER_UNDO_LIMIT = 100`, not persisted. `recordComposerEdit` coalesces a typed run; `paste` / `delete` / `clear` / `insert` are their own step; a new edit clears redo.
- `src/web/ChatComposer.tsx`:
  - keyboard: lines 535–546 handle `(meta|ctrl)+Z` undo and `+shift+Z` / `ctrl+Y` redo **before** `/` and `@` handlers, `preventDefault` so the dead native stack never fires, then `applyProgrammatic` writes the value.
  - recording: textarea `onChange` (line 512, typing / delete / clear / native paste), right-click `pasteClipboardAtCaret` (line 329, kind `paste` via `rememberEdit`), slash / mention / Tab-suggestion inserts (lines 353, 370, 406, 640).
- `tests/console/composer-undo.test.ts`: typed-run undo, right-click paste undo, delete + clear, redo + redo-invalidation, no-op skip, 100-step cap both directions, `composerEditKind` classification. Frozen check: 10/10.

Impact of remaining design choice: a hand-typed sentence undoes as one step. That is documented in `chat-undo.ts` and still records the required kinds. Not a defect.

---

## ② ↑/↓ sent-prompt history — PASS (prior D1 fixed)

Acceptance: ↑/↓ 在输入框内可调出已发送的历史 prompt，/ 与 @ 菜单打开时不抢按键，草稿不丢.

### Sub-clauses

- Source is the conversation's already-sent user messages: `Conversation.tsx:169–181` `sentUserPrompts` (user role, skip briefing / queued / cancelled, consecutive-dedup) passed as `history={composerHistory}` at line 1181. Met.
- Menu precedence: `ChatComposer.tsx:606` history branch is gated `!slashOpen && !mentionOpen` and sits **after** the `/` (line 547) and `@` (line 583) handlers. At the earliest prompt `composerHistoryUp` returns `null` so the key falls through. Met.
- Draft: first ↑ stores `liveValue` (`chat-history.ts:81–88`); ↓ past the newest restores it (`chat-history.ts:102–106`). Met.

### Prior defect D1 — fixed in `154142a`

The previous review failed because `rememberPrompt()` early-returned when `history !== undefined` (the Conversation path always passes `history`), so a recalled prompt sent with Enter left `cursor` non-null. Next ↑ skipped the newest entry.

Current wiring:

1. Pure function `submitComposerPrompt(state, prompt, parentOwned)` in `src/web/chat-history.ts:62–69` always `resetComposerHistory`, and only `recordComposerPrompt` when the composer owns the list.
2. Single call site `ChatComposer.tsx:228–231`:
   ```
   historyRef.current = submitComposerPrompt(historyRef.current, value, history !== undefined);
   setHistoryBrowsing(false);
   ```
3. Enter (`:653`) and the primary send button (`:684`, `primaryMode === 'send'`) both call `rememberPrompt()`. Conversation `send()` still clears via `setText('')` (`Conversation.tsx:690`), which does not fire `onChange`; the submit path no longer depends on that.
4. Regression in `tests/console/composer-history.test.ts:90–107` constructs parent-owned entries, recalls (cursor 0), `submitComposerPrompt(..., true)`, then ↑ and asserts the newest prompt plus `cursor`/`draft` reset. Frozen check-history is 16/16 (was 14 before the rework). Source assertion (`:146–149`) requires `submitComposerPrompt(` in `ChatComposer.tsx`.

The Conversation path now resets browsing on submit. Feature ② is met.

---

## ③ Markdown render preference — PASS

Acceptance: 设置「通用/偏好」中的 markdown 开关默认启用，关闭后用户与 Agent 消息均为纯文本，复制原文不受影响.

Evidence:

- Defaults: `src/web/preferences.ts:27–29` `markdownRendering: true`. Storage key `graph-pref-markdown-rendering` (`:32`). localStorage only; blocked/missing storage degrades to the default (`readPreference` try/catch). No server table / API / DB.
- Settings: `src/web/Settings.tsx:341` sidebar **first** item `{ id: 'settings-general', label: '通用/偏好' }` before 「常规」. Default active page remains `settings-overview` (`:335`), so existing settings tests that land on 「常规」 are not broken. Both toggles live in the same `<section id="settings-general">` (`:262–292`).
- Rendering:
  - Conversation passes `markdown={markdownEnabled(preferences)}` (`Conversation.tsx:1009`).
  - User bubble: `TranscriptRows.tsx:45` `markdown ? <Markdown/> : <p>{message.text}</p>`.
  - Finished assistant: `:70` `markdown ? <Markdown/> : <p className="message-plain">`.
  - Streaming assistant: `:273–297` markdown blocks vs `PlainText`; `PlainText` (`:225–244`) keeps `stream-veil` spans; streaming caret (`:298`) is outside the markdown branch. Veil / streaming behaviour preserved when off.
- Copy: every row still uses `copyable={copyText(row)}` (`TranscriptRows.tsx:317–323`). `copyText` (`src/web/chat-copy.ts:15–18`) returns the original transcript text, independent of the `markdown` prop.
- Tests: `tests/console/preferences.test.ts` covers default-on and `markdownEnabled` following the preference. Frozen check-prefs 11/11.

---

## ④ Candidate prompt toggle — PASS

Acceptance: 候选 prompt 开关位于同一板块、默认禁用，禁用时不显示候选提示，启用后恢复现有行为.

Evidence:

- Default: `DEFAULT_PREFERENCES.candidatePrompt === false` (`preferences.ts:28`). Key `graph-pref-candidate-prompt`.
- Same settings section as markdown (`Settings.tsx:279–290`, `data-testid="pref-candidate-prompt"`).
- Gate is in Conversation, not ChatComposer (matches the preferences-lane constraint): `Conversation.tsx:647` `promptSuggestion = visibleSuggestion(preferences, snapshot.promptSuggestion)`. That value feeds `suggestion={promptSuggestion}` (`:1172`), `hasSuggestion={Boolean(promptSuggestion)}` (`:1186`, `:1193`), Enter-empty send (`:746`), and primary `suggestion` action (`:764`). When the preference is off, `visibleSuggestion` returns `null` (`preferences.ts:93–97`), so the composer never receives a suggestion, Tab-fill (`ChatComposer.tsx:637` `showingSuggestion`) is false, and the primary control does not enter the suggestion branch.
- Enabling the preference restores the previous `snapshot.promptSuggestion` path unchanged.
- Tests: default-off + pass-through when on, in `tests/console/preferences.test.ts:102–115`. Pure logic: no playwright / jsdom / ports / subprocess.

---

## Constraints — compliant

- No new dependencies (`package.json` unchanged for this work; `chat-undo` / `chat-history` / `preferences` are local modules).
- No IPC / Electron / adapter / server / DB change. Preferences are `localStorage` with prefix `graph-pref-`.
- Lane ownership: `styles.css` only gained the composer browsing hint (composer lane). Preference styles live in `src/web/preferences.css` imported from `preferences.ts`.
- Composer-lane files were restored onto the integration copy before the preferences lane edited Conversation / Settings / TranscriptRows (handoff `a29ab927@1`). Working tree is clean at `c7e00c5`.

---

## Non-blocking notes (do not fail)

1. **Browsing visual hint never applies.** `data-history="browsing"` is set on the **textarea** (`ChatComposer.tsx:508`) but the CSS selector is `.chat-composer[data-history='browsing']` (`styles.css:618`), which matches the outer div. The faint-border hint is dead. Acceptance does not require a visual mark; behaviour (cursor / `historyBrowsing` / ↑↓) is correct. Optional one-line fix: put the attribute on the outer `.chat-composer` or change the selector to `textarea[data-history='browsing']`.

2. **Existing Playwright candidate-prompt test will disagree with the new default.** `tests/m8/app-shell-ux.test.ts:453` asserts `data-suggestion` after a first turn with no preference opt-in. That file is outside this task's `files` list and was correctly left alone. Product requirement is 默认禁用; a follow-up should either opt that test in (set `graph-pref-candidate-prompt=true`) or assert the off default.

3. **Agent-node transcript ignores the preference.** `AgentNodeChat.tsx:197` renders `TranscriptRowView` without `markdown`, so it stays at the component default `true`. Out of the conversation-composer scope of this batch.

4. **Undo from a recalled prompt does not restore the draft.** ↑ uses `applyProgrammatic` (no undo snapshot), so ⌘Z after a recall jumps to the last typed snapshot, not `history.draft`. ↓ is the documented restore. Not in acceptance.

---

## Recommendation

Pass. Human check (`human-a2`) should still confirm on a real console: ⌘Z / ⇧⌘Z over type / right-click paste / delete / clear; ↑↓ including the recall → Enter → ↑ cycle; both settings toggles.
