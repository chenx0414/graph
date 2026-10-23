# Graph harness 已做的修改：2026-10-22

[返回主报告](harness-token-efficiency-2026-10-22.md)

## 4. 已做的修改

四个独立提交，每个可单独 revert。

### 4.1 `81083e55` Replay the assistant turn the model wrote

**问题**：daemon 拼请求时，助手回合只保留 text 和 toolCall。模型写下的 reasoning、Anthropic 给 reasoning 的签名、provider 自己留着的 redacted reasoning、以及 **Anthropic 传输上的 tool_use 块本身**，全部被丢掉。

后果不是小事：

- 模型读不到自己的 reasoning，就会从问题重新推一遍计划，每个长任务每一轮都付 output token。
- Anthropic 请求里 tool_result 没有对应的 tool_use，provider 直接拒绝——那一轮无法继续。
- 供应商的 tool-call index 是"第几个调用"，不是"回合里的第几块"。先 reasoning 再调工具的回合，reasoning 在第 0 块、调用在第 1 块；旧代码用 index 0 开工具块，把 reasoning 覆盖掉了。

**改法**：按供应商原样捕获并回放。

- OpenCode Go 网关用 `reasoning` 回 reasoning、用 `reasoning_content` 读回来，所以记录答案来自哪个字段，回放就写回同一个字段（`runtime_controlled_openai.go` 的 `controlledOpenAIReasoningDelta` / `markReasoningField`）。
- Anthropic 的签名在自己的 delta 里（`signature_delta`），连同 redacted 块的 opaque payload 一起保留。
- 工具调用改成按到达顺序占块，供应商的 index 只用来认调用。

**验证**：新 E2E `tests/e2e/provider-assistant-replay.test.ts` 跑真实 Go 后端 + 真实 PiG 内核 + 真实 bash 工具，打脚本 provider，断言 provider 收到的请求体。**改前两条都红，改后两条都绿。**

### 4.2 `90805741` Mark the cacheable prefix on the Anthropic transport

**问题**：Anthropic 自己不缓存前缀，只缓存断点标记的部分，其余按满额输入价计费。daemon 的 Anthropic 请求**一个断点都没有**——系统提示、工具声明、整段对话每一轮都按满额重新付一遍。

live 对话的前缀能到 50 万 token 量级，同一段前缀每个 operation 要付十几遍。

**改法**：按 Anthropic 的三个断点标记——系统提示、最后一个工具声明、最后一条对话消息。对话每轮长一条消息，所以每轮只有新增的那部分 token 需要写入缓存，其余从上一轮留下的缓存里读。

**没有改 OpenAI 兼容传输**：那条路自己会缓存（实测命中率 98.1%），而严格的 OpenAI 兼容服务器会拒绝它不认识的 body。

**验证**：同上 E2E 断言三个断点都在。

### 4.3 `a65a462a` Let the environment name how far the context may grow

**问题**：会话在到达供应商窗口前才压缩，于是长到 50 万 token。压缩读取是任务花费里最大的单块，而主会话就是它挣来的地方。

**关键观察**：压缩提前，压缩调用读的总 token 不变。会话多压缩四次，每次总结的就少四倍，加起来还是那些 token；会话继续时拿到的摘要也一样大。**只有每个请求携带的前缀变小。**

**改法**：`GRAPH_COMPACTION_CONTEXT_CEILING` 命名这个上限。默认不设 = 今天的行为；daemon 自己的溢出压缩照旧。

**验证**：新 E2E `tests/e2e/compaction-context-ceiling.test.ts`——设上限时 provider 收到一次摘要请求（一个远未填满窗口的对话），不设时不收到。改前红，改后绿；默认路径两种情况都不变。

### 4.4 `bc4ce52b` Price the whole tree and show the prefix every request carried

报告原来有"一个任务花了多少、请求去了哪里"，但没有价格由什么构成的两块：

- **每次请求的前缀**（= 该请求的缓存读取）的分布——压缩阈值动的就是它。
- **用途**（completion / compaction / prompt_suggestion / skill_sediment）是四种不同的花法，原来是一个数。
- **整树情景计价**：有价格调用用过的费率 × 全部记录 token。报告里写明这是情景不是账单。

现有 CLI E2E 增加对应断言，10 项仍全绿。

### 4.5 给摘要它需要的空间（`57cd34bd`）

压缩失败会把会话留在它想缩小的那段上下文里，之后每个请求都重新付整段前缀。记录在案的历史里有 **9 次压缩失败，其中 6 次是同一个原因**：摘要生成撞到输出上限，摘要不完整。

两个东西挡住了一个放得下的摘要：

- **请求自己的输出预算没有到达供应商。** 内核给摘要请求的是有界预算（daemon 自己的指令要求"约 1500 token"），但 `pigkernel/provider.go` 的桥把 daemon 的常驻 options 递了过去，**丢掉了这一次请求的 options**。供应商被问的是模型的整个输出上限（生产模型是 384,000）。被要求写 384,000 token 的摘要不会写成交接摘要，它会一直写到被切断为止。
- **内核要的摘要比 daemon 要的小。** reserve 是内核花在摘要上的额度，被设成 1,024——它的五分之四只有 819 token，比 daemon 要求的交接摘要还小。

改法：请求的预算随请求走（`requestOptions`），daemon 按调用方要的数量向供应商要；reserve 提到 4,096，交接摘要放得下。

**验证**：E2E 用一个"尊重自己输出预算"的供应商，断言摘要请求带的是它自己的额度而不是模型的（改前 8192，改后 3276），并断言交接摘要进了下一轮的历史（压缩真的替换了历史，而不是留着 496K 的上下文）。

### 4.6 让会话保留它已经读过的任务说明

**问题**：任务说明包（briefing）描述任务运行的环境：绑定的能力、目录、系统上下文。它在任务的**每一次 operation 里都是同一段文字**，而 operation 的提示词会进入 transcript，而 transcript 每个请求都要重读一遍。62 次 operation 的任务因此带着 62 份同样的文字，每个请求都付了 62 份的钱（实测相邻两份 89.5% 逐字相同，公共后缀 3,131 字符）。

**改法**：`GRAPH_REUSE_TASK_SETUP=1`（默认关闭）。会话已经读过的那段说明不再重发，提示词里留一行"任务说明与上一轮相同"。

会话是否还带着这段说明，由三件事共同决定，任一不成立就照旧全量发送：

- **会话是延续的**（不是新会话——新会话什么都没读过）；
- **这一轮没有压缩**（压缩替换了整段上下文）；
- **这段说明没有变**（能力绑定、目录或系统上下文变了就重发）。

记录放在 daemon 内存里（`TaskSetupLedger`），daemon 重启就忘——忘的方向是重发一次，安全。**没有动数据库 schema**：TS 与 Go 两端共用一个 `tasks.sqlite`，schema 版本必须同步，加一列会让 TS 侧拒绝打开 Go 侧升级过的库。

**验证**：新 E2E `tests/e2e/task-setup-reuse.test.ts` 跑真实后端两次：开关关闭时第二次 operation 的提示词仍带说明；开启时第一次带、第二次不带，并留有"说明未变"的标记。把复用逻辑打断后，开启那条 E2E 变红，关闭那条始终绿。

### 4.7 系统提示词审计（逐块处置）

**本轮没有改系统提示词，所以没有系统提示词的 diff。** 理由见 §3：在 246K 的前缀里，Graph 自己那 6.5K 字符只值 0.8%；前一周的 docs 精简实验在真实模型对照里**贵了 28.9%**（多 5 次请求、请求数 +50%）。在降下阈值之前动提示词是净负。

**逐块分类**（main，18,349 字符）——目标书要的 keep / rewrite / delete / move 四类都在下面，**每一类都点名**：

| 块 | 字符 | 分类 | 理由 |
| --- | ---: | --- | --- |
| `<identity>` | 2,375 | **keep** | 身份与职责；`DEFAULT_MAIN_RSI_IDENTITY`（1,882）含 harness 自改进契约，改写会改变职责边界 |
| `<rules>` | 4,911 | **keep** | 公共规则 2,047 + 角色规则 + 运行时规则 + 工具指引 + 测试政策。R22/R23/R24/R27 是产品契约（只允许 E2E），不能删 |
| `<docs>` | 1,889 | **rewrite（已存在 flag，默认关闭）** | 上一轮已做逐行映射与真实模型对照；结论是**不开启**。本轮不动 |
| `<available_skills>` | 8,035 | **move（提案）** | 系统提示最大块，但只占前缀 0.8%。改成按需发现会多一轮，收益 0.8% < 一轮成本。**等阈值降下来再评估** |
| `<project_context>` | 523 | keep | 工作目录的 AGENTS.md，模型读不到环境 |
| `<skills>` | 337 | keep | 技能加载说明 |
| `<cwd>` | 279 | keep | 模型需要知道相对路径解析在哪 |
| **delete** | **0** | **本轮没有一块要删** | 目标书让删的是"强模型本来就会做的事、为没见过的行为写的护栏、重复工具说明、与用户请求可能矛盾的行"。**这七块里没有一条属于这三类**：要么是产品契约（R22–R27），要么是模型确实不知道的环境事实，要么删了会让模型少知道一件它猜不到的事。**上一轮已经删过一轮**（当时的结论写在上周的报告里），剩下的删不动了。**为了凑出一个"delete"而去删一行，是拿质量换报告好看——不干。** |

工具声明（46,884 字符）：**offload（提案，暂不做）**——按 §3 第 4 项，杠杆在阈值不在工具。

### 4.8 把改动过的源文件拆回一个上下文窗口能装下的体积

仓库有一条硬规则：agent 写下的源文件不超过 5,000 token（20,000 字节），提交前的闸门 `scripts/check-file-tokens.mjs` 按暂存内容核对，不合格就拒绝提交。本分支改过的两个文件撞上了它：

| 文件 | 改前 | 改后（拆分前） | 处理 |
| --- | ---: | ---: | ---: |
| `backend/internal/graph/runtime_tool_results.go` | 482 行 | **524 行** | 接缝开关与渲染器挪到 `runtime_tool_result_seam.go`，回到 483 行 |
| `backend/internal/graph/runtime_controlled_openai.go` | 1,643 行 / 50,153 字节 | **1,966 行 / 62,660 字节** | 按职责拆成 6 个文件 |

第二个文件不是本分支写大的，是**本分支往里加了 323 行**（助手回合回放、Anthropic 缓存断点、摘要输出预算）之后撞上了闸门——不改它就没法提交。拆分按职责而不是按长度：

| 文件 | 行 | 装什么 |
| --- | ---: | --- |
| `runtime_controlled_openai.go` | 376 | 发送请求、读回答案的那条流 |
| `runtime_controlled_provider_usage.go` | 222 | 用量记账：供应商回什么就算什么 |
| `runtime_controlled_transport.go` | 252 | HTTP 发送与闸门 |
| `runtime_controlled_context.go` | 452 | 上下文与提示词的装配 |
| `runtime_controlled_stream_events.go` | 215 | 事件循环：供应商的一条事件怎么变成一个块 |
| `runtime_controlled_assistant_replay.go` | 386 | 助手回合的如实回放：reasoning、签名、工具块 |
| `runtime_controlled_anthropic_cache.go` | 98 | Anthropic 的三个缓存断点 |

**行为没有变**：拆分后逐行比对（排序后逐行 diff）与拆分前**完全一致**，构建、`go vet`、`gofmt` 与本分支的 9 项 E2E 全绿。

**还有 6 个文件本分支也改了，它们本来就超预算**——如实记在这里，不藏：

| 文件 | 改前行数 | 改后行数 | 本分支加了多少 |
| --- | ---: | ---: | ---: |
| `backend/internal/graph/core_task_runtime.go` | 5,612 | 5,614 | +2 |
| `backend/internal/graph/runtime_pi_adapter.go` | 2,620 | 2,650 | +30 |
| `backend/internal/graph/core_execution.go` | 1,461 | 1,464 | +3 |
| `backend/internal/graph/core_types.go` | 544 | 547 | +3 |
| `backend/internal/graph/runtime_pig_native_tools.go` | 529 | 529 | 0 |
| `backend/internal/pigkernel/session.go` | 518 | 520 | +2 |

**这些文件在本分支动手之前就超了 500 行、也超了 20,000 字节的预算**（仓库里有 40 多个这样的文件），本分支的改动没有把它们推过线——按规则"如果你的改动把它推过了线就拆"，**这里不适用**。**但如果今后有人再改它们，提交前的闸门会拒绝**，除非先拆开或者在文件头写明 `graph:allow-large-file:` 的理由。**这是下一轮该还的债，不是本轮的。**

---

## 6. Flagged 变更的测试计划

`GRAPH_COMPACTION_CONTEXT_CEILING` 与 `GRAPH_REUSE_TASK_SETUP` 默认关闭。上线前：

**固定任务集**（每组至少 5 次重复，报方差；不用"差一点点"的样本筛胜者）：

1. 短问答（用户原话："这个仓库怎么跑测试？"）
2. 项目文件修改（"修一下 config.js，空白行别当成配置，保留值里的等号。"）
3. 首次建图（main 规划 + 节点派发 + 交付）
4. patch / 返工（同一图二次修改）
5. 崩溃恢复（daemon 中途重启）
6. 长对话压缩（同一会话 40+ 轮）
7. artifact 发布与读取
8. 权限 / 预算拒绝

**分组**：同一模型、同一 effort、同一配置、同一仓库起点；冷缓存 / 热缓存 / 跨 TTL 间隔分别成组。压缩上限组与默认组交替执行，避免把缓存热度差当成收益。

**比较指标**：任务成功、验收通过、需要用户纠错次数、每完成任务花费、请求数、轮数、压缩次数与失败次数、工具错误、延迟、缓存命中率与缓存 token 比例。

**判据**：花费下降且其它护栏不退化超过噪声才开启。记录 null 结果。

**单独测**：压缩上限 64K / 96K / 128K / 192K 四档，找出实际最优点——本报告的推演假设"压缩读取的总 token 不随阈值变"，需要实测确认（每轮多截断的摘要可能改变总结长度）。

**任务说明包复用单独测**：它的风险不是省多少钱，而是模型是否还记得自己绑定了哪些能力。两组各跑同一组任务，重点看：模型是否调用了它应该调用的绑定能力（浏览器、FFF、MCP）、是否重复询问已经问过的问题、是否在长对话后仍按说明行事。建议先在 20 轮以上的长任务上试（重复的代价才显现），再在短任务上试（短任务里省不到什么，却承担了"模型忘了"的全部风险）。

---

## 8. 已核对且无需改动的项

目标书"直接改"清单里的两项，本轮核对后确认**已经是对的**，没有动：

| 项 | 核对结论 |
| --- | --- |
| 确定性的序列化与工具顺序 | Graph + 原生工具按名字排序（`runtime_capability_bundle.go:329`），之后是 codemode、扩展工具、MCP 工具；同一能力集合下逐轮一致。提示词的段落顺序看着是"按字母排"，但那是 **PiG 自己的序列化规则**（`ai.OrderedSections.MarshalJSON` 按名字排，`jsstring.SortOwnKeys`），TS 侧经 SDK 读回来是同一个顺序——**两个内核看到的提示词一致**，CONTEXT.md 的承诺成立。 |
| 把易变内容移出缓存前缀 | 缓存前缀里没有时间戳、没有仓库状态、没有每次都变的清单：系统提示、项目上下文、技能、工作目录都逐轮相同；唯一随能力集合变的是 `GRAPH_MATCH_SEARCH_GUIDANCE` 那一行，而它随能力集合变、不随轮次变。**没有可移的东西。** |

---


