# ADR 0017：不限额度主 Agent 的未知用量非阻塞

日期：2026-09-18

## 状态

已接受。

## 背景

部分供应商或网关不会为每次模型请求返回权威 usage，例如 Grok 或经兼容层访问的部分订阅模型。原实现把所有 `usage: null` 都升级为 `unknown_usage` 问题并暂停当前实例。对于没有有限预算的会话，这会连续产生同一类问题：用户放行一次后，下一轮请求仍然缺 usage，于是再次中断并要求核对。

未知用量仍不能被折算为零，也不能伪造费用。但“没有有限额度可保护”与“有限额度无法安全核算”是两种不同状态。

## 决策

- `instances.unlimited=1` 且节点角色为 `master` 的主 Agent 遇到缺失 usage 时，invocation 保持 `usage=null`、费用保持 unknown，operation 正常结算并记录 `operation.usage_unknown`。
- 不创建 `unknown_usage` 问题，不暂停节点，也不阻止同一实例的后续模型请求。
- 子 Agent 与有限预算实例继续 fail-closed：缺失 usage 仍创建 `unknown_usage` 问题、暂停发送，直到用户补记权威 usage 或明确保留未知并放行。
- 未知用量不计入已确认 token，模型使用和费用投影继续明确显示未知，不把缺失值写成零。

## 后果

不限额度主 Agent 会话不会再因供应商不提供 usage 而反复弹窗或中断。子 Agent 与有限预算路径仍不能在缺少权威用量时继续执行，因为图任务契约或额度上限无法被安全核算。历史 invocation 中的未知记录保持原样，报告与用量页面继续显示未知成本。
