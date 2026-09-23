# 批 A 第三组独立审查：输入框附件与图片（零依赖版）

verdict: pass

审查范围是冻结工作副本上相对 `00c3afe` 的附件实现，以及三条已通过的程序检查。未改实现文件，未读实现会话。

## 程序检查

- `check-types`（`node --run typecheck`）exit 0。证据 `/Users/macmini/Library/Application Support/Graph/state/checks/check-types.json`，digest `a2474bb10d1b87b61cb5493332b6e2be75ab0cbbe8526c2f89c29c771030fdb3`。
- `check-runtime-payload` 运行 `tests/console/attachments-payload.test.ts`，6 tests passed，exit 0。digest `5be8295840c6b857e04a64e416433c243fca6061d99116674fd95e3d2f424b05`。
- `check-composer-rules` 运行 `tests/console/attachments-composer.test.ts`，27 tests passed，exit 0。digest `d8f5f9595110a8daf6716b670c90e48f81c241fd947cb6802d6e0b79a880ea66`。
- 两个测试文件无 playwright、jsdom、listen 或子进程启动。payload 测试只用临时目录上的 `TaskStore` 做账本读写。

## 验收对照

### attachment-rules / attachment-chips

`src/web/attachments.ts` 接受 png/jpeg/webp/gif（mime 或扩展名）以及 md/txt/csv/json/代码类扩展名；pdf、docx、bmp、tiff、exe 返回带原因的拒绝。图片单文件 5MB、单条消息图片 8MB、文本单文件 1MB 均在 `validateAttachment` 中拒绝并写明上限。

`src/web/ChatComposer.tsx` 的 `onPaste`（`clipboardData.files`）与 `onDrop` 都走 `addAttachments`。被拒文件经 `rejectionNotices` 渲染到输入框上方 `role="alert"` 的 `.composer-notices`，文案为「文件名：原因」，混合输入只列被拒项。下一次全部接受的添加会把通知设为空数组；发送按钮点击与 Enter 也会清空通知。拒绝通知不进入 `sendDisabled`。

已选附件在输入框上方以条目显示：图片用本地 `preview` DataURL，并显示名称与 `attachmentSize`；移除按钮 `aria-label` 为「移除附件 {name}」。`styles.css` 只增加本功能的条目、预览、拖入轮廓和拒绝提示样式。

发送后清空：既有会话 `Conversation.tsx` 的 `send()` 在请求前 `setAttachments([])`，失败再恢复。草稿只写文本：`writeComposerDraft(..., text)`，附件状态不进入 `composer-state.ts`。`clearComposerAttachments()` 被纯逻辑测试钉住。

新对话入口 `App.tsx` 成功后靠导航离开页面，失败时保留附件以便重试；请求体已改用 `attachmentPayload`。这不构成验收缺口。

### attachment-delivery

`AttachmentInput` 为 `{ name, type, size, text, data? }`。文本走 `text`；图片 `text` 为空、`data` 为 base64、`type` 为白名单 mime。

送达链：

- `pi-adapter.ts` 用 `promptImagesFromAttachments` 得到 `{ type:'image', data, mimeType }`，作为 `AgentSession.prompt` 的第二参数。
- 进程内 transport（`agent-session.ts`）用 `sdkPromptOptions(images)` 包成 `{ images }` 再调用实例 `prompt(text, options?)`。
- 沙箱 transport（`pi-process.ts`）在 JSON 行里带 `images`；`pi-worker.ts` 解析后同样经 `sdkPromptOptions` 调用 `session.prompt`。
- `prompt-options.ts` 在无图片时返回 `undefined`，避免把数组直接当第二参数。测试钉住了 `{ images: [{ type, data, mimeType }] }`。
- 文本附件进入 `briefing.ts` 的代码块；图片 briefing 只写名称/大小/类型，不含 base64。

未改 SDK，`package.json` 未新增依赖，未改 Electron/IPC。请求层 `cleanAttachments` 对超限、非白名单带 data 的类型、无效 base64 抛出带原因的 `RuntimeError`，由 Fastify 错误处理返回可见 `message`。图片不落盘。

### attachment-ledger

`conversations.create` / `chat` 把清洗后的附件（含图片 base64）写入 `messages.data`。`publicMessage` 与 `listMessages` 经 `stripAttachmentData` 去掉每个附件的 `data`，视图保留 name/type/size；文本附件仍保留 `text`。`message.created` / `message.updated` 事件同样走 `publicMessage`。执行时 `pendingMessages` 读原始行，因此模型侧仍能拿到 base64。测试断言账本含 base64、视图与事件投影不含。

## 非阻断观察

- 新对话失败时不恢复被清空的输入文本（`setText(current => current || text)` 在已清空后不会写回），这是既有行为，与附件契约无关。
- 打断引导 `steeringText` 对图片只保留名称，不把 base64 塞进纯文本 steer。验收要求的送达路径是 `prompt(text, { images })`，steer 不是该路径。
- 客户端与请求层各有一套上限；请求层仍会拒绝绕过 UI 的超限载荷。

## 未覆盖项

`human-a3` 属于后续人工验收，本审查不代替真实控制台粘贴图片与 `.md` 的端到端确认。程序检查与代码路径已满足其余五项。
