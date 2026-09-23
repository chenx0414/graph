# Independent review: 批 A 第三组（输入框附件与图片，零依赖版）

Verdict: **fail**

Reviewed tree: `9b7ed6f` on `graph/copy/8d3dcc43-d4a0-4ea7-b21b-fbee3380fc06/review`, diff against `72283df`.

Program checks (evidence only, not re-run):

- `check-types` exit 0 (`a2474bb10d1b87b61cb5493332b6e2be75ab0cbbe8526c2f89c29c771030fdb3`)
- `check-runtime-payload` 6/6 passed (`670435f660df5d0976f894d2a171e991516a7fd0cc6a8739ba7a68d5bdd0f966`)
- `check-composer-rules` 25/25 passed (`70f02f5a5315708e40fc9de364b039d53f28b5fd6f5a992390b28f6f0630b95b`)

Those checks do not exercise the new-conversation send body.

## Blocking defect

### New conversation send posts the local DataURL preview as image `data`, so the request layer rejects every pasted/dropped image

`src/web/App.tsx` `NewConversation.start` posts the composer state object itself:

```540:540:src/web/App.tsx
          ...(attachments.length ? { attachments } : {}),
```

A built image chip always includes `preview` (a `data:image/...;base64,...` URL) and `data` (raw base64). `buildAttachment` in `src/web/attachments.ts` sets both. The existing conversation path strips the preview via `attachmentPayload` (`src/web/Conversation.tsx` around the `/messages` POST). The new-conversation path does not.

`src/core/attachments.ts` `cleanAttachments` is what `conversations.create` calls before writing the ledger. For a whitelisted image it requires `attachment.data` to match `^[A-Za-z0-9+/]*={0,2}$`. A DataURL contains `:` and `,`, so that check fails and throws `图片 ${name} 不是有效的 base64 数据`.

Confirmed with a one-line check of that regex against a real composer DataURL: it does not match.

Impact:

- Pasting or dropping a png/jpeg/webp/gif on “开始新对话” and sending is rejected. The chip looks valid, then the start request fails with a visible server error and the conversation is not created.
- `human-a3` (“在真实控制台粘贴一张图片与一个 .md 文件…并发送”) is the new-conversation surface. This path cannot deliver the image as `ImageContent` or record it in the ledger.
- The follow-up message path (`Conversation.send` → `attachmentPayload`) is correctly shaped and is not this defect. The first message of a conversation never reaches it.

Required fix: post `attachmentPayload(attachments)` (or an equivalent that drops `preview` and sends only `{ name, type, size, text, data? }`) from `NewConversation.start`, and clear attachments after a successful create the same way `Conversation.send` does. Add a pure assertion that the create body does not contain `data:` / `preview`.

## What does hold

- Contract: `AttachmentInput` gained optional `data`; text still uses `text`. `src/core/types.ts`.
- Delivery for an already-created conversation: `promptImagesFromAttachments` maps images to `{ type: 'image', data, mimeType }`, and both in-process and worker paths wrap that with `sdkPromptOptions` so the SDK sees `prompt(text, { images })`. `src/runtime/prompt-options.ts`, `agent-session.ts`, `pi-instance.ts`, `pi-process.ts`, `pi-worker.ts`, `pi-adapter.ts`. No SDK edit, no new dependency, no Electron/IPC change.
- Ledger: full payload (including base64) is stored in `messages.data`; `publicMessage` runs `stripAttachmentData`, so list/view/events return name/type/size (and text) only. `src/core/conversation.ts`.
- Composer rules: whitelist, 5MB/8MB/1MB limits, per-file `rejectionNotices`, chips with local preview and `aria-label="移除附件 …"`, send clears notices, draft persistence writes only the text string (`writeComposerDraft` in `Conversation.tsx`). Rejection notices do not disable send.
- Text attachments are inlined in the briefing; image bytes are not. `src/catalog/briefing.ts`.
- Body limit raised to 24 MiB so an 8 MiB image payload can reach `cleanAttachments`. `src/server/app.ts`.

## Non-blocking notes

- `src/web/attachments.ts` and `src/core/attachments.ts` duplicate the same limits. Drift is possible; not an acceptance failure by itself.
- `clearComposerAttachments()` is a constant empty array. The composer test named “发送后清空” does not prove the component clears state. The component does clear on send; the new-conversation path does not clear attachments on success (secondary to the blocking defect: the request fails before that matters).
- Lane notes said `styles.css` belongs only to the UI lane. The merged diff touches it only for composer attachment/notice styles. Acceptable.
- Out-of-lane edits (`src/catalog/briefing.ts`, `src/runtime/pi-instance.ts`, `src/runtime/pi-process.ts`, `src/core/attachments.ts`) are required for the delivery contract. They are not a defect.
- Full `node --run check` was not part of this review’s program inputs. The recorded P3 still stands for the human gate; it does not excuse the new-conversation payload bug above.
