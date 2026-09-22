# Independent review: chat paste + copy

Verdict: **pass**

Integration head: `ba7f98f` (merge of `4383feb` paste and `7aeda09` copy onto `7c72f64`).
Machine checks: `check-types` exit 0; `check-tests` 11/11 green
(`tests/m8/chat-ux-paste.test.ts` 5, `tests/m8/chat-ux-copy.test.ts` 6).
DOM-layer behaviour is out of this gate; human-paste / human-copy cover it.

## Scope vs parallel file sets

Diff vs `7c72f64` is only:

| Path | Owner node |
| --- | --- |
| `src/web/ChatComposer.tsx` | build-paste |
| `src/web/chat-paste.ts` | build-paste |
| `tests/m8/chat-ux-paste.test.ts` | build-paste |
| `src/web/TranscriptRows.tsx` | build-copy |
| `src/web/chat-copy.ts` | build-copy |
| `src/web/styles.css` | build-copy |
| `tests/m8/chat-ux-copy.test.ts` | build-copy |

Intersection of the two `input.files` sets is empty. Neither commit touches the other set.
`src/web/transcript-model.ts` was listed for build-copy as a type/source dependency and is **unchanged** — no extra behaviour, no shared new module.
No `package.json` / lockfile / IPC / main-process / `node_modules` changes.

Existing test files are untouched; new tests are additive.

## Paste: right-click inserts clipboard text at caret

Pure logic (`src/web/chat-paste.ts`):

- `insertAtCaret({ value, start, end, text }) → { value, caret }`
  - no selection: insert at caret
  - selection: replace range, caret after inserted text
  - empty `text`: value unchanged, caret at selection start
- `readClipboardText`: missing reader, thrown denial, or non-string → `''` (no throw)

DOM wiring (`ChatComposer` textarea `onContextMenu`):

- `preventDefault()` — no custom menu, and no other `onContextMenu` in `src/web`
- `navigator.clipboard.readText()` through `readClipboardText`
- empty result: return without `onChange` / toast; still refocus
- non-empty: `insertAtCaret` → `onChange` + restore focus and caret via `setSelectionRange`

Focused tests assert the four required branches (no selection, replace selection, empty clipboard, denied read) plus a successful read.

## Copy: original text under user and agent bubbles

Pure logic (`src/web/chat-copy.ts`):

- Agent (`kind === 'assistant'`): `row.streaming ? '' : row.text` — transcript Markdown source, not rendered DOM
- User (`kind === 'message' && role === 'user'`): `row.message.text`
- streaming / system / tools / other: `''`

DOM wiring (`TranscriptRowView` → `MessageRow` / `AssistantResponse`):

- `{copyable && <div className="message-actions"><CopyButton text={copyable} />}` under the bubble
- empty `copyText` (including streaming) → no button
- click: `writeClipboardText(text, navigator.clipboard, toast)`
- success toast `'已复制到剪贴板'` / `'success'`; failure `'复制失败：…'` / `'danger'` — same channel as `AgentContext.copyPrompt`
- styles in `src/web/styles.css` (`.message-actions`, `.message-copy`) match existing message chrome

Focused tests assert Agent Markdown source, user original text, streaming empty, plus write success/failure toasts and empty no-op.

`row.text` for durable assistant rows is `message.text` from `buildTranscriptRows`; the Markdown renderer consumes that same source. Copy does not read innerText.

## Style / constraints

- Renderer-only; no new imports beyond existing `src/web` modules
- Strict TypeScript: frozen `check-types` exit 0
- Logic extracted to `chat-paste.ts` / `chat-copy.ts` so tests stay jsdom-free
- DOM structure stays readable (`message-stack` → content → `message-actions`)

## Non-blocking residuals (human checks)

1. Textarea `contextmenu` is always `preventDefault`’d, including empty/denied clipboard — native Cut/Copy/Select All in the composer is gone. Matches “no custom menu; other regions unchanged”; confirm in human-paste.
2. Copy button keys off `row.streaming`, not paced-reveal `visualStreaming`. After the source is complete the button can appear while the last tokens are still unveiling; full `row.text` is already stable.
3. Paste tests name “非文本” but assert denial / missing reader, not a non-string resolve. Implementation still maps non-string → `''`.

None of these contradict confirmed decisions or block this gate.

## Conclusion

Implementation matches the confirmed paste and copy behaviours, stays inside the disjoint file sets, adds no dependencies or IPC, preserves existing assertions, and has green typecheck plus focused tests. No blocking findings.

Independent verdict: **pass**
