# 传输层失败时的模型回退（`fallbackModelId`）

一个模型条目可以用 `fallbackModelId` 指定**主选不通时接管这次发送的另一个模型**。这是可用性决定，不是第二次评价：只有主选因为**传输层/协议层边界**失败、一个字都没答出来时才回退——连接错误或 EOF、超时、非 2xx、流没走完就断。模型答了但内容不合格、工具调用被写坏、审查不通过，都不触发回退：那是这一轮的回答，换一个模型重问等于把「这段审查是谁做的」悄悄改掉。

- 当前用途：审查节点用 `chatgpt:gpt-6.1-sol`（`openai-responses`，`https://chatgpt.com/backend-api/codex`），它的 `fallbackModelId` 是 `grok:grok-4.5`（`openai-completions`，`https://api.x.ai/v1`）。Codex 后端会偶发直接断开（`Post "…/responses": EOF`），这类失败下这一轮 review 由 Grok 接着做完，而不是把图停在「审查节点失败」。主选能答时仍然由 ChatGPT 答。
- 回退发生在**同一次发送内**：这一轮不需要重开，节点执行也不再加一次；回退的发送有自己的 gate、凭据与并发槽，所以 `provider_calls` 里那次调用记的是**真正回答的模型**（失败的尝试单独一行，用量为 0，因为一个字节都没答出来）。
- 每次回退都在图上记一条 `graph.provider.fallback` 事件，四个字段缺一不可：`primaryModel`（主选模型 id）、`error`（失败原文，一字不改，例如 `Post "https://chatgpt.com/backend-api/codex/responses": EOF`）、`fallbackModel`（接管这次发送的模型 id）、`sameModel`（两个 id 是否同一模型；真的换了模型就是 `false`——同模型「回退」不构成任何独立性证明）。
- 一次失败都没发生时什么也不记：回退不是后台常态，它只在主选确实不通时出现。
- 回退也只有一跳，回退模型不能再有自己的 `fallbackModelId`（保存时拒绝），所以同一轮不会在未知数量的厂商之间游走，也没有新的重试次数常量。
- **两个都失败时**这一轮明确失败：错误消息里同时带两段原文（主选为什么不通、回退为什么不通），节点按普通失败处理（blocked / 重试），绝不把失败当成「回答完了」。人工可读的后果是：图上 `graph.provider.fallback` 事件告诉你换过谁，失败消息告诉你两边各自断在哪。
- 已知边界：失败那次尝试若被结算成 `unknown`（例如已经读到部分回答后才断），有预算上限的节点会先要求 reconcile 未知用量才继续下一次发送；这是既有规则，回退不绕过它。

