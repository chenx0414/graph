# OpenCode Go 用量恢复能力核验（2026-10-19）

本报告的接口研究只读取官方公开文档和公开源码；付费推理调用0，未读取用户凭据、登录Console或查询账号数据。研究过程未运行测试；相关本地解析修复及测试见[用量完整性记录](harness-usage-drain-2026-10-19.md)。结论是**仍未验证可自动按请求补账的接口**，不能把“未验证”写成“供应商不存在该能力”。

## 已验证的接口边界

Go官方文档区分订阅配额与推理端点，公开列出模型使用的API族、模型目录。新版Inference API说明以JSON POST调用Chat Completions、Responses、Messages或Gemini；这两份文档没有给出按request/response ID查询历史四类token的契约。这里只能证明这些页面的公开范围，不能证明其他接口不存在。[Go](https://dev.opencode.ai/v2/docs/console/go/)、[Inference API](https://dev.opencode.ai/v2/docs/console/api/inference/)

官方Console API Overview列出Inference、Providers、Budgets和配置读取，说明服务账号键和用户token的权限区别；本次读取的页面同样未提供逐请求usage查询字段、重试/延迟一致性或历史回填契约。不能据此猜测一个路径并在正式成本账本中依赖它。[Console API Overview](https://dev.opencode.ai/v2/docs/console/api/)

公开源码固定到`anomalyco/opencode`提交`f394d9d410bc6bb7cafcebfc5e3180a9b80ebed9`（通过`git ls-remote`及浅克隆HEAD核对）。旧`GET /zen/go/v1/usage`路由仅调用`proxyInference`，后者映射到新服务`/go/v1/usage`；该源码不展示新服务响应schema或逐请求恢复实现。源码还会转发客户端的`x-opencode-request-id`（兼容旧`x-opencode-request`），但**转发不证明日志持久化、幂等性、可查询性或唯一性**。源码版本也不等同于此用户账号正在命中的部署版本。[固定usage路由](https://github.com/anomalyco/opencode/blob/f394d9d410bc6bb7cafcebfc5e3180a9b80ebed9/packages/console/app/src/routes/zen/go/v1/usage.ts)、[固定代理实现](https://github.com/anomalyco/opencode/blob/f394d9d410bc6bb7cafcebfc5e3180a9b80ebed9/packages/console/app/src/lib/inference-proxy.ts#L1-L54)

Graph当前`src/server/usage.ts`的`fetchOpenCode`读取usage后调用`openCodeWindows`，结果用于配额窗口；这条已实现路径没有按本地callId恢复input/output/cacheRead/cacheWrite的证据。不能把配额百分比差额分摊给某请求；并发、舍入和窗口含义都不能被“同一时间附近”替代。[Graph现有路径](/Users/macmini/workspace/13-Graph/src/server/usage.ts:425)

## Console日志与CSV：不能从“存在”跳到“可补账”

官方Console首页说明request logs保存token、费用、模型和时序元数据；Members文档说明成员详情有request logs且可以导出usage CSV。这证明供应商侧存在用量记录展示线索，值得进一步核验，**不证明CSV包含逐请求ID或完整四类token**。这些页面未给出CSV列名、token语义、日志保留时长、失败/取消请求是否纳入、最后一笔生成是否已结算等契约。[Console说明](https://dev.opencode.ai/console/)、[Members](https://dev.opencode.ai/v2/docs/console/members/)

Budgets文档更明确：工作区Usage页面的Export usage下载最近7/30/90天的**daily totals**，并按日、模型和人展示费用。这种聚合导出不能作为一个未知callId的完整token证据。Members页面所指的导出是否同一格式、是否另有明细导出，仍未验证；不能把聚合CSV宣称为请求级恢复来源。[Budgets：Track spend](https://dev.opencode.ai/v2/docs/console/budgets/#track-spend)

| 恢复所需字段/性质 | 当前官方公开证据 |
| --- | --- |
| 可与Graph调用一对一连接的请求ID | 代理会转发客户端请求ID；日志/CSV查询支持未验证 |
| 精确请求时间、模型 | 官方只概述日志有时序和模型；具体字段、粒度未验证 |
| input/output/cacheRead/cacheWrite四类完整token | 只概述token元数据；四类字段及定义未验证 |
| 明细费用与币种/计价版本 | 只概述cost；字段、语义及订阅配额费用关系未验证 |
| 取消/断流后继续生成的最终用量 | 未验证 |
| 正式、可按键调用的历史查询API | 本次公开页面和代理源码未建立该契约 |

因此不能根据相邻时间、同一模型、相同token数或一段配额变化自动归账。即使未来拿到Console明细，也要先验证唯一身份匹配和最终结算语义；原始历史unknown在此之前保持unknown。

## 流式用量的协议限制

OpenAI官方生成的Chat Completions流选项说明：`stream_options.include_usage=true`时，在`[DONE]`前另发全请求usage块；该块choices为空，其他块usage可为空。官方同时明确中断时可能收不到最终usage。这里说明的是OpenAI协议契约，**不能替代OpenCode每个上游模型实际遵守它的证明**。[官方SDK协议定义](https://github.com/openai/openai-python/blob/main/src/openai/types/chat/chat_completion_stream_options_param.py#L21-L30)

因此，Graph的30秒有界收尾可以挽救“本地取消过早关闭连接”导致的迟到usage，却无法使已断开的流重新出现最终统计。正常连接收到完整usage、取消后迟到usage、供应商/代理断流前没有usage，必须分别验证，后两者不能用SDK补零或本地估算升级成权威账单。

## 后续可以做的验证

1. 继续本地真实HTTP/CLI/持久层故障验证，确认收到不完整统计时仍为unknown，并保留失败原因；这一步不需要真实模型调用。
2. 若要建立供应商侧恢复，先拿到官方请求级查询/导出契约或用户自愿提供的脱敏样本，明确上述字段。无需在聊天中提供任何凭据。没有明确字段前不实现猜测回填。
3. 后续获批的真实采集验证应单独冻结范围，验证每个实际模型的usage字段、缓存含义、请求身份及取消结算；采集验证成功后再讨论成本A/B。读取模型目录或本地E2E通过不等同于真实供应商采集可用。

本报告没有证明未知用量能永远消失，也没有恢复历史未知记录、建立真实成本基线或证明整树任务降本。
