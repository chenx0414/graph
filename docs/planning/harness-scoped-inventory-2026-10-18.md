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

## 历史人群补充

[覆盖与副本对账](harness-inventory-population-2026-10-18.md)：长时间窗口 message.tool 事件覆盖 102 个有工具活动的 main 会话，清单工具为 36/102、55 次；不能与 tool_calls 的 17 会话保留窗口混用。126 条 session 记录经权威事件和正文 hash 核对，只能匹配 54/55 次，另 1 次正文未知；44 份完整 JSON 的清单正文中位 26,802 字节，模型节离线投影中位 776 字节。没有 selector 实际采用率或重发/缓存归因，仍不启用、不声称节省。

## command 基础对照（2026-10-18）

随后运行一个冻结 A→B 配对：既有 command 短请求、初始文件和独立检查逐字保持原样，两组沿用同一个 DeepSeek V4.1 Flash 模型配置（实际 models JSON SHA-256 相同），关闭其他上下文 flag；A 关闭按节清单、B 开启，每次最多 180 秒。最多两次，不补跑失败；预先记录若选择器未使用就不扩样。没有新增模型、effort 或 worker 分工。

| 结果 | A 关闭 | B 开启 |
| --- | ---: | ---: |
| command 业务检查/程序未改/main 成功 | 通过 | 通过 |
| API 请求 | 11 | 8 |
| 记录 input / output / cacheRead | 15,226 / 4,221 / 130,944 | 12,841 / 1,962 / 84,224 |
| 缺失或估算 usage | 0 | 0 |
| 未知费用请求 | 11 | 8 |
| main operation 时长 | 63,871 ms | 28,198 ms |
| read_system_capabilities 调用 | 0 | 0 |
| 首次 tools wire 字节 | 33,934 | 34,451 |
| 运行内 staticFingerprint 种数 | 1 | 1 |

两组 checker 逐字节未改，settings 必须精确为 fast/sample 且真实 node check 成功；没有只检查末条回复。A 的轨迹还发布并 promote 了临时项目产物，B 未做这些额外操作；全部请求均计入，没有事后扣掉探索开销。两组实际只有 main，无 graph 节点，scope 为 main-operation，不冒充完整 graph 模型分层对照。汇总各组 completed=1，但严格每完成任务成本都是 null（缺完整冻结价格），不把 phase=chatting 改成正式 graph completed。

由于两组均未读取能力清单，按预先停止规则结束本配对。8 对 11 次请求和较少记录 token 是单次行为差异，不证明按节读取收益，也不证明总体无质量下降；schema 固定增加的 517 字节确实存在。继续关闭 flag，没有据这个有利单点扩样或启用。需要库存的真实任务效果仍待验证。

材料：/tmp/graph-scoped-command-a1.json、/tmp/graph-scoped-command-b1.json（各含独立 state 根目录）、/tmp/graph-scoped-command-observation.json；冻结计划与汇总在 /var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-scoped-command-pilot-ygcldfzp/{plan,comparison,comparison-result}.json。每个私有 state 的 cost-report.json 和 tasks.sqlite 保留全部用量与未知费用。临时配置 0600，未修改生产默认值。

本配对后另发现[配方资源保真缺口](harness-eval-fidelity-2026-10-18.md)：隔离环境并未冻结生产 main 的 14 项资源引用。以上成功、token 与时长只适用于记录的私有环境，不能推断默认生产会话收益；后续先补齐这个前提。

本轮报告提交前完整 /tmp/graph-harness-check-inventory-pilot-report.log：271 文件、1,504 测试全部通过，suite baseline 不变，真实浏览器/FFF 依赖执行，验收证据未变化。这个门禁不消除上述评测保真缺口。
