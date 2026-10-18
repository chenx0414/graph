# 按工具观测结果在实际请求中的重发体积

本轮补齐工具结果进入模型上下文后的体积归属，用于区分“执行了多少次”与“后续请求重发了多少次”。不修改请求、历史、工具加载、模型、effort、角色或实验默认值；没有新增真实模型会话。尚未证明每完成任务成本下降。

## 真实失败轨迹重新核对

已结束 parser A 的原生 session 有 43 个结果、首次记录的文本正文共 183,166 bytes：bash 29 个/106,348 bytes，read 10 个/63,967 bytes，read_system_capabilities 1 个/12,222 bytes，list_projects 1 个/546 bytes，错误配方查询 2 个/83 bytes。最大 bash 正文 25,899 bytes，来自读取 graph-v2.md；第二大 bash 15,228 bytes 的递归 grep 还命中了 `.tooling` 中的旧来源副本。这里统计的是 UTF-8 bytes，不能与 20,000 字符上限直接比较。

同一次运行的实际 transport profile 则累计记录 tool_results 2,676,224 bytes、启发式估算 529,277 tokens。25 次请求中的历史会重发，实际序列化还包含 envelope，不能将这两个不同口径相除当精确重发倍数。以前 profile 只保存整类 tool_results，无法核实每个工具在各请求中占多少。不能仅凭首次正文大小排序声称账单成本来自某个工具。

metadata-only 核对 `/tmp/graph-tool-result-producer-audit.json` 只保存工具名、大小、计数、错误与 session hash，不保留命令、文件路径或正文。原始轨迹未改。错误查询本身体积很小，恢复信息的价值只能来自避免后续困惑，不能声称省掉这两条正文就有显著收益。广泛文档/源码探索与副本命中仍是后续调查机会，不能因此禁止必要 API 核对。

## 新增观测

`profileProviderRequest` 已观察实际序列化请求，现在额外按工具累计每个结果出现的 bytes、SDK estimateTextTokens 估算和 resultViews。

- OpenAI role=tool 通过当前请求前面的 assistant.tool_calls 的 ID 找工具名；Anthropic user.tool_result 通过前面的 assistant.tool_use 找名字，混合用户正文仍计为 user。
- 仅保留当前请求 tools 中已声明的工具名。找不到前置调用、声明已卸载或历史片段不足时归入 tool=null，不猜名字，也不丢弃体积。
- 临时 ID 映射只在函数内使用，不写入 profile；不额外保存正文、参数、路径、call ID 或凭据。请求不重排，staticFingerprint 和原 sections 统计保持原计算语义；复用已有大小估算，不再重复估算同一结果。
- toolResults 在每个请求内按名字聚合，包含空数组。harness-cost 汇总 requestViews（包含该工具结果的请求数）、resultViews（结果块重发次数）、bytes 和 estimatedTokens，并按 bytes 排序。一次工具执行可出现于很多后续请求；这些字段不是执行数、真实 tokenizer 或账单归因。
- profile schema 仍为兼容的 version 1 加字段。报告新增 toolResultProfileSamples / toolResultUnprofiledSamples，区分已观测与旧记录未观测；不能将缺失字段当零结果。

严格 cost/usage、模型身份、任务成功、缓存指标和原始计费分类不变。逐工具体积未分配到 input/cacheRead/cacheWrite，不能按这些估算比例分摊供应商账单。来源 × billing 的精确成本仍有原来的证据缺口。

## 真正 E2E

扩展原 HTTP conversation → Pi → 本地受控外部模型 → 实际 bash 写文件 → 实际 read 读文件 → 完成主会话 → 公开统计读取 → 关闭后 cost CLI owner，未新增或改写低层测试。

一次 bash 写入 proof.txt，下一次模型读取它，再结束。实际 bash 执行仍只有一次，但其结果在后两次 transport 请求中分别出现；报告为 requestViews=2/resultViews=2。read 结果只出现一次。按工具 bytes 加总等于原 tool_results section bytes；新 profile 字段不含秘密 fixture、用户 marker、命令、文件路径或工具调用 ID。既有 cache/provenance/失败重试/工具匹配/用户规则断言均保留，模型费用期望随真实新增的 read 轮次调整，没有把它从账本排除。

红灯 `/tmp/graph-tool-wire-attribution-red.log`：真实工具和既有成本检查通过，但报告没有逐工具结果字段。实现后 `/tmp/graph-tool-wire-attribution-green.log`：1 文件、9 测试通过/1 项真实 FFF 依赖行未配置而跳过；全量校验使用 FFF/browser 的实际依赖路径，不以这一局部跳过作为完整证据。Anthropic 分支延续原有混合块处理，本轮受控模型只证明 OpenAI transport，不能据此声称全部供应商格式均已 E2E 覆盖。

## 历史与回滚

用新只读 CLI 读取原 parser A 数据库：samples=25、toolResultProfileSamples=0、toolResultUnprofiledSamples=25、toolResults=[]。这明确表示逐工具历史归属不可得，不是工具没有执行。记录在 `/tmp/graph-historical-profile-coverage.json`；不按 session 推算然后回填历史 profile。

回滚撤销 request-profile 的附加元数据与 CLI 新字段即可；无需迁移、删除或重写旧账本。已有 profile 可被旧 reader 忽略。真实 A/B、生产质量与价格加权任务收益仍待验证，未使用本轮观测作为启用任何行为实验或重跑已停止小集的授权。

最终全量 `/tmp/graph-tool-wire-attribution-check.log`：272 文件、1,514 测试通过，355.01 秒，baseline 匹配、验收证据不变；FFF 的真实依赖行随完整门禁通过，无跳过。
