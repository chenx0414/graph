# Independent review: batch A group 3 (composer attachments and images)

Verdict: fail

Reviewed HEAD `0c48af7` on `graph/copy/8d3dcc43-d4a0-4ea7-b21b-fbee3380fc06/review`, which contains both implementation commits on top of product-line `72283df`:

- `6a543ca` graph:impl-runtime-attachments
- `0c48af7` graph:impl-composer-attachments

Working tree was clean. Program checks supplied to this review all exited 0:

- typecheck: `/Users/macmini/Library/Application Support/Graph/state/checks/check-types.json`
- runtime payload: `/Users/macmini/Library/Application Support/Graph/state/checks/check-runtime-payload.json` (5 tests)
- composer rules: `/Users/macmini/Library/Application Support/Graph/state/checks/check-composer-rules.json` (21 tests)

Those checks do not exercise the sandbox worker call that actually delivers images to the SDK. Human acceptance is still open and is not treated as passed.

## Finding 1 (blocking): sandbox delivery drops images before the SDK

Acceptance `attachment-delivery` requires image attachments to arrive as `ImageContent` through Graph's `AgentSession.prompt(text, { images })` and then the SDK's `prompt(text, { images })`. The production master path does not do that.

The live adapter defaults to the restricted subprocess transport:

- `src/runtime/pi-adapter.ts:154` uses `createRestrictedProcessAgentSessionTransport()` unless a test injects another transport.
- `src/core/task-runtime.ts:371` constructs that adapter with no `transport` override.

The host side of that path is correct. `src/runtime/pi-process.ts:288-293` writes `{ operation: 'prompt', text, images }` when images are present. The worker then calls the wrong SDK signature:

```ts
// src/runtime/pi-worker.ts:188-191
const runPrompt = async (text: string, images: ImageContent[] | undefined) => {
  ...
  await session.prompt(text, images?.length ? images : undefined);
};
```

`session` here is the object returned by `openPiInstance` (`src/runtime/pi-worker.ts:144`), whose `prompt` forwards to the SDK session from `@earendil-works/pi-coding-agent`:

```ts
// src/runtime/pi-instance.ts:360-362
async prompt(text: string, images?: ImageContent[]) {
  stopRequested = false;
  await session.prompt(text, images?.length ? { images } : undefined);
}
```

The installed SDK (`@earendil-works/pi-coding-agent` `dist/core/agent-session.d.ts:148-153,359`) declares `prompt(text: string, options?: PromptOptions)` with `PromptOptions.images?: ImageContent[]`. Its implementation reads only `options?.images` (`dist/core/agent-session.js:821` and the following `currentImages = options?.images`). An `ImageContent[]` has no `images` property, so `currentImages` is `undefined` and the model turn is text-only.

TypeScript does not catch this because `ImageContent[]` is a valid `PromptOptions` under the SDK's structural typing: an array is an object and the optional fields are simply absent. `node --run typecheck` passing is therefore not evidence that the call is correct.

Impact: pasting or dropping a png/jpeg/webp/gif in the real console stores and displays the image, but the master Agent's sandboxed session never receives it as `ImageContent`. Human acceptance ("回复表明它读到了图片") cannot succeed on the production transport. Text attachments are unaffected because their body is inlined into the briefing (`src/catalog/briefing.ts:11-18`), not passed through this argument.

The in-process transport (`src/runtime/agent-session.ts:190-193` calling `instance.prompt`) is the path that wraps correctly. It is not the default master path.

The required fix is at the worker boundary: `pi-worker.ts` must call `session.prompt(text, images?.length ? { images } : undefined)`. `pi-instance.ts` already has the correct shape and must not be "fixed" by removing the wrap, or the in-process path would break. A regression test should import the worker prompt mapping (or a pure helper both call sites share) and assert the SDK receives `{ images: [{ type: 'image', data, mimeType }] }`, not a bare array. The existing payload test only asserts `promptImagesFromAttachments` and never reaches `pi-worker.ts`.

## What does meet the acceptance

- `AttachmentInput` is backward compatible: `{ name, type, size, text, data? }` in `src/core/types.ts:227`.
- Request-layer limits reject rather than drop: image whitelist png/jpeg/webp/gif, 5 MiB per image, 8 MiB per message, visible `RuntimeError` text (`src/core/attachments.ts:34-92`). Fastify `bodyLimit` is 24 MiB so an 8 MiB base64 body is not rejected by the default 1 MiB parser (`src/server/app.ts:67-70`).
- Text attachments stay in the briefing; image base64 is not copied into the briefing (`src/catalog/briefing.ts:11-18`).
- Ledger write keeps the full payload in `messages.data` (`src/core/task-runtime.ts:794-798` and `986-994` via `appendMessage`). `publicMessage` / `listMessages` strip `data` before the conversation view and events (`src/core/conversation.ts:39-46`). The payload test writes a real sqlite row and asserts the raw column still contains base64 while `listMessages` and `publicMessage` do not.
- Composer paste (`clipboardData.files`) and drop (`dataTransfer.files`) both go through `validateAttachment` / `buildAttachment`, and a rejection is toasted (`src/web/ChatComposer.tsx:299-330, 472-486`). Chips show a local DataURL preview, name, and size, and can be removed (`541-554`). Send clears attachment state (`src/web/Conversation.tsx:697-702`). Draft persistence writes only the text string (`src/web/composer-state.ts:56-61`, `src/web/Conversation.tsx:553,579`).
- History rows render attachment names only (`src/web/TranscriptRows.tsx:36-54`). `messageAttachments` does not project `data`.
- No new dependency was added. PDF/docx are refused, not parsed. No Electron/IPC change is in the diff.
- Both new tests are pure logic: no playwright, jsdom, listen, or child process.

## Non-blocking gaps

- New-conversation create sends the raw `ChatAttachment[]`, including the local `preview` DataURL (`src/web/App.tsx:540`). The follow-up message path correctly uses `attachmentPayload`. `cleanAttachments` happens to drop unknown fields, so the server still stores a valid image, but the create request body is larger than necessary and diverges from the conversation send path. On failure, `start()` restores text but not attachments.
- `messageAttachments` requires `text` to be a string (`src/core/conversation-projection.ts:316`). An image chip with empty `text` still renders; a legacy row whose image omitted `text` would disappear from history. Current writers always set `text: ''`.
- Composer classification accepts an image by extension even when the browser mime is `application/octet-stream` (`src/web/attachments.ts:120-121`). The request layer then requires the normalized image mime, which `buildAttachment` does set. That is consistent, but a client that posted the raw browser mime would be rejected server-side. Not a silent drop.
- Lane ownership was not exclusive. Runtime also changed `src/catalog/briefing.ts`, and both lanes added `src/core/attachments.ts`, which was not in the frozen file list. The shared module is justified; the briefing change is required so image bytes do not ride along in the text prompt. Noted only so the next lane does not treat those files as untouched.
- `clearComposerAttachments()` in the composer test returns a fresh empty array and does not prove the React send path clears state. The send path itself does (`setAttachments([])`). DOM paste/drop/preview remains for human acceptance, as specified.
- Steering is text-only and names an image instead of attaching it (`src/core/task-runtime.ts:70-75`). That matches the current steer API and is outside this acceptance, but a queued image message that is steered rather than delivered as the next prompt will not include pixels.

## Acceptance matrix

| id | result | note |
| --- | --- | --- |
| attachment-rules | met for the pure rules | composer module rejects unsupported types and over-limit files with a reason; DOM paste/drop is implemented but not executed by the check |
| attachment-chips | met for state rules | chips, preview, remove, clear-on-send, and text-only draft are in the UI; the unit test only covers the pure helpers |
| attachment-delivery | not met | sandbox worker calls SDK `prompt(text, imagesArray)`, so production master turns do not receive `ImageContent` |
| attachment-ledger | met | full payload in `messages.data`; view/event projection returns metadata only |
| typecheck | met | supplied check exited 0; it does not detect the SDK options mismatch |
| human-a3 | not yet run | expected to fail for images until finding 1 is fixed; text `.md` delivery should work |
