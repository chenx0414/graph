# ADR 0019：可恢复的实时会话流

日期：2026-09-18

## 状态

已接受。

## 背景

主 Agent 的回复已经通过 `message.delta` 实时进入浏览器，但旧实现只把 delta 保存在客户端内存中：服务端没有当前 live text 快照，前端也无法校验缺失前缀；流式行和最终消息还使用不同身份，Markdown tail 每次变化都重新挂载、重新解析，并把淡入动画重新施加到已经显示的文字。跟底滚动也只是内容增长后直接设置到最底部。

这会让长回答、工具穿插和完成态 handoff 出现闪烁、重排、突然跳动或断线后无法恢复。

## 决策

- SQLite 增加 `conversation_streams` 投影，保存当前 active operation 的 `entryId`、`partId`、完整文本、长度和更新时间。它用于断线恢复和完整视图对账，不是正式消息历史。
- `message.delta` 增加稳定 `entryId`、`partId`、`len` 和 `reset`。普通追加只发送新 suffix；当前后缀无法安全接续时发送完整文本并标记 `reset=true`。
- 客户端只接受长度匹配的 append。无法接续时标记 `streamNeedsResync`，重新读取完整会话视图，由 live snapshot 修复。
- operation 结算、未发送、不确定、失败或写入 durable message 时删除对应 live stream。
- 流式态与完成态使用同一个 operation 派生的 assistant row ID。assistant 内容按顶层 Markdown block 渲染，稳定 block 通过 memo 复用；通常只重解析最后两个 block。
- 供应商可能把一次输出作为大块 delta 到达。客户端保留权威完整文本，同时按稳定节奏揭示新到内容；即使 durable final message 先到，也先播完视觉队列再切换最终回答。
- 淡入只作用于本次新增文本区间，修改 `opacity`，不使用位移、缩放或布局动画。历史会话 attach 时不重新淡入已有文本。
- 跟底使用带 growth 前馈的 spring。只有用户滚轮或触摸输入解除 pinned，回到底部附近后才恢复；流式期间使用受控 runway 吸收早期内容增长。
- 这些约束适用于 Web 会话界面；不要求照搬 Zeron 的 Rust/gpui 数据结构或参数。

## 后果

流式文本可以在断线、快照刷新和 live→durable handoff 后保持连续，稳定 Markdown block 不再随每个 delta 重新挂载。跟底滚动不把布局增长误判成用户意图，用户主动向上阅读时不会被新内容反复拉回底部。

代价是新增一张会随流式 delta 更新的 SQLite 表，并要求前端处理 append 长度校验和 resync；前端还需维护短期视觉揭示队列，使粗粒度供应商 chunk 也保持连续感。`conversation_streams` 只容纳 active 流，不应被当作消息记录、审计日志或长期缓存。
