# 按节读取能力清单实验（2026-10-18）

状态：GRAPH_SCOPED_SYSTEM_CAPABILITIES=1 实验，默认关闭；尚未运行付费模型对照或证明任务成本下降。沿用已有模型、effort 与职责，不补跑已停止的 Step 5 分层样本。

## 已观察的开销

审计上一轮 parser A 的真实 Pi 会话：33 个 toolResult，只有 1 个 isError（bash），没有证据支持“连续工具故障导致超时”。主要行为是调查文档和源码。会话 toolResult.content 的 JSON UTF-8 字节：bash 91,057、read 40,467、read_system_capabilities 14,032、get_agent_combination 1,045、inspect_rsi_status 972、search_resources 100、artifact_list 80。它们是字节测量，不是 tokenizer 数、source×billing 费用分配或人群调用频率。

read_system_capabilities 的完整落盘 JSON 为 28,436 字节，实际返回的一段 text 为 12,558 字节（包含既有落盘提示/预览）；main 随后用两条 shell 调用寻找模型字段，先猜 modelConnections，而正式字段是 configuredModels。不能据此证明宿主工具有 bug，但能定位一项可验证的探索开销。

对该真实完整快照作离线投影，保留 configuredModels 整节为 500 字节，agentCombinations 为 1,240 字节，agentDefinitions 为 105 字节。不是删除字段或缩短行内容；未请求的数据仍可通过另一 section 或省略参数完整读取。新工具声明 JSON 从 472 增至 989 字节，声明新增 517 字节，其固定代价需要纳入每次请求；不能只报较小响应而忽略这个固定代价。另用真实 HTTP→Pi→受控供应商捕获 wire：该工具 JSON 442→959 字节，全部工具 JSON 33,934→34,451 字节，确认为 +517 字节。没有供应商 tokenizer 或真实 usage 对照，仍不把字节转换成 token/金额。

## 实现与 prompt 差异

flag 关闭：保持原工具描述、空参数 schema 和完整返回。

flag 开启：read_system_capabilities 可选 section 为 configuredModels、access、agentCombinations、agentDefinitions、architectures、subscriptionPlans、summary、capabilities、agentContext、application。每次返回 `{sectionName: 完整原值}`；省略参数仍返回完整清单。继续调用原 systemSummary，复用其授权与脱敏；选择器不授予新能力、权限或凭据。未知节明确拒绝，不静默回退到全部输出。

系统 prompt 未改。工具描述仅在 flag 下增加：`section returns that complete inventory field; omit it for the full inventory.` 理由为 keep：定义可选读取范围及完整读取入口，不要求模型少工作或节约 token。schema 枚举给出真实字段身份，避免猜键。评测 runner 将该单项变体标记为 scoped-capabilities。

## 验证与后续门槛

新增真实 HTTP→daemon→Pi→受控外部模型→真实 inventory→bash 写入项目文件 E2E 两行：flag 关闭与开启。一次读取完整清单，再分别读取十节，检查每节与完整原值相同；关闭时仍返回完整清单，实际供应商 wire 不出现 section 参数。最后实际使用清单中的模型 ID 写入 selected-model.txt。没有 mock 自有清单构造器，没有替代授权或持久化。

修复前 /tmp/graph-scoped-inventory-red.log：关闭行通过，开启行因返回了全部键而失败。修复后 /tmp/graph-scoped-inventory-green.log：2/2 通过。完整 /tmp/graph-harness-check-scoped-inventory.log：271 文件、1,504 测试全部通过，真实浏览器与 FFF 依赖执行，验收证据未变化。wire 捕获为 /tmp/graph-scoped-wire-measurement.json，可运行 node /tmp/graph-measure-scoped-wire.mjs 复核（只使用本地受控供应商）。原始字节审计 /tmp/graph-inventory-audit-2026-10-18.json，来源为 parser A 的私有真实会话与 tool-results 文件。

后续必须比较包含库存读取和不读取库存的真实任务，纳入新增静态 schema、额外发现轮次、全部输出和失败成本。按固定任务、顺序、usage/价格来源与完整成功标准分别比较；不能把低频清单的响应缩小比例解释成总任务降本。风险是错误节选择需要额外往返、schema 固定开销抵消收益，以及清单未来新增节的演进。scope 不变时保留全部原值；回滚为关闭 flag。满足更低每完成任务成本且无可测质量下降前，不启用生产。
