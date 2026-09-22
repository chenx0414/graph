# Independent review: batch A group 3 (composer attachments and images)

Verdict: pass

Reviewed HEAD `da8626af1707d289f2c9ef3d8f7044f8a5a008d7` on `graph/copy/8d3dcc43-d4a0-4ea7-b21b-fbee3380fc06/review`. Working tree was clean. The relevant implementation commits are:

- `6a543ca` runtime contract (types, ledger, request limits, image mapping)
- `84ee76c` production SDK options fix (`sdkPromptOptions`)
- `0c48af7` composer paste/drop, chips, payload conversion

Program checks supplied to this review all exited 0:

- typecheck: `/Users/macmini/Library/Application Support/Graph/state/checks/check-types.json` (`a2474bb10d1b87b61cb5493332b6e2be75ab0cbbe8526c2f89c29c771030fdb3`)
- runtime payload: `/Users/macmini/Library/Application Support/Graph/state/checks/check-runtime-payload.json` (`95a8f927db84c344ab52578c56a78a629b48b4495f9492fa65146fcc64abcb01`), 6 tests
- composer rules: `/Users/macmini/Library/Application Support/Graph/state/checks/check-composer-rules.json` (`d5daa2e5fb31d3e3f98622eadf19820f3420054a9410f7947afe2aa07e845606`), 21 tests

Human acceptance is still open and is not treated as passed. DOM paste/drop/preview is intentionally outside the sandbox checks.

## Delivery signatures

The previously blocking worker call is fixed. Both Graph paths now produce SDK `PromptOptions.images`.

1. Graph `AgentSession.prompt(text: string, images?: ImageContent[])` (`src/runtime/agent-session.ts:94`).
   - In-process transport calls `instance.prompt(text, sdkPromptOptions(images))` (`src/runtime/agent-session.ts:191-194`).
   - Restricted-process transport calls `process.prompt(text, images)` (`src/runtime/agent-session.ts:225-228`). That second argument is still an `ImageContent[]`; the process boundary writes `{ operation: 'prompt', text, images }` (`src/runtime/pi-process.ts:288-293`).
2. Worker `openPiInstance(...).prompt(text: string, options?: PromptOptions)` forwards `options` unchanged to the SDK (`src/runtime/pi-instance.ts:360-362`). The worker command handler calls `session.prompt(text, sdkPromptOptions(images))` (`src/runtime/pi-worker.ts:189-192`).
3. SDK `@earendil-works/pi-coding-agent@0.85.1` declares `prompt(text: string, options?: PromptOptions)` with `PromptOptions.images?: ImageContent[]` (`dist/core/agent-session.d.ts:149-153,359`). The implementation reads `options?.images` and spreads that array into the user message (`dist/core/agent-session.js:841,901-902`).

`sdkPromptOptions` returns `{ images }` for a nonempty array and `undefined` otherwise (`src/runtime/prompt-options.ts:11-12`). The production adapter still passes a bare array into Graph's `AgentSession.prompt` (`src/runtime/pi-adapter.ts:896-899`). That is the Graph wrapper signature, not the SDK signature. Because an array's `length` is truthy, wrapping it again with `sdkPromptOptions` still yields `{ images: ImageContent[] }`. A direct node evaluation of that shape confirmed `options.images` remains the original image array, which is what the SDK spreads.

Text attachments do not depend on this argument. The briefing inlines their text and only names images (`src/catalog/briefing.ts:11-18`).

## Acceptance

- attachment-rules: composer classification accepts png/jpeg/webp/gif and text extensions (md/txt/csv/json/code), and returns a concrete reason for pdf/docx/bmp/tiff, oversize images, and the 8MB message total (`src/web/attachments.ts:117-163`). Paste (`ChatComposer.tsx:322-341`) and drop (`ChatComposer.tsx:472-486`) both call that module and toast the reason (`src/web/ui.tsx:146`). Request-layer `cleanAttachments` independently rejects unsupported data payloads and the 5 MiB / 8 MiB ceilings (`src/core/attachments.ts:34-92`). Fastify `bodyLimit` is 24 MiB, so the JSON parser does not swallow a legal image body (`src/server/app.ts:67-70`).
- attachment-chips: selected items render above the input with name, size, a local DataURL preview for images, and a per-item remove button (`src/web/ChatComposer.tsx:541-554`, styles at `src/web/styles.css:2086-2134`). Conversation send clears attachment state (`src/web/Conversation.tsx:698-702`). Draft persistence reads and writes only the text string (`src/web/Conversation.tsx:553,579`, `src/web/composer-state.ts:46-61`).
- attachment-delivery: `promptImagesFromAttachments` maps image `data` + mime to `{ type: 'image', data, mimeType }` (`src/core/attachments.ts:97-103`). Both session transports and the worker then place that array in SDK `options.images`, as traced above. No SDK file, dependency, Electron, or IPC change is in the implementation commits. `package.json` dependencies are unchanged.
- attachment-ledger: create and chat persist the cleaned attachment payload, including image base64, in `messages.data` (`src/core/task-runtime.ts:794-798,986-994`). `publicMessage` strips every attachment `data` field before the view and stream events (`src/core/conversation.ts:39-46`, `src/core/attachments.ts:109-118`). `listMessages` returns only `publicMessage` (`src/core/conversation.ts:331-342`). The payload test writes a sqlite row and asserts the raw column keeps base64 while both projections omit it.
- typecheck: the supplied check exited 0.

## Non-blocking notes

- New-conversation create sends the raw `ChatAttachment[]`, including the local preview DataURL (`src/web/App.tsx:540`). `cleanAttachments` drops unknown fields, so the ledger still stores a valid image. The follow-up path correctly uses `attachmentPayload`. On create failure, text is restored but attachments are not.
- `messageAttachments` requires `text` to be a string (`src/core/conversation-projection.ts:316`). Current writers always set `text: ''` for images, so history chips still render names only (`src/web/TranscriptRows.tsx:36-54`). A legacy image row that omitted `text` would disappear from the view.
- Steering is text-only and names an image instead of attaching pixels (`src/core/task-runtime.ts:70-75`). That matches the current steer API and is outside this acceptance.
- The sandbox tests cover the pure rules and `sdkPromptOptions`; they do not execute the worker. The production call sites were verified by source and by evaluating the wrapper shape against the installed SDK. Real console paste of one image and one `.md` remains the open human check.
