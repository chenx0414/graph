# Graph harness token 成本优化：2026-10-16

当前审计结果：最新通过的完整门禁为 `VITEST_MAX_WORKERS=4 node --run check`，**269 文件、1,498 测试全部通过**，验收证据未变化（`/tmp/graph-harness-check-unseen-verification.log`，本轮同时提供真实浏览器和 FFF 依赖）。docs 精简与目录工具按需加载均默认关闭；早期真实小样本分别约贵 28.9% 和 3.35%，未证明降本。模型隔离评测已获批准；正式原生 worker 固定小集 DeepSeek 3/3、LongCat 1/3 完整成功，候选未通过质量门槛，停止扩大。旧 main 评测混入角色和验收代码暴露，已在[评测报告](harness-model-feasibility-2026-10-16.md)更正。生产模型、路由和 effort 默认值未改。main 取消收尾仍有高负载窗口，本轮另补 worker 静止检查，完整门禁 `/tmp/graph-harness-check-active-drain.log`：268 文件、1,489 测试通过，证据不变。

报告中的阶段日志保留早先失败，以上为最新验证状态。目标业务指标尚未被证明，未标记 goal 完成。


目标是降低完整任务的价格加权成本，质量不下降。当前交付先补观测，提供默认关闭的提示词实验；没有足够证据声称整体成本下降或质量等效。

## Harness 地图

| 层 | 权威实现与现状 |
| --- | --- |
| 装配 | `src/runtime/agent-context-assembly.ts` 打开能力包与规则；`agent-system-prompt.ts` 合成 identity/rules/docs；Pi 添加项目规则、skills、工作目录。实际请求不同于模板。 |
| 工具 | `agent-tool-definitions.ts`、`capability-bundle.ts`、`pi-native-tools.ts`；能力来自配方、MCP、extensions；选择后的名称现在确定排序。Pi 0.86.1 支持 transcript 工具变更，不在 transport 重排旧消息。 |
| 主会话 | `pi-adapter.ts` → `pi-instance.ts` → `controlled-openai.ts` → Pi provider；建议提示词与 skill sediment 也产生计费调用。 |
| 节点 | `kernel-graph-lane.ts` 的 onModelCall 在宿主发送，resident-worker 保存自己的历史；`kernel-provider-gate.ts` 冻结模型、价格、purpose 与 execution。 |
| 计量 | `task-gate.ts` 保存 invocations；节点保存 kernel_provider_calls；input/output/cacheRead/cacheWrite 是互斥计数，未知不记零。工具使用 tool_calls，并从 worker spool 经公开统计读取入库。 |
| 历史与压缩 | Pi session JSONL 保留 transcript；`compaction.ts` 已采用约 1500 token handoff、保留状态路径和后续工作；压缩独立计费。 |
| 输出 | `tool-results.ts` 已做落盘、head/tail 和路径读取；大结果前两次通常完整，第三次摘要。bash/system/conversation 有首次上限。`host-command.ts` 已在执行 scratchDir 保全完整 stdout/stderr，并提供路径、字节数、digest；内联窗口仍有限，不等于磁盘数据被截断。 |
| 检索 | `retrieval.ts`、扩展 ffind/ffgrep；没有本次可用的语义检索质量对照。 |
| 协作 | main 通过正式 graph 声明节点，节点 fresh/continue 会话和独立 worktree；按 ADR 0030 不恢复旧 fork 图模型。未改变模型、effort 或任务拆分。 |

## 实际基线及缺口

只读一致性快照：桌面 `~/Library/Application Support/Graph/state/tasks.sqlite`。CLI 默认库没有任务，不能用来代表真实使用。原始报告位于本次机器 `/tmp/graph-harness-baseline.json`（包含任务 ID，应按本地诊断数据处理）。生成命令：

```sh
node scripts/harness-cost.mjs '/Users/macmini/Library/Application Support/Graph/state/tasks.sqlite' > /tmp/graph-harness-baseline.json
```

快照有 124 个 task，123 个有非零或未知调用，过滤已知零用量的工具 admission 后约 19,583 次调用；历史共 85,451 条 invocation、1,333 条节点调用。未知调用不能与工具调用完全区分，因此请求数也是观测口径而非绝对 ground truth。

| billing type | 已记录 tokens |
| --- | ---: |
| 未缓存输入 | 131,021,953 |
| 输出（含供应商计入的 reasoning） | 14,808,254 |
| 缓存读取 | 4,432,466,767 |
| 缓存写入 | 0（不能推断供应商实际没有写缓存） |

16,475 次调用费用未知。两个 completed graph 分别 966/116 次请求、23/18 个 execution；已知费用合计 USD 1.311815736，至少 158 次费用未知、61 次 usage 未知，故每完成任务成本为 null。主会话长期处于 chatting，不等同于失败或未完成的单项用户需求；main planning 尚不能完整分摊到子 graph。报告保留 task 分开，不能冒称 whole-tree 成本。

1,324 份实际节点 prompt：system 平均约 10,600 字符、tools 11,645；579 份 main operation 已发送快照：system 16,260、tools 47,326 字符。后者每 operation 只保留快照，不等于逐请求平均 token。main 工具正文约占这两个静态区域字符的 74%，是优先调查对象。

工具样本有 17 个 task，不能用全部 124 个 task 作覆盖率分母：bash 覆盖 82.35%/错误 1.88%，read 76.47%/1.95%，edit 23.53%/9.05%，artifact_publish 23.53%/9.09%，agent_browser 11.76%/0%。所有工具逐项结果由 CLI 返回。不同数据保留期会造成偏差。

来源 × billing 的**精确成本表目前不可得**。供应商只回整个请求缓存/输入用量，旧记录没有 per-section tokenizer 或缓存边界。新 profile 记录真实 wire JSON 的 system/tools/user/tool_results/assistant_history 字节及 SDK 启发式 token 估算，不把估算比例乘账单冒充归因。file/search/command、skills/rules 与 summaries 在 wire 中缺独立来源；未来需生产者 provenance 和 tokenizer，再按 prefix/cache 边界分配。新 profile 带 callId，可直接与两个正式账本关联。

## 已做修改和回滚

1. `provider.request_profile` 事件：逐实际 admitted transport attempt 记录 callId、请求字节、各 section 估算与 static SHA-256、显式 cache_control 数量。没有正文、参数或 auth。异常吞掉，不影响发送。覆盖 main、宿主节点、建议与 sediment 调用；失败/重试使用独立 callId。存储采用已有事件流，无第二账本。
2. `scripts/harness-cost.mjs`：显式 DB 参数、readOnly + snapshot；按任务汇总计费种类、purpose、operation/execution、未知数、币种、工具覆盖与错误、新 profile。零 token admission 排除；未知保留。cacheReadFraction 是缓存 token 比例，不叫请求命中率。
3. 工具选择确定排序：保持能力/禁用/替换语义，以名称排序拷贝；不修改会话旧消息或 reasoning items。收益仅为消除发现顺序引发的缓存风险，尚无 A/B 节省数字。
4. `GRAPH_COMPACT_DOCUMENTATION=1`：仅精简 Graph 生成的 docs 块，默认关闭；不改用户规则、配方身份、测试规则、模型和 effort。移除环境变量并重启恢复旧装配；已发送历史保持原样。用户自行维护的 prompt 不覆盖。

每项是独立文件范围，可单独 revert；已在完整门禁通过后分拆提交；工作区其他人的修改未混入。提交身份见最终验证章节。

## 系统 prompt 逐行审计与 diff

identity、common/role/runtime/tool/host rules：全部 keep，本次不改。原因：缺少模型行为对照；尤其测试规则和权限是产品契约。SDK 原生块也 keep，避免改上游隐含契约。

仅 docs 生成块实验，每个原始行处置如下：

| 原行 | 分类和新去向 |
| --- | --- |
| Graph documentation + 使用触发 | rewrite → 新第 1 行，保留 runtime/tools/recovery/config/harness 触发 |
| Main documentation | keep → 新第 1 行绝对入口 |
| Running Graph API + graph-v2 + examples | rewrite → 新第 2 行，保留 schemaVersion:2 与操作前阅读要求 |
| Additional docs | keep → 新第 3 行 |
| Examples | keep → 新第 3 行 |
| absolute paths / business checkout / old memory | rewrite → 新第 4 行，保留 host 与任务目标区别 |
| topic/example resolution | rewrite → 新第 4 行 |
| 逐主题长文件列表 | move → 已存在的 docs/agent/README.md topic index，按需读；不删除文档 |
| complete topic + references + historical docs | rewrite → 新第 3 行，保留完整相关主题与按需引用；delete 历史报告阅读劝告措辞 |

```diff
- Graph documentation (read when the user asks about Graph itself, its Agent runtime, tools, task execution, recovery, permissions or configuration, and whenever you change Graph's own code, prompts or harness):
- [8 lines: main path, API and examples, additional path, examples path, host-version distinction, relative resolution, topic inventory, reading protocol]
+ Graph host documentation: <main>. Read relevant topics for Graph runtime, tools, recovery, configuration, or harness changes.
+ Before graph build/validate/start/patch: <graph-v2>; native examples: <design examples>. Host API: schemaVersion:2, interface deliveries.
+ Topic index: <main>; additional docs: <root>; examples: <examples>. Read the complete relevant topic and follow references needed for the operation.
+ These paths describe the running host. Resolve topic references there, and examples under the examples path. Business-checkout docs and old conversation memory may describe a different API.
```

本 checkout 的 SDK estimateTextTokens：465 → 215，减少约 250/54% **仅 docs 块**；不是完整静态请求的 54%，更不是任务费用下降。缓存命中时价值还要按 cacheRead 单价计算；增加一轮阅读可能抵消节省。

## 机会排序（share × removable / risk）

费用缺失使排序只能使用体积与错误观测作为 proxy，不能给伪精确 ROI。

| 优先 | 层/候选 | 估算方法及风险 | 验证/回滚 |
| --- | --- | --- | --- |
| 1 | 补价格与逐请求 profile、main-child 任务归属 | 无直接节省；使真实目标可测。低行为风险，存储写放大需监控 | 真实 HTTP/tool/CLI E2E；回滚 telemetry callbacks 与脚本 |
| 2 | main 工具按需发现 | main 静态字符约 74% 为工具；若可移除半数则此两块字符上界减少 37%，非任务费用预测。中高风险，首轮缺工具与多轮发现 | 已实现默认关闭 GRAPH_DEFER_CATALOG_TOOLS；核心工具常驻。单样本总价未下降，保持关闭；恢复全量 schemas |
| 3 | recurring tool errors | edit/artifact_publish ~9% 错误；已见 artifact 参数互斥、源路径不存在和版本冲突，不能把所有错误当 bug | 按 invalid arguments/env/provider/timeout/abort/unknown 分类后选真实回归；只修有证据缺陷 |
| 4 | 大输出首次落盘/保全 | host 完整输出已保全落盘；重复前两次全量仍大。输出重格式化收益尚未证明，按 profile 的 tool_results 份额与减少率测 | 所有字节保全、尾部错误、读范围/生命周期 E2E；新格式须 flag；先保全再格式实验 |
| 5 | docs 精简 flag（已实现） | 估算每次 250 tokens；需对照是否多一次文档读取。中等质量风险 | 环境变量关闭并重启 |
| 6 | volatile setup 后移/cache layout | SDK 已管理 Anthropic system/tool/history breakpoint；不能重复加或重写旧 transcript。需 profile 验证 prefix 不稳定来源 | 可证明 volatile 位置后按 provider 处理；保持用户可见实际 prompt 真值 |
| 7 | compaction/subagent 提示词 | 已有短 handoff；本次不盲缩。协调和质量风险高 | 使用完整长任务与恢复对照；独立 flag |
| 提案 | 模型、路由、effort、分工 | 已批准隔离评测；免费 worker 未通过可行性门槛。whole-tree 收益仍未证明，未切换默认值 | 用户选择实验后独立配置比较 |

## Provider/cache 核对

当前 transport 只验证 openai-completions 与 anthropic-messages；SDK 0.86.1 已处理 Anthropic cache_control（system、末工具、消息），支持 short/long/none retention。OpenAI 兼容网关不必遵循官方缓存或价格；不能把 provider 名当计价证明。实际价格须用每调用冻结快照，不用今天官网价重算旧任务。

官方资料：[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) 与 [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。OpenAI 文档区分模型代际及 retention，不能套用统一 TTL；Anthropic 显式断点/5 分钟与 1 小时写入费不同，minimum cacheable length 按模型决定。代理与订阅模型的适用性仍须供应商确认。官方 Anthropic 页面本次抓取失败，搜索摘要仅作线索，不作为已核验参数交付。

## 实验和质量门槛

固定真实任务集：短问答、项目文件修改、首次建图、patch/返工、恢复、长对话压缩、artifact 发布/读取、权限/预算拒绝。保存用户原话和任务验收；同模型、effort、配置、工具目录和 repository 起点；冷/热缓存与跨 TTL 间隔分别成组。至少多个重复并报告方差，不把一次 scripted provider 当质量证明。

docs flag off/on 单独比较：任务成功、验收通过、需要用户纠错、总请求/turn、读文档次数、工具错误、latency、cache request-hit 与 token fraction、价格加权总费用。人工盲评结果，统计置信区间；只有费用下降且质量与其他 guardrail 无超噪声退化才上线。工具 offloading、输出格式、压缩与协作提示独立实验，记录 null result，不一起更改。在线若有流量以完整功能任务随机分组，main 与所有 child 成本合并；用户后续报告问题和代码存留作长期信号。

新 E2E 验证真实 HTTP→Pi→外部模型 fixture→bash→文件→SQLite→公开统计入库→只读 CLI；供应商 fixture 只替代外部服务。它证明 telemetry 与成本计算路径，不证明真实模型质量等效或节省。

## 尚未完成的证明

精确来源×billing 归因、真实模型固定任务前后对照、完整任务树 main 费用分摊、在线 A/B、profile 持久存储增长与 latency、reasoning 连续性逐调用核验、host 大输出保全、完整 rendered history 的静态/volatile 审计和完整门禁结果仍需推进。默认关闭实验不算已验证优化。

## 后续现场核对

继续执行期间读取最近三份 kernel_prompts：system 均为 9,309 字符、tools 均为 10,571 字符，名称/顺序一致；实际 system 包含 instructions、identity、rules、docs、project_context、available_skills 和 cwd。没有 `2026-MM-DD` 日期字符串。此样本不能证明全局 prefix 稳定，但否定了“未检查即认定每轮时间戳污染”的假设。工具仍有低频图与 artifact 能力，是否卸载需配置对照。

输出链的进一步定位：`kernel-operation-broker.ts` 将 HostCommandResult 写进 result.json，再把末 32,768 字符放进接口回执。当前 32MiB 截断发生在此文件写入之前，因而 result.json 也无法恢复被丢弃字节。保全需要在 host-command 流消费边界写 stdout/stderr 文件，并将路径、字节数与 digest 放入正式结果，不能只在最终回执多写一个路径。全量测试运行期间保持源码冻结，待其结束再实施。

## 第二批实施与验证

第一批完整门禁：`node --run check` 通过，265 文件/1,479 测试，验收证据未变化。日志 `/tmp/graph-harness-check.log`。该结果仅覆盖第一批源码。

已修复 unsandboxed workspace.command 的输出丢失：`host-command.ts` 在流消费时写 host-owned 操作目录的 stdout.log/stderr.log（0600、独占创建），统计原始字节和 SHA-256；`kernel-operation-broker.ts` 正式 result.json 与接口结果携带 outputFiles。原 inline 上限不变，读取完整文件可恢复末尾。写盘失败中止命令并进入既有不确定副作用处理，不返回伪完整结果。文件随已有 operation scratch 生命周期保留，无新的自动删除策略。尚未覆盖 sandbox runner 自身的截断行为。

新增公开运行时 E2E 创建实际 graph、投递模块输入、执行大于 32MiB 的 Node stdout、验证尾部/字节/hash、关闭重启后核对同一 settled result。已通过；临时关闭唯一生产 outputDir 接线后同流程失败于缺失 outputFiles，源码已逐字节恢复。初版测试的 Buffer 深比较造成测试进程 OOM，改为长度/尾部/hash 后通过，不提高 heap 或缩小输出避开原上限。

文档实验的 HTTP→Pi→真实 shell→SQLite→CLI E2E 扩展为 flag off/on；它只验证配置与调用链兼容，不代替真实模型质量 A/B。第二批最终门禁尚需重新执行。

进一步核对低频工具：`mcp-adapter-bridge.ts` 已将 runtime-registered MCP servers 设为 proxy-tool-only，经单个 `mcp` gateway 访问。因此不能将所有 MCP 完整 schemas 当作当前静态负担或重复实施卸载；排序第 2 项实际针对仍直接暴露的 Graph 工具与扩展，需按 name 分析静态体积再选 split。

Reasoning 传输审计：`assistant-stream-frames.ts` 重建 thinking 内容、thinkingSignature、redacted，终态保留完整 settlement；kernel 调用使用 SDK normalizeContext。未发现有证据的主动删除，故没有为省 input 而修改 reasoning。此源码证据不等同于所有供应商加密 reasoning 的端到端证明。

第二批完整门禁通过：266 文件/1,481 测试，验收证据未变化（`/tmp/graph-harness-check-final.log`）。随后第三批补充只读报告：使用 kernel 已冻结 model.cost 或新 profile 的调用时 rates/pricing，输出 billing type 费用，不用当前目录重算历史。新 profile 同时记录价格元数据；缺价格仍为 null。新增 cacheHitRequestRate（可计量请求中 cacheRead > 0 的比例）、meanEstimatedStaticTokens，不与 cache token fraction 混用。HTTP/CLI E2E 两种 docs flag 已通过，并增加四种 billing 费用的独立预期断言。

对真实库新快照中 1,156 个带冻结完整价格的调用：USD 输入 0.158202、输出 0.4211898、缓存读取 0.732423936、缓存写入 0；仅代表这个可定价子集，不能推断其余约 1.8 万请求的费用分布。来源×billing 联合分布仍未知。全任务树需要显式功能任务和 main operation 的归属窗口；现有 kernel_graph_owners 仅能证明拥有关系，不能分摊一段长期聊天，保留为缺口而不按拥有关系重复收费。

## 供应商官方核对补充

实际节点调用主要使用 OpenCode Go 上的 DeepSeek/LongCat/Step 等模型，而不是直接 OpenAI。已打开 [OpenCode Go 官方文档](https://dev.opencode.ai/v2/docs/console/go/)：要求稳定 `x-opencode-session`（Graph 已实现），不同模型有不同计费种类；Flash 当前 input/output/cacheRead 的 peak 价格为 0.30/1.20/0.006 USD/MTok，off-peak 为 0.15/0.60/0.003，cached write 未列价格。免费预览模型有免费行，不代表所有模型或历史时间免费。这是订阅额度权重，不应当直接称为额外现金支出。

[DeepSeek 官方 cache 文档](https://api-docs.deepseek.com/guides/kv_cache/)说明缓存自动启用、完整前缀单位匹配、best effort、构建需数秒，闲置后一般数小时到数日清除；没有此页承诺的固定统一 minimum length。usage 用 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。其[当前定价](https://api-docs.deepseek.com/quick_start/pricing/)不重算 OpenCode 或历史调用。Anthropic 直接页面因地域不可用而未核验。

源码差异：Pi SDK 的 openai-completions 已按 standard cached_tokens → DeepSeek prompt_cache_hit_tokens → Kimi 顶层 cached_tokens 的优先级解析；Graph controlled-openai 独立预算结算层仅支持 standard。后续回归将验证并修复这个计费分类缺口。

## 计量回归与门禁现场

第三轮完整门禁为 265 文件通过、1 文件失败；1,480 测试通过、1 失败。失败是现有未提交 UI 工作中的 `desktop-shell` OpenRouter disconnect，等待 secretRefs 清空超时；不能将该轮记录为全绿，需复跑确定。日志 `/tmp/graph-harness-check-delivery.log`。

新增 DeepSeek/Kimi 真实供应商 HTTP fixture 回归，在修复前标准字段通过、两种原生字段失败：相同两次请求的 input 从预期 50 变为 80、cacheRead 从 30 变为 0。Graph 预算解析现与 SDK 一致：standard details.cached_tokens 优先，其次 prompt_cache_hit_tokens，再其次顶层 cached_tokens；仍校验非负整数、cache <= input，不改总 token，也不回写旧账单。这是费用分类正确性修复，不是实际 token 节省。

## 真实模型对照：负结果，拒绝默认开启

使用本机已有 OpenCode 凭据（未打印密钥）、当前配置首选 `opencode-go:deepseek-v4.1-flash`，独立临时项目/状态库、相同模型与默认 effort，各运行一次用户原话：`修一下 config.js，空白行别当成配置，保留值里的等号。` 初始解析器错误地用 split('=') 拆值并保留空行。真实 Node CLI 检查 `A=one=two\n\nB=3\n` 的键值与键数量；无模型替身。实际任务包含模型自己的读、编辑、shell 和回复，不只计最终请求。

| 指标 | 默认 docs | compact docs |
| --- | ---: | ---: |
| 行为检查 | 通过 | 通过 |
| 正式 operation state | succeeded | succeeded |
| 正式 operation 时长 | 71,833 ms | 119,677 ms |
| 模型请求 | 10 | 15 |
| 未缓存输入 | 14,063 | 22,482 |
| 输出 | 8,237 | 9,295 |
| 缓存读取 | 134,400 | 220,416 |
| 权威 usage 缺失 | 0 | 0 |
| 配置缺价格的调用 | 10 | 15 |
| 同一价格权重下任务成本 | $0.0149097 | $0.019221096 |

价格权重是官方 Go Flash peak 输入/输出/cacheRead 0.30/1.20/0.006 USD/MTok 的**情景计算**，并非账本正式费用或实际订阅现金增量；未回填原库价格。成本增加约 28.9%，请求增加 50%。n=1/组且顺序不同、热缓存程度不同，不能将差异因果归于 docs 文案，也不能声称质量统计等效。但它明确不支持开启，继续默认关闭。只看 docs 少 250 估算 tokens 会给出错误上线结论。

原始结果在 `/tmp/graph-real-eval-default.json`、`/tmp/graph-real-eval-compact.json`；各自 root 下保留会话和 cost-report.json。compact 的早期轮询在 120 秒边界未看到最终消息，原始 completed=false；停止后读取正式 operation 已 succeeded，故表中使用正式状态与 ledger 时长，没有把轮询超时冒充任务失败。可重复的公开运行脚本：

```sh
GRAPH_COMPACT_DOCUMENTATION=0 node scripts/harness-real-eval.mjs /path/to/graph.config.json
GRAPH_COMPACT_DOCUMENTATION=1 node scripts/harness-real-eval.mjs /path/to/graph.config.json
```

该脚本会实际调用模型、创建私有临时项目并保留证据；使用传入配置的首个模型，模型与凭据配置不回写，结果仅打印统计。扩大任务集与重复次数前，先定义预算、完成归属与质量判定；本轮不以更多试验筛选出偶然获胜样本。

## 最终验证与提交

最终生产源码门禁 `node --run check`：266 文件、1,482 测试全部通过，baseline 合法增长，验收证据未变化。日志 `/tmp/graph-harness-check-verified.log`。此前一次桌面 disconnect 超时已记录，单独复跑通过，随后这轮全量也通过；不删除或弱化该门禁。最终脚本新增后还需一次完整门禁，文档不影响运行源码。

- `b3a7ab9`：请求 profile、价格快照、成本 CLI、原生缓存 usage 字段兼容与真实 HTTP/工具/CLI E2E。
- `4c3f12c`：确定工具排序。
- `3bc015d`：完整命令输出保全、正式路径与重启 E2E。
- `f8c2a08`：默认关闭的 docs 精简实验。

没有推送或重启用户应用；其他供应商/UI 工作区改动继续保留。测试总数 baseline 文件原先已有其他工作修改，未将其整文件混入上述提交。

## 对照原交付要求的审计

| 要求 | 证据/边界 |
| --- | --- |
| Harness 地图与 baseline | 本文地图、真实 DB 一致快照、实际 prompt 样本、只读报告；缺联合来源×billing 的原因明确 |
| 按完整任务和计费种类 | 独立真实任务含全部请求；历史 graph/main 未分摊明确标为不可计算，不记零 |
| 机会排序、估算、质量风险、验证与 rollback | 排序表；MCP 已 offload 的现场修正；不套用外部团队百分比 |
| 安全直接修改与独立回滚 | 上述四个提交；遥测异常不阻塞发送、输出保全不改预览合同 |
| 提示词 diff 与 keep/rewrite/delete/move | 逐行审计表、实际 diff；其他规则 keep；实验默认关闭 |
| Flagged test plan | 固定任务、cold/warm/TTL 对照、盲评、全树成本、在线 guardrails；已完成一个真实负对照并拒绝上线 |
| 模型/effort/分工只提案 | 未改用户默认值；临时 benchmark 采用当前首个模型 |
| 报告 gaps | 明确列出价格、功能任务归属、精确来源 tokenizer、完整真实质量集、在线结果；没有据此宣称目标业务指标已达成 |

工程交付和可复现实验已形成；**真实业务的“每完成任务成本下降且质量不降”尚未被证明**。需进一步实验或真实流量，不能把这份工程交付自动等同于业务优化目标完成。

最新主会话工具快照逐项体积（JSON 字符）：agent_browser 10,158；mcp 3,341；mcp_context7_resolve_library_id 2,938；apply_rsi_change 2,300；propose_graph 1,795；mcp_context7_query_docs 1,731。Graph graph_create/graph_patch 已使用 Type.Any definition/changes，不存在可凭空拿掉的庞大嵌套 schema。下一轮按需加载候选应先针对低频浏览器/扩展工具，并核对 gateway 与直接 extension 的实际注册归属；不能根据工具总字符推断每个 Graph schema 都很重。

## 第四批：目录工具按需加载实验

`GRAPH_DEFER_CATALOG_TOOLS=1`（默认关闭）延后 get_agent_combination、get_resource、list_agent_combinations、read_system_capabilities、search_resources、inspect_graph_system 六个已绑定查询工具。首个请求只给一个 `load_catalog_tools` 名称/用途提示，模型调用后 SDK 在下一请求加入完整 schemas。核心读写、shell、搜索和 graph 执行工具常驻；没有增加模型、effort 或另一个执行 owner。

使用 SDK 原生 setActiveToolsByName；createAgentSession 的 tools 参数其实是注册白名单，不能直接删除 deferred 名称，否则后续无法激活。开关显式从父进程写入 worker config，不通过扩散所有环境变量传递。宿主加载器仅变更已绑定 schema 可见性并写实例元数据；加载后的真实查询仍走原有宿主权限门。状态在实例目录持久化，fresh session 重置；当前授权清单仍过滤已删除/禁用工具。inspect 读取实际激活列表。关闭开关并重启恢复全量表面。

公开 HTTP E2E 从真实外部供应商 fixture 发出加载/查询调用，验证第一请求缺 schema、下一请求有 schema、owner 查询成功、重启后再次查询；同时证明核心工具存在。初次失败先暴露子进程开关未传递，随后暴露 SDK registry/loadout 区别；最终两个文件四项测试通过。真实模型 parser 任务与完整门禁正在验证该批；在结果前不宣称成本下降。

新增风险：加载会增加一轮、改变 SDK system/tool transcript，写一个实例状态文件；它是否划算取决于任务是否使用目录，以及缓存与轮次变化。因此它继续是独立实验，不默认上线。浏览器扩展尚未卸载：前面的临时真实任务没有加载浏览器，不能把其结果外推至浏览器。

上一轮额外 artifact 门禁曾在已存在的 composer UI 选择恢复断言超时（`tests/e2e/composer.test.ts:305`）；未修改该文件或弱化断言，日志 `/tmp/graph-harness-check-artifacts.log` 保留失败。此前生产修改的完整绿色结果仍单独保留，不将此轮伪报全绿。

第四批真实模型结果（同一 parser 任务、模型、默认 effort，docs 精简关闭）：行为检查通过，正式 operation succeeded；75,934 ms、12 请求、input 11,878、output 9,020、cacheRead 170,368，无 usage 缺失。以相同 peak 权重得到 $0.015409608，比默认样本 $0.0149097 高约 3.35%；每请求静态估算从 11,285 到 10,706，工具估算从 8,351 到 7,770，约少 579 静态估算 tokens/请求，却未降低任务成本。目录工具没有在此编码任务中被调用，证明收益也不能仅由避免加载一轮估算。n=1/组不支持因果结论；依然拒绝默认开启，后续只按预先固定的代表任务集和重复计划再评估。结果 `/tmp/graph-real-eval-catalog.json`，完整会话位置由其中 root 指向。

第四批全量门禁仍在原有 composer 全选/删除流程失败：这次浏览器选区已达到 hello，但 Backspace 后只剩 hell（`composer.test.ts:307`），隔离运行通过。按 e2e-race-conditions 保留严格语义，新增等待生产编辑器暴露的 selectionStart/End 为 [0,5]，再确认 DOM selection，并用 page.keyboard 发送删除键，避免 Locator.press 重新聚焦 contenteditable 重置选区。没有添加私有测试 seam、固定睡眠或放宽结果。完整并行门禁正在 `/tmp/graph-harness-check-race.log` 验证，此前失败保留在 `/tmp/graph-harness-check-catalog.log`；尚不能将修正标为已验证。

并行竞态复核：`/tmp/graph-harness-check-race.log` 中 composer 修正通过；剩余失败为 desktop-shell 的 pendingSecretRefs 精确清空断言。生产桌面 main.mjs 每 1,500 ms 才轮询并确认持久化队列，UI 的“凭据缺失”只证明即时撤销，不证明该轮异步持久化已完成。E2E 改为在明确的 20 秒窗口等待 exact []，继续保留 keychain 重启后无可用凭据的验证；没有固定延迟、删除断言或把仍 pending 当完成。完整门禁 `/tmp/graph-harness-check-complete.log` 正在验证。两处仅限必要 E2E 等待/按键修正，不采用对界面功能的其他改动。

大输出真实 baseline 也已完成（`/tmp/graph-output-eval-default.json`）：检查程序输出 5,000 行，配置修复后完整 CLI 验收通过，检查程序逐字节保持原样；7 请求，input 13,356、output 1,764、cacheRead 69,248。实际 Agent 自行用 tail 和 /tmp 日志避免灌入进度行。因此这个任务并未真正触发大输出压缩机会，不新增未经触发验证的输出格式 flag，也不拿它声称格式优化收益。

更严格的选区等待再次在全量失败，证明旧的光标恢复会真正覆盖用户选择，不只是等待时间不足。生产根因在 ChatComposer.applyProgrammatic：undo/redo 先改值，再用 requestAnimationFrame 恢复末尾光标；后续 Mod+A 可先执行，旧回调随后把 [0,5] 覆盖为 [5,5]。新增 selectionEpoch，后续 keydown 或 selection 更新使旧回调失效，保留无后续操作时的正常光标恢复。隔离 E2E 通过，完整负载 `/tmp/graph-harness-check-selection.log` 验证中。此前 `/tmp/graph-harness-check-complete.log` 的全量中 desktop 等待修正已通过，composer 失败保留；没有将单跑通过当成完整证明。


最新完整门禁已验证目录加载 E2E、光标恢复生产修复与真实桌面持久化等待：267/267 文件、1,483/1,483 测试通过，验收证据未变化。目录加载实验提交 `068f940`；光标恢复修复和对应 composer 断言提交 `33eb786`。composer 文件只暂存相关选区 hunk，既有新动画测试和代理变化没有混入。desktop 等待修正位于使用者尚未提交的整个新授权 E2E 中，保留在工作区，未把该整项供应商/UI 工作纳入本任务提交。

历史工具错误的可见原因已按实际证据记录：artifact_publish 的参数二选一错误、源路径不存在、版本冲突。未知原因不假装归类完成；没有为了减少错误率而放宽来源和并发保护。

## 缓存证据边界补充

本地 estimated usage 的 cacheRead=0 是估算器缺证据的默认值，不能计作一次真实缓存 miss。新增真实 HTTP→shell→SQLite→CLI 的 usage 缺失场景，在修复前明确失败于 cacheHitRequestRate=0（预期 null）。报告现单列 cacheMeasuredRequests、cacheUnmeasuredRequests、cacheEvidenceTokens，仅 authoritative/legacy-authoritative/account_delta 参与缓存比例和按计费类型费用；estimated/unknown 保留自身计数与总估算，不冒充缓存证据。五种供应商响应场景全部通过，包括真实 429 后的重试：拒绝请求仍计入 requests，但不冒充缓存 miss。历史 main 零用量且无 request profile 的记录无法区分工具准入与供应商尝试，仍排除；node provider 记录和有 profile 的 main 请求完整保留。最新只读快照 `/tmp/graph-harness-baseline-v3.json`。完整门禁 `/tmp/graph-harness-check-retry.log`：267 文件、1,485 测试通过，验收证据未变化。

## 当前目标验收审计

| 原始要求 | 权威证据与结论 |
| --- | --- |
| 地图、真实 wire、模型缓存/价格 | 本报告地图、provider profile、官方资料；历史价格缺失仍明确未知 |
| 来源 × billing、静态量、缓存、每任务轮次、工具覆盖/错误 | CLI 已提供可观测项；来源估算不可当精确账单拆分，完整来源计费归因未完成 |
| 机会排序与估算/风险/回滚 | 本报告机会表；以体积 proxy 排序，不虚构收益 |
| safe 变更独立提交 | telemetry、排序、完整输出保全和已证实错误修复已提交；生产默认提示词与模型未改 |
| prompt 逐行处置与 diff | docs 块完整映射；其他身份/规则保留，未假称全部删除 |
| 风险变更 flag 与验证方案 | 两 flag 默认关闭；已记录费用未降，不启用 |
| 模型/路由/effort/分工仅提案 | 隔离评测已批准；原生 worker LongCat 候选不通过，不扩大生产范围 |
| 固定集与真实使用质量/成本验证 | 有探索与 parser 原生 worker 小集；模型候选提前触及可行性失败门槛。没有 whole-tree 降本或质量等效证明 |
| reasoning 与完整结果保留 | 未删除 reasoning；大型命令输出完整文件保全。未以截断/放弃任务获得节省 |
| 目标：每完成任务价格加权成本下降且质量不降 | **未证明，goal 不能标为完成** |

后续应返回已观测大开销的 harness 层。main 的浏览器工具正文曾约 10,158 字符且保留样本仅 11.76% 任务调用，现有目录加载 flag 只覆盖六个小 catalog 工具，未覆盖这个主要体积来源；若开展浏览器按需加载，必须独立默认关闭、有真实绑定的浏览器工具、首次任务发现与加载后调用 E2E，并用完整任务对照，不能拿当前无浏览器工具的隔离跑分证明收益。尚未实现该候选。

main 评测器取消收尾现同时等待 operations.worker_active=0 与所有 invocation 的费用结算标记；失败账本曾证明 provider profile 在 pause 之后才出现，不能仅用调用表当前为空推断已静止。该改动不改变生产权限/模型/提示词。局部四条 E2E `/tmp/graph-eval-active-drain.log` 与上述完整门禁通过。

浏览器大 schema 实验已实现独立默认关闭 flag，完整报告 [浏览器按需加载](harness-browser-loading-2026-10-16.md)。六次同模型对照 A 3/3、B 2/3 完整成功；首请求工具 JSON 少 9,885 字节，但统一权重的每完成任务估算约贵 39.1%，且价格/一次 usage 未知，不能当精确账单。候选未通过，保持关闭。最新带真实浏览器门禁 269 文件、1,491 测试通过。RSI backlog 的额外工作已在轨迹确认，尚未改变其产品职责；artifact schema 字段缺少 kind@version 格式说明是下一项有证据的参数错误候选。

Artifact schema 格式说明已按真实错误补齐，不改运行时保护；四项真实 artifact E2E 通过；完整门禁 1,489 项通过、2 项浏览器环境依赖测试跳过（总清单 269 文件/1,491 测试）。三个真实模型发布样本完整成功、无工具错误，尚无固定未修改对照，不能据此声称降本。详见 [参数说明修正](harness-artifact-schema-2026-10-16.md)。

RSI 摩擦分类提示词已作默认关闭实验，默认 A 3/3、实验 B 1/3 在期限内完整成功，未通过，不启用。详见 [分类实验](harness-classified-friction-2026-10-16.md)。轨迹发现无条件 ffind/ffgrep 指令与未绑定能力不匹配，是后续更具体的根因候选。最新门禁 1,490 通过/2 浏览器环境依赖跳过，总清单 269 文件/1,492 测试。

实际搜索指引匹配的默认关闭实验已完成首轮组合验证：见 [搜索指引匹配](harness-matched-search-2026-10-17.md)。同分类 flag 组合 B 3/3、A 2/3 完整成功，统一权重每完成任务初步下降约 66.8%，但只有一类任务且基线含未知用量，不启用、不宣称整体降本。真实 FFF 扩展和用户规则保护 E2E 已通过；完整 1,494 通过/2 浏览器依赖跳过，总清单 269/1,496。

2026-10-17 验收复核：CLI 跨类别复验发现样本读取公开评测源码，已停止调度并允许在途样本结束，未用旧固定验收结果支持启用。验收器现于模型结束后生成新的合法次数，真实 CLI E2E 证明通用实现通过、只适配旧次数的实现拒绝；负向控制与完整带浏览器/FFF 门禁通过，269 文件/1,498 测试，证据未变。候选仍默认关闭，尚未形成独立跨类别降本证明。成功报告保留新输入，失败输入诊断仍待补齐。

2026-10-17 后续诊断：失败报告也保存模型结束后生成的 CLI 参数（generatedCounts），真实退化回归与完整 1,498 测试通过。两次新最小环境试跑均失败，未支持跨类别收益。发现临时 graphHome 只含 main、无 worker 配方，和实际安装能力不同；main 成本实验仅属最小环境探索，不能宣称生产整棵树收益。下一步应补齐受控配方和提案确认流程。
