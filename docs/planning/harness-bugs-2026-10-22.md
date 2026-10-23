# Graph harness 缺陷分诊与修复：2026-10-22

分支 `fix/harness-bugs-2026-10-22`（基于 `main` 的 `9aed752`）。

输入：`/Users/macmini/Downloads/harness_bugs.md` 的 53 条 harness 缺陷清单。

## 结论摘要

1. **53 条的去向**：本轮动了 20 条（17 条整条修掉，3 条只修了一个面：#5、#9、#50）；确认为真实缺陷但经决定保持现状的 1 条（#36：ADR 0026 不动，只把工具描述里的后果写清楚）；因为 TS 路径正在被退役而不必再改的 1 条（#18）；这一轮查下来在本栈里不成立、改判 ALREADY-OK 的 2 条（#22、#41）；剩下 29 条分给已有的真实守卫（21 条 ALREADY-OK）、本栈不存在的机制（5 条 N/A）与上游（3 条 UPSTREAM-PIG，另有 #5 的其余部分也在上游）。

   20 条里，15 条有先红后绿的 E2E（#4/#24/#1/#45 与 #5 的 Graph 侧一支、#23/#40/#9 一支、#32/#33/#34、#14、#53、#13、#46）；另外 5 条（#50、#25/#51、#8、#29）没有专属的先红后绿证明——既有的 E2E 仍然全绿，是回归的护栏，但没有一条断言盯住这次的修复。

2. **动到的 20 条是**：被切断的 provider 流被当成成功回合（#4）、流没有以其协议自己的终止标记结束也算成功（#5 的 Graph 侧）、半截的工具参数被当成空参数调用（#24）、provider 不再回话时回合永远挂住（#32/#33/#34：光给读取加上限还不够，失败之后去读那个还在输出的 body 会把同一个洞重新打开，一并修了）、悬空的 tool call 毒化之后每一个请求（#1）、daemon 自己算的压缩阈值从来没交给内核（#23）、压缩“成功”其实什么都没压缩（#40）、压缩事件到不了 daemon（#9）、子 Agent 永远以 `thinkingLevel=off` 运行（#50 的选档部分）、Anthropic 从来没有显式缓存断点（#45）、两个组件各自持久化同一个注册名导致工具体被换掉（#25/#51）、目录清单与搜索没有上限，一个 18MB 的目录能变成一次回答（#14）、守护进程自己从不回收状态（#53）、启动恢复每 boot 重跑同一个 doomed call（#29）、补交额度按 execution 而不是按 node 计（#8）、被停的那一步在任务停掉之后又写自己的结论（#13）、工具 schema 里八成是散文（#46）。

3. **这一轮还查出两条清单里没有、但挡着 #8 的缺陷。**

   - 第一条：**判定“这是环境的问题”的正则写的是 Node 主机的话**（`ECONNREFUSED`、`socket hang up`），而 Go 主机说的是 `connection refused`、`connection reset by peer`——Go 侧一次网络失败都没被判成环境失败，harness 自己承诺的那两次自动重试因此一次都没跑过。已修（`f2f44b5d`）。

   - 第二条：**领取路径只从“已排队”的行里领**——执行器的 claim 读的是 `kernel_queue ... state='queued'`，而生命周期的重试把 node 重新置为 pending、把 activation 的轮次加一，**却把队列里那一项留在 failed**，于是那个 pending 的 node 什么也领不到，重试也就永远不发生。TypeScript 主机（这个 daemon 的原型）做的是同一件事，所以这个洞在原型里也有，不只是移植时带来的。

     这条修过一版（`846bca64`，把队列项放回 queued），因为怕它变成“同一份输入送两遍”而退回（`b67b700e`）；换一种写法再修一版（`b0cd2c8a`），端到端的证明仍然没有：夹具修对之后重跑，node 依旧没在等待时间内落终态。顺着它把顺序查清楚了，答案却在修法本身：worker 先上报自己的结果，执行器随后才把队列项写成 failed，于是**生命周期做重试的时候队列项还是 `claimed`、不是 `failed`**，而重试刚放回去的 pending 也被随后那次失败写抵消（node 与队列项一起被写回 failed）。重新入队的那一版因此撤回（`f9e74a37`）：真正的修法是给这两处写入定顺序，那会动到每一个节点的失败路径，是一件有意识的工程，不该在收尾时上。

4. **#41 查下来在本栈里不成立**：清单写的是"子 Agent 打到回合上限却报完成"。本栈没有回合上限——内核的 `MaxTurns` 默认是 0（不限），daemon 从不设置它——所以那个场景不会发生；"没能回答"的回合本分支已经按失败结算（`c9fae98c`）；节点声明了必需输出时由 `settleDeliverable` 核对，图也不因为节点成功就隐式完成（`docs/agent/graph-v2.md:242`）。改过一轮又退了（`0c9b3a9e` → `5222d84d`）：那个改动让空回合的节点迟迟不落到终态，发一个可能把节点挂住的改动比留着这个缺陷更糟。剩下的残余只有一条很窄的：回合成功结束但没有内容，而节点又没有声明必需输出——契约里节点把必需输出写在 `submission` 里，没声明就没有可缺的东西。

5. **上游那几条**（`github.com/MichaelKinsy/PiG v0.5.1` 与上游 npm 包：#2、#5 的其余部分、#27、#28）本仓库改不了，已按上游文件分组记录，便于一次性提给上游。

6. **与 `feature/harness-token-efficiency-2026-10-22` 的重叠**已在第 6 节逐条列出：该分支已修的 4 条（#23/#40/#45 与任务说明包复用）在本分支上按 `main` 基线重新实现，两边合并时需要人工取舍。

---

## 1. 分诊方法

- 生产 live 路径是 Go 二进制 `dist/graphd`（`desktop/main.mjs:27`、`src/server/cli.ts`），不是 `src/**` 的 TypeScript 实现；`src/**` 只剩开发者/CLI 侧车。分诊以 Go daemon 为准。
- 上游内核是 PiG v0.5.1（`~/go/pkg/mod/github.com/!michael!kinsy/!pi!g@v0.5.1`），只读；`node_modules/@earendil-works/pi-{ai,coding-agent}` 同理。
- 清单里的每一条都是**待验证的假设**，不是事实。每条都要在代码里找到对应的机制，给出 `file:line` 证据，再判定归属：本仓库可修（OURS-GO / OURS-TS）、上游所有（UPSTREAM-PIG / UPSTREAM-TS）、本栈不存在（N/A）、已被处理（ALREADY-OK）。
- 修一律遵守工程规范：只写真正的 E2E（真实 daemon + 真实 SQLite + 受控 provider），先证明修复前失败、修复后通过。

---

## 2. 判定汇总（53 条）

| # | 判定 | 严重度 | 证据 | 机制 / 结论 |
|---|---|---|---|---|
| 1 | **OURS-GO** → 已修 | 高 | `runtime_controlled_openai.go` 请求渲染；`runtime_tool_flow.go` | 悬空 tool call 无结果，provider 拒绝此后每个请求 |
| 2 | UPSTREAM-PIG | 中 | PiG `coding/extension/host/subprocess/host.go:1268` | 扩展宿主 Load 的就绪握手；Graph 无 worker 进程可等 |
| 3 | ALREADY-OK | 低 | `core_kernel_store.go` `kernel_queue`；`core_kernel_recovery.go:55` | 回合有持久队列；残余：claimed 行无租约 |
| 4 | **OURS-GO** → 已修 | 高 | `runtime_provider_stream.go` `readEvents` | 读错误与流结束同形，半截参数被修复成空对象 |
| 5 | **OURS-GO 部分** → 已修 + UPSTREAM-PIG | 中 | `runtime_provider_stream.go`；PiG `ai/` 40+ provider | Graph 只讲两种协议，已要求终止标记；其余在上游 |
| 6 | ALREADY-OK（Graph）/ UPSTREAM（其余） | 中 | `runtime_controlled_openai.go` `controlledOpenAIUsage` | Graph 侧 `Input: input - cache`，缓存 token 不重复计费 |
| 7 | ALREADY-OK | 低 | `runtime_controlled_openai.go:114`；`runtime_compaction.go:176` | 工具结果只落一次；E2E 断言 `resultViews:1` |
| 8 | **OURS-GO** → 已修（E2E 待补） | 中 | `core_node_executor.go` `resubmitsUsed`；`docs/agent/graph-v2.md:190` | 补交额度按 execution 计而不是按 node 计，新 execution 就刷新一次额度；持久护栏被 `maxSafeInteger` 绕过 |
| 9 | ALREADY-OK（上游守卫）+ 已修可观测性 | 中 | PiG `harness/compaction.go:505`；`runtime_provider_stream.go` 压缩事件 | 空摘要上游会失败；压缩事件此前到不了 daemon |
| 10 | ALREADY-OK | 低 | `core_node_executor.go:266-315` | 子 Agent 死亡是响亮的：`graph.node.failed` + 唤醒 master |
| 11 | ALREADY-OK | 低 | `core_execution.go:192-260` | 没找到锁序反转；父进程 retask 不持库锁 |
| 12 | N/A | 低 | — | 以 #11 的死锁为前提；本栈没有这个死锁 |
| 13 | **OURS-GO** → 已修 | 中 | `core_kernel_store.go` `settleNodeAfterStop` | 停止写入与正在停的那一步存在先后竞争：被停的那一步在任务已停之后又写下自己的结论 |
| 14 | **OURS-GO** → 已修 | 中 | `runtime_pig_native_limits.go`；`runtime_bounded_path.go` `listDirectoryLimited` | `ls`/`find`/`grep` 无默认上限，18MB 目录清单先在 Graph 堆里成型 |
| 15 | N/A | 低 | PiG `durable/storage/jsonl` | Graph 用 SQLite 存储，没有 poison 语义 |
| 16 | ALREADY-OK | 低 | `core_node_queue.go:110-125` | 失败项标记 failed 并暂停节点，不静默重投 |
| 17 | ALREADY-OK | 低 | `core_wake_ledger.go:53-59,139-150` | 唤醒负载整体存取，没有 600 字符截断 |
| 18 | OURS-TS → 不再需要 | 中 | `src/core/node-prompt.ts:54-79` | 遗留 TS 路径整读会话文件；`feature/retire-ts-backend` 正在退役这条路径 |
| 19 | ALREADY-OK | 低 | `core_store.go:464` 唯一约束；`core_wake_ledger.go:58-62` | 唤醒按 dedupe key 去重；上游 Install 按名替换 |
| 20 | ALREADY-OK | 低 | `core_pause_continuation.go:18-31,45-50` | 恢复会遍历全部等待项，消费是全局的 |
| 21 | ALREADY-OK | 低 | `runtime_tool_call_spool.go:76-105`；`runtime_pig_recovery.go:179-181` | 两条最近路径要么记录要么明确是 no-op |
| 22 | ALREADY-OK（上游形状） | 低 | `runtime_pi_adapter.go:1324-1340`；`core_conversation.go:388-422` | 每个 token 一次 span 与每个事件一次持久化：Graph 不 import PiG 的 telemetry（没有 span），delta 的写入被 60ms 合并，活动行只写变化的那几条 |
| 23 | **OURS-GO** → 已修 | 高 | `runtime_compaction.go:19-55`；`pigkernel/resident.go` | daemon 算出的阈值从未交给内核，内核用自己的 1024 |
| 24 | **OURS-GO** → 已修 | 高 | `runtime_provider_stream.go` `brokenToolCall` | 半截 JSON 参数被修复成 `{}` 后照常调用 |
| 25 | **OURS-GO** → 已修 | 中 | `pigkernel/session.go` `RegisterCompactionPolicy`；`runtime_pig_session.go` | 注册名按实例派生，换 worker 即丢注册 |
| 26 | N/A | 低 | — | Graph 没有能力依赖图，也没有边数上限 |
| 27 | UPSTREAM-PIG | 中 | PiG `mcp/streamable_http.go:29-31,655-697` | Graph 无 websocket；唯一重连环在上游 MCP 传输 |
| 28 | UPSTREAM-PIG | 中 | PiG `mcp/streamable_http.go:580-624` | 上游只重放读侧，POST 不重发 |
| 29 | **OURS-GO** → 已修（E2E 待补） | 中 | `runtime_pig_recovery.go`；`pigkernel/recovery.go` `MarkRecoveryAttempt` | 启动恢复每 boot 重跑同一个 doomed call，冻结记录不清理 |
| 30 | ALREADY-OK | 低 | `core_task_runtime.go:4705-4776` | 唯一阻塞等待有 600s 上限且报 `timeout` |
| 31 | ALREADY-OK | 低 | `core_wake_ledger.go:119-121,153-156` | 并行审批合并为一个唤醒；节点状态守卫挡住第二次派发 |
| 32 | **OURS-GO** → 已修 | 中 | `runtime_provider_stream.go` `providerLineReader` | keepalive 不算活动；空闲计时器 5 分钟；上限触发后连接也被取消，回合真的被释放 |
| 33 | **OURS-GO** → 已修 | 中 | 同上 | 空闲守卫此前根本不存在；补上之后发现失败路径还会去读那个还在输出的 body，回合仍旧挂着 |
| 34 | **OURS-GO** → 已修 | 中 | `http_client.go:18`（`Timeout: 0`）→ 新读取边界 | 上游客户端此前没有读超时 |
| 35 | ALREADY-OK | 低 | `server_app.go:611-612`；`runtime_rsi.go:2012-2018` | daemon 只"请求"重启，决定权在桌面端 |
| 36 | ALREADY-OK（有残余，**已决定保持现状**） | 中 | `runtime_rsi.go:1352-1358`；ADR 0026 | 有真实代码闸门（请求方回合先结束）；残余：用户的确认仍是给模型的规则，不是代码检查，而 ADR 0026 把 `force` 定义为 agent 的工具。2026-10-23 决定：ADR 0026 不动，只把工具描述里的后果写清楚 |
| 37 | N/A | 低 | — | 本栈没有 span/trace 机制 |
| 38 | N/A | 低 | PiG `telemetry/memory.go:64-70` | Graph 不 import `PiG/telemetry` |
| 39 | ALREADY-OK（Graph 部分） | 中 | `pigkernel/provider.go` `restoreToolCallArguments`；`CONTEXT.md` 空参数工具调用 | 空参数调用已恢复为 `{}`；"null → no result"是上游 SDK 形状 |
| 40 | **OURS-GO** → 已修 | 高 | `pigkernel/session.go` `Compact`/`reportCompaction`；`pigkernel/provider.go` `bridgeRequestOptions` | 空结果被读成成功；摘要预算被丢；压缩事件从未翻译 |
| 41 | ALREADY-OK（本栈里不成立） | 中 | `agent/agent.go:747`；`core_node_executor.go:357`；`docs/agent/graph-v2.md:242` | 清单里的场景是"子 Agent 打到回合上限却报完成"：本栈没有回合上限（内核 `MaxTurns` 默认 0 = 不限，daemon 从不设置），那个场景不会发生；"没能回答"的回合本分支已按失败结算；节点声明了必需输出时由 `settleDeliverable` 核对，图也不因节点成功而隐式完成 |
| 42 | ALREADY-OK | 低 | `pigkernel/turn.go` `newRequestId`（16 字节随机） | Graph 的 id 不截断，不会一字符之差相撞 |
| 43 | ALREADY-OK | 低 | `core_access_policy.go:249-255`；`core_rule_engine.go:498-501` | 没有 deny 规则语言；畸形输入一律 fail closed |
| 44 | ALREADY-OK | 低 | `server_config.go:420` `configPositiveInt` | 未知模型被直接拒绝；连"配置了但没写 contextWindow"也会被配置校验拒绝（实测 `invalid_config: models.entries[0].contextWindow must be a positive integer`） |
| 45 | **OURS-GO** → 已修 | 高 | `runtime_controlled_openai.go` Anthropic 分支 | 全链路没有任何 `cache_control`，Anthropic 缓存从未建立 |
| 46 | **OURS-GO** → 已修 | 中 | `runtime_agent_tool_definitions.go`；`tests/e2e/harness-tool-schema.test.ts` | 实测 87.3% 的工具 schema 文本是散文：参数 schema 里已经写着的形状，描述里又写了一遍 |
| 47 | ALREADY-OK（机制不存在）+ 在姊妹分支处理 | 中 | `runtime_tool_results.go:406-482`（无调用者） | 2000 字符是上游"压缩输入"截断，不是淘汰阈值；daemon 侧的工具结果溢出路径由 `feature/harness-token-efficiency-2026-10-22` 的 `20a366c` 处理 |
| 48 | ALREADY-OK | 低 | `core_wake_ledger.go:106-117`；`runtime_agent_tool_definitions.go:224` | 有完成触发器（`get_task_status` 带 `waitForNode`），也没有 `sleep` 工具 |
| 49 | ALREADY-OK | 低 | 同 #48 | 状态轮询是使用方式，不是缺失的机制 |
| 50 | **OURS-GO** → 已修（部分） | 高 | `runtime_kernel_graph_lane.go:1010`；`runtime_pi_adapter.go:1276-1284` | 子 Agent 的思考档位被硬编码为 `off` |
| 51 | **OURS-GO** → 已修 | 高 | `runtime_pig_session.go` `pigSessionIdentity`；`pigkernel/turn.go` | 空 identity 让所有无实例会话共用一个注册名 |
| 52 | ALREADY-OK | 低 | `server_app.go:78-90`；`server_host.go:134-152` | 端口独占绑定，第二个 daemon 起不来 |
| 53 | **OURS-GO** → 已修 | 中 | `core_execution.go` `sweepState`；`core_state_retention.go` | 没有 trace 文件；残余：保留策略只在离线工具里跑，守护进程自己从不回收 |

---

## 3. 本轮修掉的十九条

### 3.1 #4 / #5 / #24 / #32 / #33 / #34 —— provider 流与请求（`c9fae98`）

daemon 自己拼 provider 请求、自己读 provider 的回答。两处判断是错的：

- **流结束与读失败同形。** 读循环遇到 transport 错误时直接 break，`finishReason` 缺省成 `"stop"`，于是"provider 在回答完成前断开"被当成一次成功回合。若断在半截工具调用上，参数被 `ParseStreamingJSON` 修复成 `{}`，工具就带着空参数执行了，而回合报成功。
- **失败没有变成失败。** daemon 只认 `stopReason == "error"`；内核把"没能回答"报成 unanswered submission（另一种 reason），于是一个什么都没产出的 operation 被结算成成功。

改法：流必须以其协议自己的终止标记结束（OpenAI 的 `[DONE]` 或 finish reason，Anthropic 的 `message_stop`）；provider 说完了怎么结束就信它，即便没发标记。参数没成 JSON 的工具调用让这次发送失败。内核报"没能回答"同样按失败结算，并把原因带进对话。

另外补了上游同款边界：读取有 5 分钟空闲上限，**keepalive 不算活动**（这正是 #32 说的缺陷），provider 不再回话时这次发送失败，而不是把回合、凭据槽和节点永久挂住。

**这条边界后来发现自己漏了一半。** 空闲上限确实触发了（读循环拿到超时，发送被判失败），但回合仍然挂在"运行中"：provider 停了话，连接却还开着，于是两处仍在等它——失败之后估用量要**把 body 读到末尾**（`io.ReadAll`），关闭 body 也要把剩下的排空。两处都等的是同一个还在说话的 provider，于是"provider 不再回话就释放回合"这件事没有真的发生。

补法：这次请求带一个可取消的上下文，读失败时先取消它（连接随即断掉，排空与读取都立刻返回），并且**不再从一个还在输出的 body 里估用量**——用量记为未知，走 daemon 既有的"用量未知"那套账。空闲上限也变成可配的（`GRAPH_PROVIDER_STREAM_IDLE_TIMEOUT`，默认仍是 5 分钟），这样"上限会触发"这件事能被端到端地证明，而不是只能等五分钟。

E2E `tests/e2e/harness-provider-idle.test.ts` 拿真实 daemon 与受控 provider 做两件事：一个 provider 只发 keepalive、不发任何事件，回合必须在上限之内失败并说清是 provider 停了；另一个 provider 每半秒发一个事件、整段回答比上限还长，回合必须成功——上限数的是事件，不是墙上的时间。修复前跑过：只发 keepalive 的那个把回合挂住，E2E 等到超时才失败。

### 3.2 #1 —— provider 收到的请求必须是 provider 接受的请求（`c9fae98`）

daemon 自己渲染 transcript，于是：assistant 的 tool call 没有配对的结果、结果没有配对的 call，两种都被 provider 拒绝。Anthropic 路径更糟——tool call 本身被丢掉，provider 看到的是"一个它从没被告知过的 call 的结果"，此后每个请求都带着这条断链。

改法按 Pi 在发请求前的做法：没有结果的 call 用 `No result provided` 补上，不配对的结果丢掉；Anthropic 的 assistant 回合带 `tool_use` 块、结果放在一个 `tool_result` 用户回合里。

### 3.3 #51 / #25 —— 每个会话有自己的身份（`65f9595`）

会话身份同时决定两件事：transcript 所在的 durable conversation，以及工具体注册用的 extension 名。daemon 两者都从 operation 的 instance id 派生，而没有实例的 operation 没有 instance id。

**空身份不是中性名字**：所有这类 operation 共用同一个 conversation 和同一个注册名。注册表按名安装、按名替换，于是最后打开的那个把先前会话仍然指向的工具体换掉了——后来的会话用前一个会话的工作区与策略执行工具，重启也修不好（durable 里存的是名字，注册表里存的是对象）。

改法：身份回落到 execution id；冻结记录记同一个身份，恢复的回合因此找回当初注册的 extension。CLI turn 路径那套写死的名字（`"graph-tools"`）也去掉了，现在只有一处派生注册名。

### 3.4 #23 / #40 / #9 —— 压缩要有 daemon 预留的那间屋子，并且如实上报（`f5f37dd`）

daemon 决定何时压缩、摘要写在哪间屋子里，这两件事都没到内核，内核跑的是自己的默认值（reserve 1024）：

- 摘要是被写进 reserve 的（内核用 `floor(0.8 × reserve)` 得出摘要自己的输出预算）。1024 的 reserve 意味着 819 token 的预算，而 daemon 的指令要求约 1500 token —— 摘要装不下自己被要求写的内容，写到一半被切断。
- 摘要请求还带着模型的整个输出上限，因为桥接把内核的每次请求选项丢在了地上。
- 什么都没压缩的压缩被报成压缩成功：内核用空结果完成这种任务，桥接读成成功，daemon 宣布"上下文已压缩"，而上下文一 token 没短。
- 压缩事件从未被翻译，daemon 侧的压缩处理是死代码，压缩失败完全不可见。

改法：daemon 的阈值在会话打开时按模型注册，内核按 agent 持有的模型引用解析策略；摘要请求带着内核给的预算；空结果被如实报成"无需压缩"；两个压缩事件被翻译，摘要从内核写入的 conversation 里读出来。

### 3.5 #50 —— 子 Agent 按它自己的模型该有的强度运行（`f5f37dd`）

每个子 Agent 都以 `thinkingLevel=off` 运行：图节点泳道把它写进 worker 配置，operation 路径在没有 conversation 可读档位时也用它——而节点本来就没有自己的 conversation。改后档位取该节点模型默认接受的档位，并按该模型支持的档位夹紧。

**未完成的部分（如实记录）**：daemon 决定的档位仍然没有上线——daemon 自己拼 provider 请求，没有放推理参数，而 Pi 把档位映射到各 provider 参数的规则有按 provider 分支的实现，Graph 尚未移植。这是这件事的下一段。

### 3.6 #14 —— 原生工具有上限，并说清自己丢了什么

`ls`、`find`、`grep` 原来没有上限：目录清单读遍每一项，文件搜索收集每一个匹配，内容搜索收下每一行，于是一个十万文件的目录变成十八兆的回答——runtime 之后每个回合都背着它，而那已经是一个装不进 provider 窗口的请求。

上限取上游 SDK 的：清单 500 项、文件搜索 1000 个匹配、内容搜索 100 个匹配、读文件 2000 行，每个回答 50KB。调用方可以要更多或更少，默认值是模型必须越过才能拿到的天花板。

上限是在**收集过程中**生效的，不是收集完再截：目录分批读，清单花的是上限的内存而不是目录的内存；文件搜索走到上限就停，不再走完整棵树再排序。

回答说清自己丢了什么、以及怎么看更多——一份被截断却看起来完整的回答比没有回答更糟：模型会以为自己已经看过那个目录。提示放在最前面，因为内核还会再截一次工具回答，截的是头部，填满预算的回答末尾的那句提示正是会没掉的部分。

E2E `tests/e2e/harness-native-tool-bounds.test.ts` 给 daemon 一个 1200 个文件的目录和一个 3000 行的文件，证明清单、搜索与读取各自在自己的上限内作答，并各自说清自己被截断了。修复前跑过：清单原样返回，没有任何东西说它不是完整的。

### 3.7 #53 —— 守护进程回收自己的状态（`b6352ec`）

回收规则本来就有，但只作为离线工具存在：它要拿 daemon 的 owner 锁，所以对着运行中的 Graph 拥有的状态它直接拒绝。于是跑了几天的 daemon 把自己写过的每一个事件都留着，而它之前每一次运行留下的状态就一直长下去。

daemon 现在用同一套规则回收：每个任务最新的事件留下，不足一天没有动静的任务的旧历史去掉，还在进行中的任务不动。回收在 daemon 启动时跑一次——上一次运行留下的状态在这一次写入之前就被回收——之后每小时一次。

删除走 store 自己的事务锁，所以不会和另一个写者交错：回收是在一个一直在写的 daemon 里面跑的。环境变量可以收紧规则（间隔、最小保留时间、每个任务保留多少事件），既是留给运维的口子，也是让一次运行就能看见回收的办法。

E2E `tests/e2e/harness-state-retention.test.ts` 跑一次对话，数出它的任务留下多少事件，重启 daemon 再数一次：第二次的数字是规则允许的数字。修复前跑过：daemon 把 17 个事件全留着。

### 3.8 #29 —— 每次启动都重跑同一个 doomed call 的启动恢复（`e98cc98`）

启动恢复会重发一个没有到达模型的回合。当这次重发不可能成功——它被受理时的配置已经不在了，或者它绑定的扩展无法承载——恢复失败，把原因写进 daemon 的错误流，然后返回。冻结记录还在，于是下一次启动做一模一样的尝试，再下一次也是。

尝试现在记在冻结记录里，而冻结记录正是恢复读的那个持久事实。一次尝试已经失败过的恢复不再重发：operation 保持 unknown，原因进事件流，daemon 说出来，而不是只往 stderr 里写一句。

既有的恢复 E2E（`pig-node-recovery`、`pig-durable-recovery`、`go-durable`）全部通过。新场景——一个被受理但从未发出的回合、它的恢复又不可能成功——还没有 E2E：它需要第二个对话占住凭据槽位，那个夹具还没搭起来。

### 3.9 #8 —— 补交额度是 node 的，不是 execution 的（`9c72c02c`）

契约是明确的（`docs/agent/graph-v2.md:190`）：节点声明 `retry:{automatic,resubmit}`，缺省是 2 次异常重试、1 次缺项补交；`docs/agent/issue-1-implementation-progress.md:20` 写着"重开数据库不刷新自动额度"。

执行器却按 execution 的计数器决定。execution 是短的——一次瞬时重试、一次续跑、一次重启——每一个新的都从零开始，于是用掉过一次补交额度的 node，每换一个 execution 就拿到一份新额度。那个为记住 node 的补交次数而写的持久计数器，被一个关掉了的护栏写进去，然后没有任何人读它。

决定现在读 node 的持久计数器，计数器也按 node 的额度计数——为它写的那个护栏这才算数。用掉额度的 node 会得到和别处一样的说法：额度用完了。而不是每次都拿到一份新的。

node 队列、node 提交与唤醒通知的 E2E 都通过。跨 execution 的情形还没有 E2E：它需要同一个 node 的第二个 execution，也就是一次生命周期层面的瞬时重试，夹具得精确地触发环境失败的分类。

### 3.10 #13 —— 被停的那一步不能在任务停掉之后写下自己的结论（`958eb145`）

停止会取消排队的工作，并等在途的 execution 收尾。而那一步是分两次写的：先写 execution，再写 node——所以一个 node 可以在它所属的任务已经停下之后写下"succeeded"或"failed"。停止按钮被它正在停的那一步盖掉了。

任务正在停止（或已经停下）时，它的 node 现在报的是停止本身：它被停放着，事件说明工作被取消。被取消的那一步没有资格在取消它的停止之上写一个结论。

E2E `tests/e2e/harness-stop-clobber.test.ts` 把一个 worker 的回合吊着，在 node 运行中停止 graph，然后才放开那个回合。node 报的是取消，不是它自己的失败。修复前跑过：它报的是 `failed`。

### 3.11 #45 —— Anthropic 显式缓存断点（`f5f37dd`）

daemon 自己拼 Anthropic 请求，全链路没有任何 `cache_control`：provider 从未被告知要保留什么，于是每个会话都为整段前缀重新付费。改后按 Pi 的做法在系统提示、最后一个工具声明、最后一条消息的最后一个块上各放一个断点。

### 3.12 清单之外：Go 主机的网络失败从来没被判成环境失败（`f2f44b5d`）

判定“这是环境的问题，不是代码的错”的正则写的是 Node 主机的话：`ECONNREFUSED`、`ENOTFOUND`、`socket hang up`、`ETIMEDOUT`。Go 主机说的是 `connection refused`、`no such host`、`connection reset by peer`、`i/o timeout`——一条都不匹配。于是 Go 侧没有任何一次网络失败被判成环境失败，harness 自己承诺的两次自动重试一次都没跑过：node 被交给了 main，而不是被重试。

正则现在同时认这两种说法，并加上 provider 侧的 `429` 与 `5xx`。分类集中在 `core_environment_failure.go` 一处，下游的重试与可观测性都读它。

这一条没有专属的 E2E：它要证明的是“重试真的会跑”，而重试路径本身还没通（见摘要第 3 条：重新入队的那一版已经撤回）。所以它的证明要等重试路径的顺序问题定下来之后才写得出来——在那之前，能说的只是分类这一层是对的。

### 3.13 #46 —— 工具 schema 里的散文

每个工具的描述，模型在每一次请求里都要读一遍，而请求是一次又一次发的。在一个真实会话发出去的那个请求上量：38 个工具，描述 10,098 字符，参数 schema 8,521 字符——散文是 schema 里的多数，而这份 schema 待在每个请求的缓存前缀里。

散文的来源有两个。一个是**参数 schema 里已经写着的东西，描述里又写了一遍**：propose_graph 收的那个提案对象，形状在描述里写了一遍、在 schema 里写了一遍；apply_rsi_change 的四种改动动作，描述里写了一遍、schema 里写了一遍；artifact_publish 的参数名在散文里被点名了一遍。另一个是**为什么这么做**的解释，和会防止误用的规则混在一起。

改法：每条描述压成操作说明；形状已经在 schema 里的不再重复；会防止误用的规则留着（发布只能给内容或路径其一、确认必须用户明说、git 只读、图提案指向 graph-v2.md）；长协议指向文档，不再复述。

同一个请求上的描述从 10,098 字符降到 6,969 字符（−31%），参数侧一字未动。schema 不再是散文占多数：描述 45%、参数 55%（此前是 54% / 46%）。

E2E `tests/e2e/harness-tool-schema.test.ts` 拿真实 daemon 与受控 provider，量的是 provider 真正收到的那个 schema：描述总量有上限、描述不比参数 schema 长、每个工具都说得出自己是干什么的，以及四条规则仍在。修复前跑过：描述 10,098 字符，比参数 schema 还长。

---

## 4. E2E 证据

只写真正的 E2E：真实 daemon 二进制、真实 SQLite 状态库、真实工具体，只有外部 provider 被脚本化替代。

| 文件 | 证明什么 | 修复前 |
|---|---|---|
| `tests/e2e/harness-tool-flow.test.ts` | provider 在回答完成前断开时，这一回合失败，那个工具没有执行；Anthropic 请求带着 tool call 与配对的结果；请求带着缓存断点 | 断开的那一回合报成功并执行了工具；Anthropic 请求里没有 tool call |
| `tests/e2e/harness-compaction.test.ts` | 摘要是按 daemon 预留的 2000 token 房间请求的（1600），不是模型的整个输出上限；压缩被如实上报为 `session.compacted` | 摘要请求 4096 token；没有任何压缩上报 |
| `tests/e2e/harness-native-tool-bounds.test.ts` | 清单、文件搜索与读取各自在自己的上限内作答，并各自说清自己被截断了 | 清单原样返回 1200 项，没有任何东西说它不是完整的 |
| `tests/e2e/harness-state-retention.test.ts` | daemon 回收上一次运行留下的状态：重启后任务留下的事件不超过规则允许的数量 | daemon 把 17 个事件全留着 |
| `tests/e2e/harness-stop-clobber.test.ts` | 被停的那一步在任务停掉之后不写自己的结论：node 报的是取消 | node 报 `failed`——它自己的结论盖掉了停止 |
| `tests/e2e/harness-provider-idle.test.ts` | provider 只发 keepalive 时回合在上限之内失败（而不是把回合挂住）；provider 持续发事件时不会被上限误杀 | 只发 keepalive 的 provider 把回合挂住，E2E 等到超时 |
| `tests/e2e/harness-tool-schema.test.ts` | provider 收到的工具 schema 不是散文占多数：描述比参数 schema 短、总量有上限；四条防止误用的规则仍在（发布只能给内容或路径其一、确认必须用户明说、git 只读、图提案指向文档） | 描述 10,098 字符（基线 backend 上 9,860），比参数 schema（8,521）还长 |

这七个文件都在修复前跑过，确认失败。

---

## 4.1 验证状态

分支在 2026-10-23 16:06 跑过一次完整检查，全绿：292 个测试文件、1556 个测试、退出码 0。此后本分支又补了 #8 的补交额度修复、环境失败的分类（`f2f44b5d`）、#46 的工具 schema 压缩，以及重试路径的两轮尝试（两轮都已撤回，见摘要第 3 条）。

受影响的测试文件最近合跑过：#46 之后跑过 6 个文件 23 个测试（工具 schema、工具流、提案形状、产物发布、上下文装配、生产链路），全绿；再早一轮是 12 个文件 20 个测试全绿（五个新写的 E2E，加上 node 队列、node 提交、唤醒通知、节点泳道与三支恢复 E2E）。

之后再跑的全量有 96 个失败（34 个文件），失败的样子是进程起不来：`dyld: Library not loaded: @rpath/libnode.147.dylib`、临时文件 ENOENT、节点停在 `blocked` 而不是 `completed`。这一轮**做过对照**：把 backend 换回本分支提交前的版本，失败集合一模一样（37/37 同名）；再换回基线 `9aed752` 的 backend，失败集合仍然一模一样（37/37 同名）。也就是说这不是本分支引入的回归，是这台机器当下的环境（几个 worktree 同时在跑套件）造成的。

#32/#33/#34 的收尾（provider 不再回话时真的释放回合）之后又跑了一次全量：**失败的 34 个文件与上一次逐个同名，没有新增，也没有消失**——那一轮新增的 provider 空闲上限 E2E 也在里面并且通过。

更早几次全量被环境挡住，原因同样与本分支无关：

- `tests/e2e/pig-kernel-update.test.ts`：上游 PiG 在这段时间里发布了 v0.5.3（此前是 v0.5.2），仓库钉的是 v0.5.1，"钉住的是最新版"这条断言因此失败；该测试还会去拉新版本并构建。
- `tests/m4/acceptance.test.ts`：把本分支的 backend 换成基线版本后同样失败（"a native Git work-check graph without an independent reviewer cannot deliver"），是既有失败。
- `tests/console/git-baseline.test.ts` 与 `tests/m7/harness.test.ts`：在机器同时跑着好几个 worktree 的套件时不稳定；同样这三个文件在基线与本分支上跑出的失败集合完全一致。

换句话说：本分支没有引入回归，但"全绿"这句话只有 16:06 那一次是完整跑出来的。

---

## 5. 确认为真实但本轮未修的（逐条记录）

这些是 Graph 自己的缺陷，但改动面比本轮大，或需要与正在进行的其它工作协调。每条给出机制与修复位置。

| # | 机制 | 修复位置 |
|---|---|---|
| 36 | 用户的确认仍然只是给模型的规则，不是代码检查：模型可以在别的 operation 还在跑时 `force` 重载 daemon。ADR 0026 把 `force` 定义为 agent 的工具（"force 保留中断在途 operation 的原有语义"），所以收紧它是 ADR 决策，不是实现细节。工具的描述已写明这个后果与"先问用户" | **2026-10-23 已决定：保持现状**。ADR 0026 不动，工具描述里写明后果（`force reloads even while other operations run, so ask the user before you use it: a forced reload interrupts the work still in flight`）。要改成可查证的确认（谁问、谁答、记在哪）时，那是另一次 ADR 决定 |
| 18 | 遗留 TS 路径整读会话文件（10MB）并在事件循环上同步解析 | `src/core/node-prompt.ts` 改增量读；`src/runtime/durable-history.ts` 不再复制整份 records。`feature/retire-ts-backend` 正在退役这条路径，可能不必再改 |

另有四条不再属于这一类：

- **#14 已经修掉**：原生工具有上限，并说清自己丢了什么（见 3.6）；**#46 也已经修掉**：工具 schema 的描述压成操作说明（见 3.13）。这两条原先列在这里，现已不是未修项。
- **#41 在本栈里不成立，改判 ALREADY-OK**：清单里的场景是"子 Agent 打到回合上限却报完成"，而本栈没有回合上限（内核 `MaxTurns` 默认 0 = 不限，daemon 从不设置），所以它不会发生。"没能回答"的回合本分支已按失败结算；节点声明了必需输出时由 `settleDeliverable` 核对，节点成功也不等于图完成（`docs/agent/graph-v2.md:242`）。改过一轮又退了（`0c9b3a9e` → `5222d84d`）：那个改动让空回合的节点迟迟不落到终态——发一个可能把节点挂住的改动比留着这个缺陷更糟。残余只有一条很窄的：回合成功结束但没有内容，而节点又没有声明必需输出。契约把必需输出写在节点的 `submission` 里，没声明就没有可缺的东西。
- **#22 在本栈里不成立，改判 ALREADY-OK**：`message.tool` 的起止各写一条事件（每回合几条，不是每 token），delta 的写入被 60ms 合并成一次 upsert（`runtime_pi_adapter.go:1329`），活动行只写变化过的那几条（`core_conversation.go:419-422`），事件表又由本分支的回收扫描（#53）按每个任务 200 条封顶。剩下的"每 token 一次"只是内核交给 daemon 的一次内存事件交接，而 Graph 根本没有 import PiG 的 telemetry 包，也就是说清单里说的 span 在这个栈里不存在。无需改：写放大已经被合并与回收两条路堵住了。
- **#47 交给姊妹分支**：daemon 侧设计好的 4KB 溢出/摘要路径（`ToolResultHook`）在 Go 路径上没有调用者，工具结果只有上游 50KB 兜底；由 `feature/harness-token-efficiency-2026-10-22` 的 `20a366c` 处理（`pigkernel/extensions.go` 注册工具时挂上 `ToolResultHook`）。

---

## 6. 与 `feature/harness-token-efficiency-2026-10-22` 的重叠

该分支尚未合入 `main`，本分支按 `main` 基线独立推进。重叠如下，合并时需要人工取舍：

| 清单条目 | token-efficiency 分支上的状态 | 本分支 |
|---|---|---|
| #23 压缩阈值没到内核 | `ff7b6da` 让环境变量命名上下文上限 | 本分支按模型注册 daemon 的压缩阈值（同一根因，另一条路） |
| #40 摘要预算被丢 | `129da7e` 给摘要它自己要的空间 | 本分支经 `bridgeRequestOptions` 传内核的每次请求预算 |
| #45 Anthropic 缓存断点 | `e18a65b` 在 Anthropic 传输上标记可缓存前缀 | 本分支在系统提示/最后工具/最后消息放断点 |
| #9 压缩事件到不了 daemon | 未覆盖 | 本分支翻译两个压缩事件 |

两边改的是同一段代码的不同位置（`runtime_controlled_openai.go`、`pigkernel/provider.go`、`pigkernel/session.go`），合并时会冲突，建议先合其中一支。

---

## 7. 上游（PiG v0.5.1）需要知道的事

这些不是 Graph 能改的，按上游文件分组：

- **`durable/harness/compaction.go`** —— `completeCompaction` 用"完成 + 空结果"表示"什么都没压缩"，与真的压缩无法区分；`CompactionEndEvent` 只有 `{taskId, reason, error}`，没有 summary、tokensBefore、estimatedTokensAfter（daemon 读的正是缺的这些）。
- **`durable/harness/agent.go`** —— `selectExtensions` 把无法解析的 extension 名**静默丢掉**，既不报错也不记事件。Graph 侧因此出现过"模型被承诺了工具却拿不到"。
- **`durable/harness/generation.go`** —— assistant 条目在工具结果之前提交，`ConvertPartial` 只把流式 partial 转成 aborted 条目，已提交的 assistant 条目会带着没有结果的 tool call 留在 transcript 里。
- **`coding/extension/host/subprocess`** —— `Host.Load` 必须在返回前保证扩展的工具注册可见。
- **`mcp/streamable_http.go`** —— 响应流断开后只重放读侧，POSTed 的请求不重发；重连有上限但仍会打断在途调用。
- **`ai/` provider 层** —— 其余 provider 的"连接关闭即结束"与"缓存 token 重复计费"在这里，Graph 只讲两种协议，无法代为修。

Graph 侧的缓解：把 `MCP response stream failed` 当作可重试的环境失败（`core_environment_failure.go` 已分类 `ECONNRESET`），并在桥接层给在途调用补一次幂等重试。

---

## 8. 分支基线与新的文件大小闸门

本分支的基线是 `main` 的 `9aed752`，也就是本轮开始时 `main` 的位置；`feature/harness-token-efficiency-2026-10-22`、`feature/architecture-deepening`、`chore/comment-prune-2026-10-22` 与本分支同基线。本轮进行中 `main` 前进了两个提交（harness2 方法融合，以及新增的"单文件不得超过 5,000 令牌"提交前闸门 `03d6af2`）。

新的闸门按暂存 blob 量每个文件。本轮改动对它的关系：

- `backend/internal/pigkernel/session.go` 原本 16,644 字节，本轮的压缩代码把它推到 20,997 字节（越过 20,000 字节的线）。压缩代码因此拆到新的 `backend/internal/pigkernel/compaction.go`，该文件回到 17,026 字节。
- `backend/internal/graph/runtime_agent_tool_definitions.go` 原本 41,230 字节，一个文件里装着全部 48 个工具声明。#46 把描述压短之后（36,068 字节）仍然越线，于是按域拆成五个文件：定义与 schema 助手（`runtime_agent_tool_definitions.go`，6,696 字节）、图（`runtime_agent_tool_graph.go`）、草稿与人工检查（`runtime_agent_tool_drafts.go`）、产物与工作区（`runtime_agent_tool_artifacts.go`）、会话与系统面（`runtime_agent_tool_sessions.go`），每个都在 10KB 以内。声明的顺序变了（provider 收到的工具顺序随之变），语义没变。
- `backend/internal/graph/runtime_controlled_openai.go`（47,852 字节）、`runtime_pi_adapter.go`（98,514 字节）、`runtime_kernel_graph_lane.go`（69,678 字节）在本轮之前就已经远超预算。本轮把读取 provider 流的部分拆到新的 `runtime_provider_stream.go`，`runtime_controlled_openai.go` 反而小了 2.3KB；但闸门量的是整个文件，所以合并这个分支仍需要人来决定：拆分这三份文件（正在进行中的 comment-prune 工作），或按闸门文档里的 `// graph:allow-large-file: <理由>` 在文件顶部说明。

这三条文件在本轮之前就已越界，本轮没有让它们更糟；但闸门是新的，所以合并会被它挡住，这一点记录在此。
