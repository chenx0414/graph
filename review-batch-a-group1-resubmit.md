# 独立评审：批 A 第一组（聊天框基础体验，重新提交）

- 评审对象：任务 36b65807-5ab9-4d4d-ba7e-d0071d34eff5，impl-composer（fac881e0，v2）与 impl-telemetry-queue（eebc4a9b，v2）合并后的冻结版本
- 校验证据：check-types.json（a2474bb1…）、check-telemetry.json（47641072…）、check-queue.json（3c0d161f…）、check-composer.json（f6c1d805…）四个文件的 sha256 与交接清单逐一吻合，退出码均为 0
- 一致性：input.files 全部 11 个文件在本评审工作副本与运行检查的 integration 工作副本之间逐字节一致（sha256 相同），评审的代码即被检查的代码
- 结论：**fail**（一项验收差距：⑥暂停并入发送键的四状态与约定不一致；其余五项与全部约束核验通过）

## 发现

### F1（主要，验收差距）：输出中且输入框有内容时，发送键不暂停而是发送 —— 违反约定的四状态矩阵

约定（需求 ⑥ 与对话决策均明确）："输出中显示暂停；点一次暂停；输入框空且队列空时再点=继续运行；输入框有内容或队列非空时再点=发送该消息并自动继续"。四状态里第一态"输出中显示暂停"是无条件的，"有输入或队列非空再点=发送并自动继续"只发生在点过一次暂停之后。

实现（src/web/composer-state.ts:109-111）：

```ts
if (input.busy) {
  // Outputting: an empty composer offers pause, typed content still sends.
  return input.hasInput ? { mode: 'send', action: 'send' } : { mode: 'pause', action: 'pause' };
}
```

- 证据：`composerPrimaryState({busy:true, hasInput:true})` 返回 `{mode:'send', action:'send'}`；src/web/Conversation.tsx 的 `submitPrimary()` 对该 action 执行 `send()`（消息入队），不调用 `changePaused(true)`。src/web/ChatComposer.tsx 据此把按钮渲染成发送图标（`data-mode='send'`）。
- 影响：主 Agent 输出期间，只要输入框打了字，合并后的按钮就变成"发送"，点击不会暂停 —— 需求 ⑥ 第一条"输出中=暂停"在该分支落空，"暂停并入发送键"这一验收项（composer-interactions："四种状态行为与约定一致"）不满足。此时唯一的暂停入口退回标题栏按钮（src/web/Conversation.tsx:878-890），与"暂停并入发送键"的目标相悖。约定设计里 Enter 键本就保留了输出中发送/排队的能力（`submitEnter()` → `send()`），按钮与 Enter 的分工应是"按钮=暂停、Enter=发送"，实现把两者对调了。
- 检查为何没拦住：tests/console/composer-interactions.test.ts:114-116 把偏差固化成期望（`test('outputting with typed content still sends')` 期望 `{mode:'send',action:'send'}`），所以 check-composer 全绿只是与实现自洽，并不能证明"与约定一致"。该项验收实际未被任何检查覆盖。

### F2（次要）：暂停+空输入+队列非空时按钮动作是"继续"而非"发送并自动继续"

- 证据：src/web/composer-state.ts:106-107，`paused` 分支只看 `hasInput`，`queueLength>0` 且输入为空时返回 `{mode:'resume', action:'resume'}`；tests/console/composer-interactions.test.ts:126-128 固化了该行为（'paused with a nonempty queue resumes without sending'）。
- 影响：按约定该分支（输入框有内容**或队列非空**）属于"发送并自动继续"。实际效果上继续运行后队列会被投递并继续处理，与"发送并自动继续"的结果近似，故只构成按钮状态/图标/文案层面的不一致（显示 ▶继续 而非发送态），材料影响低；但同一验收项"与约定一致"同样未严格满足。

## 核验通过项

### ① 重载后上下文占用与缓存命中（telemetry-after-reload）✓

- src/core/conversation.ts `conversationMasterUsage`：invocations 经 operations→tasks 按 `t.conversation_id` 关联重建，不依赖 master 实例 id；`usage=null` 跳过；仅 `purpose==='completion' && input+cacheRead+cacheWrite>0` 才更新 `contextTokens`，全零完成行不再覆盖真实值；缓存聚合分母同口径。
- src/core/task-runtime.ts 的 conversation 视图改为消费该函数；`cacheHitRate = cacheInput>0 ? cachedInput/cacheInput : null`。
- tests/console/composer-telemetry.test.ts 四条要求断言齐备：①尾行全零、前一行真实用量（input:436, cacheRead:451200）→ contextTokens=451636；②usage=null 跳过；③跨实例（instance-old/instance-new）取到最近真实 completion，且真实 runtime 重载用例（改写 nodes.instance_id 后重开）过；④从未有有效 completion → null。另有 master 节点范围限定用例。
- 界面：src/web/ComposerTelemetry.tsx `telemetry-context`/`telemetry-cache` 直接消费上述数值（未改动，口径一致）。

### ② 排队消息逐条取消（queue-cancel）✓

- src/core/conversation.ts `cancelQueuedMessage`：仅 `conversation_id` 匹配且 `state='queued'` 的行可取消，UPDATE 带 `AND state='queued'` 原子守卫（与投递竞争时只有一方生效，绝不影响在途/已交付）；幂等（重复取消返回 `changed:false`）。
- src/core/task-runtime.ts `cancelMessage` 走 `store.command(conversation:${id}, requestId, …)` 幂等日志；src/server/app.ts 新增 `POST /api/conversations/:conversationId/messages/:messageId/cancel`，沿用 POST+requestId 风格。
- tests/console/conversation-queue.test.ts：逐条取消后剩余队列仍按序投递（排队二在放行后按序 delivered）、在途回合跑完不受影响、requestId 重放返回同一回执、已取消/已交付再取消为 no-op、跨会话与未知消息 no-op、HTTP 契约（POST+requestId）过。
- 前端逐条取消按钮（data-testid="queued-message-cancel"）已接线：乐观隐藏 + 失败回滚 + `visibleTranscriptMessages` 让被取消消息从 transcript 消失，`snapshot.queuedMessages` 天然按序过滤。

### ③ 输入框高度自适应 ✓

- src/web/ChatComposer.tsx `useLayoutEffect([value])` 用 scrollHeight 重算，经 `clampComposerHeight` 以 180px 封顶，超限 `overflowY:'auto'` 保持可滚动；纯函数与边界（空内容 1 行、到顶、超顶转滚动）有用例。

### ④ prompt 跨会话/窗口持久化 ✓

- localStorage 按会话 id 分键（`graph.conversation.composer.<id>`），每次变更即写、发送成功即清、失败恢复文本；`ConversationPanel` 在 App.tsx:302 以 `key={conversationId}` 挂载，切换会话/重开窗口经 useState 初始化读回；存储缺失/被阻塞时安全退化且不抛错（有用例）。无新增服务端表、无数据库改动。

### ⑤ 切回会话自动滚到底 ✓

- `shouldScrollToLatest` + `enteredScrollRef`：进入会话（组件按会话 id 重挂载）在消息渲染后 rAF 滚到底，每次进入只跳一次，用户上翻后新消息到达不被打断；离开 chat 页签重新武装。

### typecheck 与其余约束 ✓

- check-types 退出码 0；tests/console/composer-interactions.test.ts 仅依赖 vitest 与 composer-state 纯模块，无 playwright/jsdom/端口监听（app.inject 为内存注入）。
- 无新增依赖（package.json/lock 无改动）、无 IPC/Electron 改动；暂停/继续仍走 `/api/conversations/:id/pause|resume` 对话级语义（`changePaused`），任务详情/标题栏暂停入口保留。
- 实现提交（94a3845、75892fd、68ca4fc）只改动了 input.files 列出的文件，两个实现车道文件所有权无重叠。

## 判定依据（供 verify 门复核）

除 ⑥ 外的五项行为与全部硬约束均有实现与测试证据支撑；但 ⑥"暂停并入发送键"的四状态矩阵有两处（F1 实质行为差距、F2 状态层差距）与约定不一致，且测试将偏差固化、使 check-composer 无法暴露，composer-interactions 验收项"四种状态行为与约定一致"未达成。按验收差距判 fail；修复面很小：`composerPrimaryState` 的 busy 分支无条件返回 pause（发送留给 Enter 与 `submitEnter`），paused 分支对 `queueLength>0` 一并走 send-and-resume（或至少呈现发送态），并同步修正两条固化偏差的用例。
