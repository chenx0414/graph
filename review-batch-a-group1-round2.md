# 独立评审：批 A 第一组（聊天框基础体验，重新提交）— 第二轮

- 评审对象：任务 36b65807-5ab9-4d4d-ba7e-d0071d34eff5，HEAD = 336fae3（含修复提交 a5430aa「align the composer primary control with the four-state pause/send matrix」）
- 评审者：review（独立车道），仅基于冻结检查证据与当前工作副本源码
- 结论：**pass**

上一轮评审（reviews/review-batch-a-group1-resubmit@1）判 fail 的唯一原因是 ⑥ 暂停并入发送键的两处状态偏差（busy+hasInput 返回发送、paused+空输入+队列非空返回单纯继续）。本轮逐条复核确认两处偏差已修复、对应测试断言已改为正确期望，①—⑥ 全部验收项与全部约束核验通过。

## 逐项验收核验

### ① telemetry-after-reload（check-telemetry：4 tests 全绿）

- `src/core/conversation.ts:426-448` `conversationMasterUsage`：按会话（`t.conversation_id`）经 operations→tasks 关联 invocations，且用 `EXISTS(... json_extract(n.spec,'$.role')='master')` 限定 master 节点，不依赖 instance_id。重载/实例变更后数值不回退。
- `if (row.purpose === 'completion' && total > 0) contextTokens = total;`（conversation.ts:445）：只有 `input+cacheRead+cacheWrite > 0` 的 completion 才覆盖上下文占用；全零 completion 与 `usage=null` 行（:440 `if (!row.usage) continue;`）均不覆盖已知值。
- `src/core/task-runtime.ts:943-947,963`：`contextTokens`、`cacheHitRate = cacheInput > 0 ? cachedInput / cacheInput : null` 全部取自重建结果，口径为 input+cacheRead+cacheWrite / cacheRead 同分母，符合约定。
- `tests/console/composer-telemetry.test.ts` 覆盖 gap 要求的四条断言（:88-144）：①最后 completion 全零取前一条真实值（451636）；②usage=null 跳过；③跨 master 实例（instance-old/instance-new 混排，另含真实 runtime 重开验证 400/300/420/300/420）；④从未有有效 completion → null。
- 冻结证据 check-telemetry.json（fd61b8e6…）：exit 0，4/4 通过。

### ② queue-cancel（check-queue：3 tests 全绿）

- `src/core/conversation.ts:176-187` `cancelQueuedMessage`：仅当行属于该会话且 `state='queued'` 才置 `cancelled`，UPDATE 带 `AND state='queued'` 二次防竞态；缺行/异会话/非 queued 一律 no-op，幂等（已取消不重复发事件）。绝不触碰 delivered/done 与在途回合。
- `src/core/task-runtime.ts:1130-1151` `cancelMessage`：走既有 `store.command(scope, requestId, …)` 幂等命令日志；空 messageId 抛 `invalid_input`；`message.cancelled` 事件仅在真实变更时发出。
- `src/server/app.ts:357-363`：`POST /api/conversations/:conversationId/messages/:messageId/cancel`，body 带 `requestId`，与既有接口风格一致。
- `tests/console/conversation-queue.test.ts`：逐条取消后剩余队列按序（顺序由 filter 保序、投递逻辑未改）、在途回合不受影响、foreign/unknown/空 id no-op、HTTP 层同 requestId 重放返回一致。UI 侧 `Conversation.tsx:744-761` `cancelQueued` 先本地消失、失败回滚并 toast，逐条按钮 `queued-message-cancel`（Conversation.tsx:1125-1134）。
- 冻结证据 check-queue.json（d38cb5b6…）：exit 0，3/3 通过。

### ③④⑤⑥ composer-interactions（check-composer：22 tests 全绿）

- **③ 高度自适应**：`ChatComposer.tsx:164-171` `useLayoutEffect` 按 `value` 重算 `scrollHeight`，经 `clampComposerHeight` 封顶 `COMPOSER_MAX_HEIGHT=180px`，超出置 `overflowY:auto` 保持可滚动。
- **④ prompt 持久化**：localStorage 按会话 id 分键（`graph.conversation.composer.<id>`），`Conversation.tsx:532` 挂载时读、`:557` 变更时写、发送成功清空；storage 缺失/被禁用安全降级。`App.tsx:303` `key={conversationMatch[1]}` 保证切换会话整树重挂载，草稿不会串会话；窗口重开即重挂载、从 localStorage 恢复。无新增服务端表、无数据库改动。
- **⑤ 切回滚到底**：`Conversation.tsx:596-610` + `shouldScrollToLatest`：进入会话（含窗口重开、切走再切回，因 key 重挂载 ref 重置）在消息渲染后 rAF 一次性 `scrollToLatest('auto')`；同一会话内新消息不抢读者滚动位置。
- **⑥ 暂停并入发送键（四状态矩阵，本轮修复点）**：`src/web/composer-state.ts:96-111` 现为——
  - busy（输出中）：无条件 `{mode:'pause', action:'pause'}`，不看 hasInput/hasQueue（:107-111）；
  - paused + 空输入 + 空队列：`{resume, resume}`（:104-105）；
  - paused + 有输入或队列非空：`{send, 'send-and-resume'}`（:101-103），`submitPrimary`（Conversation.tsx:734-738）有输入先 `send()` 再 `changePaused(false)`，空输入仅放行队列即「发送并自动继续」。
  - `tests/console/composer-interactions.test.ts:110-120`：busy+hasInput→pause、busy+队列非空→pause、busy+两者→pause（含 gap 要求新增的队列断言）；:122-131：resume / send-and-resume / 队列非空 send-and-resume 三条与矩阵一致，上一轮被固化的两条偏差断言已改为正确期望。
  - 发送只由 Enter/提交触发（`onSubmit → submitEnter`，ChatComposer.tsx:528-530），按钮 onClick 统一走 `submitPrimary`；暂停语义为对话级 `POST /api/conversations/:id/pause|resume`（Conversation.tsx:640-646），不碰 worker 节点；标题栏原有暂停入口保留（Conversation.tsx:888），未新增入口。
- 冻结证据 check-composer.json（10f67048…）：exit 0，22/22 通过；测试文件仅依赖 vitest 与纯逻辑模块，无 playwright/jsdom/端口监听（grep 复核无匹配）。

### check-types

- 冻结证据 check-types.json（a2474bb1…）：exit 0。本次独立复跑 `node --run typecheck` 同样 exit 0。

## 独立复跑

在本评审工作副本复跑三个测试文件：29/29 全部通过（telemetry 4 + queue 3 + composer 22），typecheck 退出码 0，与冻结检查证据一致。

## 约束核验

- 无新增依赖：`package.json`、`pnpm-lock.yaml` 相对任务前基线（b17fa12）零改动。
- 无 IPC/Electron 改动；无数据库迁移/新表（MessageState 增加 `'cancelled'` 枚举值，写入既有 messages 表的 state 列）。
- 文件所有权：改动全部落在两条车道 input.files 的并集内（src/core/{conversation,task-runtime}.ts、src/server/app.ts、src/web/{Conversation,ChatComposer,composer-state,styles.css}、tests/console/{composer-telemetry,conversation-queue,composer-interactions}.test.ts；ComposerTelemetry.tsx 列于 files 但无改动需求，未误改其他文件）。
- 批 A 其余项与批 B/C 未越界实现。

## 非阻断观察（不影响判定）

1. `paused=true && busy=true` 的重叠瞬间（暂停生效但当前回合收尾中）按 paused 分支优先返回继续/发送并继续，而矩阵①的「输出中无条件暂停」可解读为 busy 优先。四个固化状态格均不覆盖该重叠，且 pauseAction 进行中按钮为 pending 态掩盖了大部分窗口；实际后果至多是按钮提前一拍从暂停变继续。建议后续把重叠态写进矩阵。
2. `Conversation.tsx:750` 取消请求每次点击生成新 requestId（`cancel-${crypto.randomUUID()}`），HTTP 层重放幂等只覆盖同一次请求的重试；底层取消因 `state='queued'` 守卫天然幂等，连点安全，仅事件面幂等键复用度低。
3. 草稿持久化只覆盖文本不含附件；附件粘贴本就在批 A 后续任务范围，符合本任务边界。
