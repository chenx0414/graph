# Review — 批 A 第一组（聊天框基础体验，重新提交）

Reviewer: review Agent (independent gate input)
Requirement version: 1
Verdict: **pass**（附 2 条非阻断发现与 2 条说明，均不影响验收口径的可观察行为）

## 0. 范围与证据基线

本次改动共 10 个文件（`git diff b58ed4f^ --stat`），全部落在两个实现车道声明的
`input.files` 之内，未触碰 package.json（无新依赖）、未改 IPC/Electron、未新增服务端表：

- impl-composer：`src/web/Conversation.tsx` `src/web/ChatComposer.tsx` `src/web/composer-state.ts`
  `src/web/styles.css` `tests/console/composer-interactions.test.ts`
  （`src/web/ComposerTelemetry.tsx` 在清单内但无需改动，展示层沿用既有 `telemetryValue`）
- impl-telemetry-queue：`src/core/conversation.ts` `src/core/task-runtime.ts` `src/server/app.ts`
  `tests/console/composer-telemetry.test.ts` `tests/console/conversation-queue.test.ts`

程序检查冻结证据（均 code 0）：

| check | 证据文件 | sha256（图给定） |
| --- | --- | --- |
| check-types | /Users/macmini/Library/Application Support/Graph/state/checks/check-types.json | a2474bb1…030fdb3 |
| check-telemetry | /Users/macmini/Library/Application Support/Graph/state/checks/check-telemetry.json | 8717e720…937834c |
| check-queue | /Users/macmini/Library/Application Support/Graph/state/checks/check-queue.json | 81a4c4f6…df8a495 |
| check-composer | /Users/macmini/Library/Application Support/Graph/state/checks/check-composer.json | 06d23a21…0865e90 |

独立复跑（本审查工作副本，只读执行）：`node --run typecheck` 退出码 0；
`node node_modules/vitest/vitest.mjs run tests/console/composer-interactions.test.ts
tests/console/composer-telemetry.test.ts tests/console/conversation-queue.test.ts`
→ 3 files / 28 tests 全绿。composer-interactions.test.ts 仅 import vitest 与
`src/web/composer-state.ts`，无 playwright/jsdom、无端口监听（满足上一轮 gaps 要求）。

## 1. 逐项验收核对

### ① 重载后上下文占用与缓存命中立即正确（telemetry-after-reload）✅

- `src/core/conversation.ts:422-445` `conversationMasterUsage`：invocations 经
  `operations → tasks → nodes(role='master')` 关联会话重建，不再依赖
  `nodes.instance_id`（旧逻辑 `master?.instance_id` 为 null 时直接回退 0，见被删除的
  `src/core/task-runtime.ts` 旧 `masterInvocations` 片段）。
- 口径符合约定：`contextTokens` = 最近一次 `purpose='completion'` 的
  `input+cacheRead+cacheWrite`；命中率分母同为 `input+cacheRead+cacheWrite`。
- 生产链路可信：真实记录器 `src/runtime/task-gate.ts:53` 写入的 invocations 携带
  `operation_id`，JOIN 不会落空；`budget-ledger.ts:133` 是既有同款 JOIN。
- 测试覆盖关键风险：`tests/console/composer-telemetry.test.ts` 把 master
  `instance_id` 改写为 'reloaded-instance' 后重开 runtime，断言
  contextTokens=400 / cachedInput=300 / cacheInput=420 / 命中率 300/420 /
  contextLimit=32000；第二个用例保证只计本会话 master 节点，worker/他会话不串数。
- UI 侧 `src/web/ComposerTelemetry.tsx:95,99` 直接渲染 `view.telemetry`，进入会话即取
  重建值（"立即可见且非 0" 由上述持久化重建保证）。

### ② 排队消息逐条取消且不影响在途回合（queue-cancel）✅

- `src/core/conversation.ts:176-190` `cancelQueuedMessage`：仅当消息属于该会话且
  `state='queued'` 才置 `cancelled`，UPDATE 带 `WHERE id=? AND state='queued'`
  竞态护栏；已取消/已送达/未知/他会话均幂等无操作。
- 与在途回合互不影响：`deliverMessages`（conversation.ts:149-157）同样带
  `state='queued'` 守卫，取消与投递不可能互相覆盖状态；
  `pendingMessages`（conversation.ts:142-144）只取 `pending/queued`，被取消消息不再
  进入任何后续回合。
- 新接口沿用既有风格：`src/server/app.ts:357-363` `POST
  /api/conversations/:conversationId/messages/:messageId/cancel` + body `requestId`，
  经 `src/core/task-runtime.ts:1130-1150` `store.command(…, requestId)` 幂等键落库。
- UI 逐条取消按钮：`src/web/Conversation.tsx:1121-1131` 每条排队消息一个
  `data-testid="queued-message-cancel"` 按钮；`cancelQueued` 先本地移除（
  `dismissedQueue` + 纯函数 `cancelQueuedMessage`）、失败回滚并 toast；
  `visibleTranscriptMessages` 让被取消消息不出现在转写流。
- 测试：`tests/console/conversation-queue.test.ts` 覆盖逐条取消（在途回合
  status 恒 'running'）、同 requestId 重放同一 receipt、剩余队列按序投递、
  已取消/已送达再取消无副作用、foreign/unknown/空 messageId、HTTP POST+requestId 契约。

### ③ 输入框高度自适应且有上限（composer-interactions）✅

- `src/web/composer-state.ts:14-30`：`clampComposerHeight` / `composerTextareaHeight`
  封装"像素高度 + 是否进入滚动"，上限 `COMPOSER_MAX_HEIGHT = 180`。
- `src/web/ChatComposer.tsx:165-171` `useLayoutEffect` 实测 `scrollHeight` →
  clamp → 限高后 `overflowY='auto'` 保持可滚动（满足"最大高度并保持可滚动"）。
- 测试含边界：空内容一行、恰好达上限不滚动、超上限才 scrollable、NaN/0 像素、自定义上限。

### ④ prompt 跨会话切换/窗口重开不丢 ✅

- 前端 localStorage、按会话 id 分键（`composerDraftKey`
  = `graph.conversation.composer.<id>`），无新表、无服务端改动（diff 10 文件可证）。
- `src/web/Conversation.tsx:532` 初始 state 从 `readComposerDraft` 恢复，
  `:557` `[id, text]` 变更即写回；App.tsx:302 `key={conversationMatch[1]}` 保证
  会话切换即重挂载，`useState` 懒初始化按新 id 读回各自草稿，窗口重开同理。
- 存储被禁/写满安全退化（try/catch 全覆盖，测试有 blockedStorage 用例）。
- 发送成功清空草稿（`send()` → `setText('')` → 写回空值即删键）。

### ⑤ 切回会话自动滚到底 ✅（见发现 F1 的竞态窗口）

- `src/web/composer-state.ts:71-75` `shouldScrollToLatest`：仅 chat 页签、有消息、
  本次进入未跳过时跳一次；新消息到达不重拽阅读者。
- `src/web/Conversation.tsx:596-610` 接线：进入会话（重挂载）或从其他页签切回
  chat 时 rAF 触发 `transcriptFollow.scrollToLatest('auto')`；离开 chat 页签重置
  允许下次进入再跳。
- 测试覆盖跳一次、不二次跳、非 chat 页签/空转写不跳。

### ⑥ 暂停并入发送键，四种状态 ✅（状态 4 队列分支的措辞差异见发现 F2）

- 纯状态机 `src/web/composer-state.ts:80-115` `composerPrimaryState`：
  输出中→pause；暂停中+有输入→send-and-resume；暂停中+空输入→resume；
  in-flight→pending；空闲→send/steer/suggestion。
- `src/web/Conversation.tsx:727-739` `submitPrimary` 按 action 分派：
  pause/resume 走 `changePaused`（`:640-665`，调用
  `/api/conversations/:id/pause|resume`，对话级语义、不动 worker 节点，符合约束；
  任务详情页暂停入口所在文件未被改动，保留）；
  send-and-resume = `send()` 成功后自动 `changePaused(false)`。
- Enter 保持独立语义（`onSubmit=submitEnter`，ChatComposer:526-529 注释明确"键盘发送与
  上下文按钮分离"），发送按钮 `data-mode` 暴露四态，图标/aria-label 随状态切换。
- 测试覆盖四种状态判定、发送/暂停/继续/发送并继续分支、pending 占位、禁用边界。

## 2. 发现（按严重度）

### F1（中低）自动滚动的"跳过一次"标志先于滚动落地，rAF 被清理时跳底永久丢失

位置：`src/web/Conversation.tsx:596-610`。
证据：effect 内 `enteredScrollRef.current = true` 在 `requestAnimationFrame` 回调执行
之前设置，同时 cleanup `cancelAnimationFrame(frame)`。只要该 effect 的依赖
（`conversationTab`、`snapshot.messages.length`、`transcriptFollow.scrollToLatest`）
在 rAF 触发前再变化一次（典型：切回一个正在产出的会话，16ms 内恰有新消息行进入
projection），cleanup 取消滚动帧，重跑时 `alreadyJumped=true` 令 `jump=false` 且不再
重排——本次进入就不会滚到底。
影响：⑤"切回会话自动滚到底"在繁忙会话下存在低概率漏跳；重挂载（再切走切回）可自愈。
补充核实：`main.tsx:12` 使用 StrictMode，但挂载时 view 尚未加载（`loading && !view`
渲染"加载中…"），首跑 `hasMessages=false`，StrictMode 的双跑不会踩到该标志，
确定性破坏不存在，仅为竞态窗口。
建议（非本轮必改）：把标志移动到 rAF 回调内、或 cleanup 不取消已决定的跳底帧。

### F2（低）状态 4"队列非空"分支的实现与约定措辞不一致，但可观察行为等价

位置：`src/web/composer-state.ts:100-103` 与
`tests/console/composer-interactions.test.ts:113-115`（"paused with a nonempty queue
resumes without sending"）。
证据：约定为"输入框有内容或队列非空时再点=发送该消息并自动继续"；实现把
"队列非空但输入为空"归入 `resume`（继续），仅"有输入"走 `send-and-resume`。
影响分析：该分支输入为空时没有任何可发送内容（`chat()` 对空消息抛
`invalid_input`，task-runtime.ts:997），字面"发送该消息"会因 `send()` 返回 false 而
连 `changePaused(false)` 都不执行（Conversation.tsx:735 的 `if (await send())` 守卫），
反而变成"什么都不做"。实现选择的 resume 会让排队消息按序投递并继续运行，与
"发送并自动继续"的可观察结果一致。判定为措辞差异而非行为缺陷，交由核验门复核口径。

### N1（说明）Enter 在暂停态发送不自动继续

`submitEnter`（Conversation.tsx:719-724）保持既有键盘语义：暂停时 Enter 发出的消息
进入队列等待，不触发继续。⑥ 的四态契约明确指"发送键/暂停按钮"（决策条目"暂停按钮的
四种状态"），且 ChatComposer 注释记录了刻意分离，判为符合约定。

### N2（说明）`composerTextareaHeight`、`queuedUserMessages` 为纯函数层补充 API，组件未直接调用

组件侧高度接线用 `clampComposerHeight`（实测像素更准），排队列表沿用 projection 的
`snapshot.queuedMessages`。四项界面行为与队列取消按钮均已接线到纯函数
（clampComposerHeight / readComposerDraft+writeComposerDraft / shouldScrollToLatest /
composerPrimaryState+composerPrimaryDisabled / cancelQueuedMessage+visibleTranscriptMessages），
满足 impl-composer 的"接线到纯函数"要求。

## 3. 其余核对

- 调度衔接（支撑 ②⑥）：resume 后队列会流动——`chat()` 内 `recoverMaster` 将 master
  置回 pending，`src/server/host.ts:58-75` 的 drive 循环在 execute/autoDrive 模式下每
  40ms `pump()` 扫描 `status='pending'` 的 master（execution.ts:281-295），paused 只挡
  调度不挡在跑回合（execution.ts:275、519-530 佐证对话级语义）。
- 取消幂等键生成 `cancel-${crypto.randomUUID()}`（Conversation.tsx:745）符合
  "POST + requestId 幂等键" 风格；双击安全（服务端 state 守卫 + requestId 重放同 receipt）。
- `MessageState` 增加 'cancelled'（conversation.ts:26）是枚举扩展，既有消费方按值匹配，
  `releaseMessages` 只回滚 `delivered`（conversation.ts:321），不受影响。

## 4. 结论

六个验收点全部实现且有对应绿检查与独立复跑佐证；改动范围未越权、无新依赖、
暂停保持对话级语义。F1 为低概率竞态、F2 为可观察行为等价的措辞差异，均不构成
验收阻断。**verdict: pass**。
