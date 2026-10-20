# OpenCode Go 响应头前失败：权威对账入口核验

日期：2026-10-20。本次只读官方公开文档和公开源码，未读取凭据、登录账号、发送推理请求或联系供应商；没有运行或新增测试。本文扩展[此前接口核验](harness-provider-usage-recovery-2026-10-19.md)，不宣称历史未知已恢复。

## 结论与下一步

**可实施的下一步是核验本人 Console 请求详情的实际读取接口及字段，再实现严格匹配的恢复导入；目前不能以公开资料声称自动补账已可用。** 官方明确提供 Members → 本人详情 → request logs；这个真实只读入口比猜测 API 路径更可靠。普通未登录 GET Console 在本次研究环境返回 HTTP 403，网页提取工具只有空页面，因此本次未取得登录后的请求详情、前端网络读取路径或 CSV 样本。[官方 Members 文档](https://dev.opencode.ai/v2/docs/console/members/#member-details)、[Console](https://opencode.ai/console/)

需要继续完成的最小核验是：在已登录的对应 Personal 工作区进入本人详情，仅查看请求日志及其读取响应；保留经过凭据与正文脱敏的原始响应或明细导出，记录接口、字段、查询范围、分页和截止时间。无需购买新额度、修改账户设置、创建新键或发送模型请求。研究未建立可直接用现有 inference key 调用的请求日志 API 契约；不能假定推理权限包含账单明细权限。[Console API 权限说明](https://dev.opencode.ai/v2/docs/console/api/#permissions)

## 这次失败需要恢复什么

[本轮终态记录](/Users/macmini/.codex/attachments/81739269-9f1f-4891-b9b7-4dd7f46a3ff7/harness-recovery-2026-10-19/worker-comparison-v3/result.md)表明：39 次 native fetch 尝试中前 38 次收到 HTTP 200 和权威用量，第 39 次 DeepSeek 在约 60,447ms 后 `fetch failed`，没有响应头、usage 或服务端请求 ID。发送守卫未添加客户端请求 ID，只保留正文 SHA；第 40 条账本记录来自本地守卫拒绝，没有第 40 次上游发送。两条未知需要保留不同事实，不能把本地拒绝当作额外供应商请求，也不能把第 39 次推定为零费用。

本地时间、模型、正文 SHA 可用于筛选服务端候选，但 SHA 只有在服务端也提供相同字节语义的摘要时才是关联证据。邻近时间、相同 token、排除其他 38 条后剩下一条，都不能独立证明身份及账本已经完整结算。恢复这笔历史调用需要服务端可验证的一对一身份，或明确证明完整性、唯一性的账本证据；现在没有这些证据。

## 公开源码验证了哪一层

本次浅克隆官方 `anomalyco/opencode`，`git ls-remote HEAD` 与本地 HEAD 一致，固定为 `6e9c85390bc232866f83ca19dfb46bd9d39b7aa1`。这只固定公开源码证据，不证明账号实际部署版本相同。

- 兼容代理把 `POST /zen/go/v1/chat/completions` 映射到新服务 `/go/openai/v1/chat/completions`；`GET /zen/go/v1/usage` 映射到 `/go/v1/usage`。注释明确认证、模型可用性、免费层访问和计费由新 inference 拥有。[固定代理 L3–18](https://github.com/anomalyco/opencode/blob/6e9c85390bc232866f83ca19dfb46bd9d39b7aa1/packages/console/app/src/lib/inference-proxy.ts#L3-L18)
- 代理读取 `x-opencode-request-id`，兼容旧名 `x-opencode-request`，并把值转发给 inference。这里没有展示持久化、查询索引、唯一性校验、重复 ID 拒绝、响应回显或幂等去重；因此可以把该头用作未来关联线索，不能把它当成已成立的幂等键。[固定代理 L39–51](https://github.com/anomalyco/opencode/blob/6e9c85390bc232866f83ca19dfb46bd9d39b7aa1/packages/console/app/src/lib/inference-proxy.ts#L39-L51)
- 代理的下游 fetch 异常会转成 HTTP 503；兼容层还把 inference 的 404 转成 400。这证明部分 HTTP 状态经过代理转换，不能仅凭客户端状态推断上游是否生成或计费。本例连响应头都没有，无法定位到此分支。[固定代理 L50–60](https://github.com/anomalyco/opencode/blob/6e9c85390bc232866f83ca19dfb46bd9d39b7aa1/packages/console/app/src/lib/inference-proxy.ts#L50-L60)
- `infra/console.ts` 明确标注旧 Zen 请求/响应转储 writer 已在 2026-05 移除，留下的两个存储桶没有读写者。不能把旧 Zen 转储实现当成当前账号的恢复接口。[固定基础设施 L18–20](https://github.com/anomalyco/opencode/blob/6e9c85390bc232866f83ca19dfb46bd9d39b7aa1/infra/console.ts#L18-L20)
- 公开 `/openapi.json` 路由读取的是 `packages/protocol/openapi.json`。其中会话日志与本地会话 usage 聚合属于 Agent 服务器 API；不能把这个 OpenAPI 文件误认成新 Console 的计费检索契约。[固定路由](https://github.com/anomalyco/opencode/blob/6e9c85390bc232866f83ca19dfb46bd9d39b7aa1/packages/console/app/src/routes/openapi.json.ts)、[固定本地协议](https://github.com/anomalyco/opencode/blob/6e9c85390bc232866f83ca19dfb46bd9d39b7aa1/packages/protocol/openapi.json)

## 当前文档能证明的边界

官方 API Overview 列出 inference、providers、budgets、config；Inference 页定义生成端点和认证。所检查页面未给出按客户端请求 ID 查询历史用量、恢复失败请求或重放幂等性契约。这里只说明这些公开页面的范围，**不证明供应商不存在私有或另行提供的日志读取接口**。[API Overview](https://dev.opencode.ai/v2/docs/console/api/)、[Inference API](https://dev.opencode.ai/v2/docs/console/api/inference/)

Budgets API 的读取返回本月累计 `spent_micro_cents`，不是四类 token 明细；其 PUT 幂等性只适用于设置预算。Budgets 页面另明确计划内 Go 用量不计入预算，而额外 credits 用量计入；所以该花费差额甚至不覆盖所有 Go 生成，不能拿它对第 39 次补账。Usage CSV 在该页面被定义为按日总计；Members 页的 CSV 是否另有请求明细，仍需实际核验。[Budgets API](https://dev.opencode.ai/v2/docs/console/api/budgets/)、[预算计入规则与导出](https://dev.opencode.ai/v2/docs/console/budgets/#what-counts)

Go 文档要求客户端标识自身 user agent，并为每个会话发送稳定 `x-opencode-session` 以优化路由/缓存。session 是多次请求共享的会话身份，不是逐次发送 ID。Go 限额是按模型价格折算的窗口金额，且不同模型额度不同；即便精确知道一个价格加权金额，也只是四类 token 的一个标量方程，无法唯一反解 input/output/cacheRead/cacheWrite。配额变化与请求归因是不同证据，不能互换。[Go 客户端要求与限额](https://dev.opencode.ai/v2/docs/console/go/#where-can-i-use-it)

## Console 明细必须验证的契约

下面是恢复器的验收要求，**不是已确认供应商字段名**。

| 要求 | 可接受证据 | 不足以替代 |
| --- | --- | --- |
| 请求身份 | 服务端记录同时包含客户端发送 ID、服务端唯一 ID、账号/工作区/键身份、模型；能与本地某一次发送严格连接 | 会话 ID、邻近时间、单纯正文 SHA |
| 用量完整 | 明确四类 token 的数值和语义；区分零、缺失、不适用、未结算 | 缺失字段补零、只给总 token |
| 费用归属 | 货币、精度、计价时点、计划内折算/credits 扣费关系及最终状态 | 当前价格重算冒充历史实际收费 |
| 失败与取消 | 服务端说明接受/拒绝、是否继续生成、最终结算时点及是否有上游多次尝试 | HTTP 失败一概视为无用量 |
| 查询闭合 | 授权范围、筛选键、所有分页、保留期、延迟结算和明确截止时间 | 查询暂时空结果就宣称未接收 |
| 去重与冲突 | 一个发送只能被结算一次，重复导入无额外累计，冲突保留原值并拒绝自动覆盖 | 相同客户端 ID 自动认为去重生成 |

对未来请求，发送前持久化随机唯一 ID、callId、attemptId、模型、时间、正文摘要，再通过已验证的头发送；每次真实发送独立标识，任何重试保留所属逻辑调用关系。收到响应后追加服务端 ID/原始 usage/证据摘要；响应头前失败保留为待对账。这样可补齐目前的关联信息缺口，但不能单独保证供应商一定保存、暴露或结算这些字段。

恢复应追加可审计的结算证据，保留原始未知事件；只有身份唯一、统计完整、状态最终且语义核验通过时，才允许把恢复结果用于正式整树成本汇总。服务端明确证明未接收且不计量时可以记录该种终态；“日志没查到”本身不够。即使全流程改成非流式、延长等待或自动重试，响应头前网络失败仍可能发生，不能因此宣称未知已消失。

本次没有找到足以自动恢复第 39 次调用的权威数据，没有改写账本，也没有启动成本 A/B。接下来必须取得真实只读请求详情契约并通过真实 HTTP/CLI/持久层 E2E 验证完整恢复流程；在此之前，用“未知即停”保护数据诚实，不能当作权威恢复已完成。
