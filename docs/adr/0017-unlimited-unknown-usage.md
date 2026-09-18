# ADR 0017：不限额度 Agent 的未知用量非阻塞

日期：2026-09-18

## 状态

已接受。

## 背景

部分供应商或网关不会为每次模型请求返回权威 usage，例如 Grok 或经兼容层访问的部分订阅模型。原实现把所有 `usage: null` 都升级为 `unknown_usage` 问题并暂停当前实例。对于没有有限预算的会话，这会连续产生同一类问题：用户放行一次后，下一轮请求仍然缺 usage，于是再次中断并要求核对。

未知用量仍不能被折算为零，也不能伪造费用。但“没有有限额度可保护”与“有限额度无法安全核算”是两种不同状态。

## 决策

- 每次调用记录 `usageSource`，取值为 `authoritative`、`account_delta`、`estimated` 或 `unknown`。旧记录没有该字段但含 token 数时按 `authoritative` 解释。
- `authoritative` 是供应商在本次请求中返回的逐请求 usage；`account_delta` 是订阅/账户适配器提供的、可归属于本次发送的账户计量差额；两者可以进入正式预算账本。
- 供应商缺逐请求 usage 时，模型接入层依次尝试 `account_delta`，再在允许估算的路径使用 `estimated`。估算来自本地请求上下文与响应文本，不冒充权威计量。
- 有限预算实例只有在 `authoritative` 或 `account_delta` 下继续；只有 `estimated` 或无来源时仍 fail-closed，创建 `unknown_usage` 问题并暂停发送。
- `instances.unlimited=1` 的 Agent 可以使用 `estimated` 继续运行；UI、节点详情和审计记录必须显示该来源。无法形成任何计数的 `unknown` 是最后回退。
- `instances.unlimited=1` 的 Agent 在账户差额和本地估算都不可得时，invocation 保持 `usage=null`、费用保持 unknown，operation 正常结算并记录 `operation.usage_unknown`。
- 不创建 `unknown_usage` 问题，不暂停节点，也不阻止同一实例的后续模型请求。
- 有限预算实例继续 fail-closed：缺失 usage 仍创建 `unknown_usage` 问题、暂停发送，直到用户补记权威 usage 或明确保留未知并放行。
- 未知用量不计入已确认 token，模型使用和费用投影继续明确显示未知，不把缺失值写成零。

## 后果

不限额度 Agent 不会再因供应商不提供逐请求 usage 而反复弹窗或中断，并能用明确标记的本地估算补足遥测。有限预算路径仍不能在缺少可核算用量时继续执行，因为额度上限无法被安全核算。历史 invocation 中的未知记录保持原样，报告与用量页面按来源显示权威计量、订阅差额、本地估算或未知成本。
