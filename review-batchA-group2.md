# Independent Review — 批 A 第二组（聊天框输入体验）

Requirement version: 1
Reviewer: reviewer@8 (independent)
Base reviewed: worktree HEAD `e5a6a60` (merge of impl-composer-input `14126a1` + impl-preferences `21769ef`)
Scope: undo/redo (①), ↑/↓ sent-prompt history (②), Markdown render preference (③), candidate-prompt preference (④)

## Verdict summary

All five program checks pass (see Evidence). Features ①, ③ and ④ fully meet their
acceptance criteria. Feature ② meets its three enumerated sub-clauses on a fresh
interaction, but ships one **real behavioral defect in the product's actual code
path** that the accompanying test does not catch (the test exercises a dead-code
branch). Detail below. Verdict: **fail** — one focused, low-risk fix.

## Evidence (frozen check results)

| Check | Result | Evidence |
|-------|--------|----------|
| check-types | code 0 | `state/checks/check-types.json` |
| check-undo | code 0, 10 tests pass | `state/checks/check-undo.json` |
| check-history | code 0, 14 tests pass | `state/checks/check-history.json` |
| check-prefs | code 0, 11 tests pass | `state/checks/check-prefs.json` |

---

## Feature ③ + ④ — Preferences (Markdown render + candidate prompt) — PASS

- `src/web/preferences.ts` holds pure, storage-optional logic. Defaults are
  `markdownRendering: true`, `candidatePrompt: false` (`DEFAULT_PREFERENCES`),
  matching "默认启用 / 默认禁用". Keys are `graph-pref-*` (`PREFERENCES_PREFIX`);
  storage is `localStorage` only — no server table/API/DB touched (constraint kept).
- `src/web/Settings.tsx:341` adds sidebar **first** item `{ id: 'settings-general', label: '通用/偏好' }`,
  before `settings-overview`「常规」. `PreferencesPage` (`Settings.tsx:259`) renders both
  toggles in the **same** section `<section id="settings-general">` — satisfies both
  "sidebar 首项" and "同一板块".
- Markdown (③) is wired to **both** user and agent messages:
  - user bubble: `TranscriptRows.tsx` `MessageRow` → `markdown ? <Markdown/> : <p>{text}</p>`
  - agent final answer: `MessageRow` assistant branch → `markdown ? <Markdown/> : <p className="message-plain">`
  - agent streaming response: `AssistantResponse` → markdown blocks vs `PlainText`.
  - When off, streaming veils + caret are preserved via `PlainText` (keeps
    `stream-veil` spans) → "保留现有流式显示与 veil 行为" met.
  - Copy is unaffected: every row passes `copyable={copyText(row)}` (original text),
    independent of the `markdown` prop → "复制按钮仍取原文" met.
- Candidate prompt (④) default off: `visibleSuggestion` returns `null` unless
  `candidatePrompt` is true. `Conversation.tsx:647` gates `promptSuggestion` through it,
  which feeds `suggestion={promptSuggestion}` (line 1172) and the `suggestion` send
  action (line 764, guarded `if (promptSuggestion)`). Disabled → no candidate shown;
  enabled → existing behavior restored. Met.
- `tests/console/preferences.test.ts` is pure logic (no playwright/jsdom/ports/subprocess)
  and covers defaults, keys, round-trip, blocked-storage fallback, and both decisions.

## Feature ① — Undo / redo — PASS

- `src/web/chat-undo.ts`: explicit snapshot stack (`past`/`future`), limit
  `COMPOSER_UNDO_LIMIT = 100`, not persisted. `composerEditKind` classifies
  `typing | paste | delete | clear | insert`.
- All four required edit kinds are recorded through the single `rememberEdit` path:
  typing/paste/delete/clear via the textarea `onChange` (`ChatComposer.tsx:512`),
  right-click paste via `pasteClipboardAtCaret` (`:329`), slash/mention insertion
  (`:353,:370,:406`). cmd+Z / cmd+shift+Z (and cmd+Y) handled at `:536` before all
  other bindings → does not conflict with the `/`/`@` menus.
- `tests/console/composer-undo.test.ts` covers: typed run undo, right-click paste
  undo, delete + clear undo, redo + redo-invalidation, no-op skip, the 100-step cap
  in both directions, and `composerEditKind` classification. Acceptance ① fully met.

## Feature ② — ↑/↓ sent-prompt history — ACCEPTANCE SUB-CLAUSES MET, BUT ONE DEFECT

What works (matches the three enumerated sub-clauses):
- Recall: `composerHistoryUp/Down` walk the sent prompts; source is
  `sentUserPrompts(displayMessages)` (`Conversation.tsx:845`, user-role, non-briefing,
  non-queued/cancelled, deduped) passed as `history={composerHistory}` (`:1181`) —
  "历史来源为该会话已发送的用户消息" met.
- Menu precedence: the history branch (`ChatComposer.tsx:606`) is gated
  `!slashOpen && !mentionOpen` and sits **after** the `/` and `@` handlers, so the
  menus win the arrow keys → "不与 / 与 @ 菜单冲突" met. At the earliest prompt
  `composerHistoryUp` returns `null` (falls through to caret move) → "到最早一条后停住" met.
- Draft: first ↑ stores the draft (`composerHistoryUp`), ↓ past the newest restores it →
  "草稿不丢" met on a fresh browse.

### Defect D1 (Medium) — browse cursor is not reset when a recalled prompt is sent unedited, so the next ↑ skips the newest prompt

- Where: `src/web/ChatComposer.tsx` `rememberPrompt()` (`:226-230`) and the Enter/submit
  handler (`:649-654`); interaction with `src/web/Conversation.tsx` `send()` (`:690-700`).
- Evidence:
  - `rememberPrompt()` begins `if (history !== undefined) return;`. In the product,
    `Conversation` always passes `history={composerHistory}` (a defined array), so
    `rememberPrompt` **early-returns** and never calls `recordComposerPrompt` /
    `setHistoryBrowsing(false)`. `recordComposerPrompt` is therefore **dead code in the
    Conversation path**.
  - The Enter handler calls `rememberPrompt(); (onSubmit ?? onSend)();` and does **not**
    call `leaveHistory()`. `Conversation.send()` then clears the box with `setText('')`
    (a programmatic state setter), which does **not** fire the textarea `onChange` — the
    only path that calls `leaveHistory()` (`:513`). `historyRef.current` is reset only by
    `leaveHistory` (`:205`, manual edit/undo/redo), `rememberPrompt` (`:228`, dead here),
    and arrow moves (`:616,:628`). No effect resets it when `value` becomes `''`.
  - Result: after `↑` (recall) → `Enter` (send unedited) → box cleared, `historyRef.current.cursor`
    stays non-null and `historyBrowsing` stays `true` (also leaves `data-history="browsing"`
    on an empty box).
- Impact (reproducible, common flow): with sent prompts `["A","B","C"]` (C newest),
  `↑` shows "C" (cursor 0). Press `Enter` to resend "C". Box clears but cursor stays 0.
  Next `↑` takes the `browsing` branch and advances `cursor 0→1`, showing "B" — it
  **skips "C"** instead of returning the newest prompt from the now-empty box. Expected
  (and what the standalone path does): resend resets browsing so `↑` shows "C". This is
  feature ② behaving incorrectly in a normal recall→resend→recall cycle.
- Why the tests don't catch it: `tests/console/composer-history.test.ts` "sending resets the
  browsing position" exercises `recordComposerPrompt`, which the Conversation path never
  calls; the "sending a prompt feeds the recalled history" source-assertion only checks
  `rememberPrompt()` is present. The green `check-history` result gives false confidence.
- Fix (small, no new deps): in `rememberPrompt`, reset the browse state even when the
  parent owns `entries` — e.g. move `historyRef.current = resetComposerHistory(historyRef.current);
  setHistoryBrowsing(false);` to run before (or instead of) the `history !== undefined`
  early-return — or call `leaveHistory()` in the Enter/submit path. Keep `chat-history.ts`
  and its tests as-is.

## Constraints — compliant

- No new dependencies, no IPC/Electron/adapter change, no server/DB change (preferences
  are `localStorage` only). `styles.css` untouched in the preferences lane; preference
  styles live in `src/web/preferences.css` imported by `preferences.ts`.
- impl-composer-input lane files (`chat-undo.ts`, `chat-history.ts`, their tests,
  `styles.css`) were not rewritten by the preferences lane.

## Notes / non-blocking

- Undo coalescing (a hand-typed run undoes as one step) is a deliberate, documented UX
  choice in `chat-undo.ts`; it still satisfies "输入…入栈" because each kind is recorded.
  Not a defect.

## Recommendation

Address D1 (one-line-ish reset in `rememberPrompt` / submit path). Everything else is
solid and well-tested. I recommend **fail** solely on D1 so the feature-② recall path is
correct in the Conversation code path that actually ships; the remaining acceptance
items pass and would not block.
