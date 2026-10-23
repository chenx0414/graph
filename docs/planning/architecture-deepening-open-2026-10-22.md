# 架构深化查出来、尚未处理的问题（2026-10-22）

配套文档：[架构深化计划与证据](architecture-deepening-2026-10-22.md)——那里记着已经落地并有证据的部分。

下面每一条都是**这一轮查出来、但刻意没有改**的问题。改动它们要么需要一次产品决定，要么需要一份能证明它的 E2E，而这两样都不是结构整理该顺手做的。

## 过程中查出来、**尚未处理**的问题

1. **系统自模型在 Go daemon 里没有接线**。`GraphServerOptions.SystemContext` 从来没有被设过，因此 `read_system_capabilities`、`inspect_graph_system`、`propose_system_change`、`apply_system_change` 这四个工具对主 Agent 一直不可用。TypeScript 宿主是接了的（`src/server/start.ts:407` 传 `{ systemSummary }`），Go 端口迁移时漏掉。CONTEXT.md 的**系统自模型**把这项列为产品能力，所以这是一个功能缺口，不是设计取舍。补它需要一份 Go 侧的主机清单，属于功能实现而不是结构整理。

2. **节点的"在途占用"记在两个账上**。`kernel_node_state.reserved` 记的是执行器按轮持有的预留，`kernel_provider_calls.reserved` 记的是每次 provider 调用持有的预留。`ReserveNodeTokens` 比预算时只看前者，provider 闸门比预算时只看后者，**两边都没把对方算进来**——一个节点因此可以持有超过预算的量。哪个账本算数是产品决定（收紧额度会让此前能跑完的节点开始被拦），所以本轮只把写入路径统一了，没有动判定。

3. **嵌套事务会死锁，而 `TaskStore.Transaction` 的注释说它会 join**。实现先拿事务锁再看深度，所以从另一个事务里再开一个事务会等一把外层正持有的锁，host 就停在那里。用真实 store 跑的一次探针证实了这一点（探针已删除）。注释现在改成写实际行为，并写明：要在别人事务里跑的 store 方法不该自己开事务（单条语句本身就是原子的），需要多条语句的方法按仓库既有的 `InCurrentTransaction` 命名，让调用方持有事务。**这是下一条候选（把运行时层的裸 SQL 收进 KernelStore）的前置条件**——那些 store 方法会从运行时自己的事务里被调用。

4. **冻结策略存了 15 个字段，恢复只还原 8 个**。`FrozenExecutionPolicy` 记下工作副本、状态目录、skills、扩展、读写根、保护路径、文件系统可达范围、原生工具、可调工具、能力/工具/运行时策略摘要与思考档位共 15 项，而恢复只读回其中 8 项：文件系统可达范围、原生工具、可调工具、三个策略摘要与思考档位都**没有**被还原。因此一次被重新发出的回合，用的是**此刻**的文件系统可达范围、此刻的工具清单、此刻的策略摘要与此刻的思考档位。CONTEXT.md 的**冻结执行**明写"记录该次执行用的模型、指令、工具与策略"，并把"用目录里此刻的配置重发已受理的输入"列为禁止——记录里存着这些事实，恢复没有读回来。

   - **这一轮把参照实现找出来了，于是缺口有了规格**。TypeScript 原件 `src/runtime/durable-session.ts:35` 在恢复时把**整份冻结策略**盖回请求上：`workspace`、`stateDir`、`binding`、`nativeTools`、`allowedToolNames`、`piExtensionTools`、`skillPaths`、`skillFolder`、`piExtensionPaths`、`readRoots`、`writeRoots`、`protectedPaths`、`readOnly`、`filesystemAccess`、`allowGitMetadataWritesAll`、`networkDomains`、`allowUnrestrictedNetwork`、`allowLocalBinding`、`unixSockets`、`allowAllUnixSockets`、`allowAppleEvents`，外加三个延迟工具的标志。Go 端口还冻了原件没有的三个摘要与思考档位，却只还原了那八个。
   - **两条恢复路径的差别也不同**。**节点泳道**把解算好的**访问策略**从冻结记录里取回来（`runtime_kernel_graph_lane_node.go` 的 `nodeAccess` 读 `Record.Configuration.ExecutionConfiguration["access"]`），把模型也从冻结记录里取回来——所以节点的可达范围与模型**是**冻住的。**主 Agent 会话**（`runtime_pi_adapter_turn.go:167` 起的还原块）只还原了那八个：读写根是冻住的，但**访问策略本身**取自此刻的配置。因此缺口集中在主 Agent 会话这一侧。
   - **还有一个 Go 端口特有的事实**：`request.FilesystemAccess` 在 Go daemon 里被赋值、被冻进记录，但**没有任何地方读它**——真正的强制走的是 `runner.access`（访问策略）与读写根（`runtime_restricted_run.go:44`）。所以"文件系统可达范围没有被还原"这句话在 Go 侧的实际后果，是**访问策略取自此刻**，而不是那个字段本身。
   - **七个没被还原的字段里，只有一部分在 Go daemon 里真的活着**。逐个查过读点：`request.AllowedToolNames` 在 `runtime_pig_extensions.go:60` 被读（它决定这个会话能看到哪些 Pi 扩展工具），`request.ThinkingLevel` 在 `runtime_pig_session.go:107` 被读（会话的思考档位），三个摘要在 `runtime_pig_session.go:327` 起被读（会话的 inspect 记录，即给控制台看的那份）。而 `request.NativeTools` 与 `request.FilesystemAccess` **在 Go 侧没有任何读点**——它们被赋值、被冻进记录，然后就没有然后了。因此真正要修的是**三个**：可调工具、思考档位与三个摘要；另两个是 Go 端口搬过来却没接上的死字段。
   - **要补上，需要先决定补多少**：还原 Go 已冻的那七个字段（`nativeTools`、`allowedToolNames`、`filesystemAccess`、三个摘要、`thinkingLevel`）不需要改持久格式；而把原件有、Go 的策略类型里根本没有的那几个（网络域、本地绑定、unix socket、apple event、只读、三个延迟工具标志）补齐，就要给冻结记录**加字段**——那是一次持久格式的扩展，尽管对旧记录是向后兼容的。
   - **仍然缺一份能证明它的 E2E**。能写出来的形状已经清楚：两个会话，第一个的主 Agent 占着凭据槽不放，第二个的主 Agent 因此被受理但从未发出——此时记录已冻结（`transport.Open` 先开会话、**后**冻记录，`runtime_pig_session.go:52` 与 `:65`）；杀掉守护进程、改配置、重启，第二个主 Agent 被重新发出，断言它带的是**冻结时**的那一套。写出来需要一个两会话的 E2E 夹具（现有的 `tests/e2e/pig-node-recovery.test.ts` 只覆盖节点那一侧，而节点那一侧本来就是冻住的）。
   - **注意这份 E2E 只能与修复一起进**：它断言的是**应当如此**的行为，在现状下会失败，而门禁必须一直是绿的。所以这一件要么整件做（E2E + 修复 + 一次行为变更），要么整件不做——这正是它需要一次决定而不是一次整理的原因。补上是修一个功能缺陷，但它改变恢复路径的行为，因此本轮只写在这里。

5. **泳道的 "Frozen node identity mismatch" 拒绝是空转的**。内核把冻结身份直接从它存的那份记录里读出来（`recordString(record, "identity")`），所以旧代码拿 `configuration.policy.binding.instanceId` 与 `snapshot.identity` 比的是同一个字段的两个副本，永远相等。现在类型化之后比较的是 `wrapper.Identity` 与 `wrapper.Record.Identity`——仍然是同一个值，但至少不再伪装成两个独立事实。要让它有意义，得拿记录里的身份与**执行那一行**所属的实例比；那是新加的判定，会改变恢复的行为，同样没有 E2E 能证明，因此没有加。

6. **提交守卫的实现比它自己的说明严**。守卫按**暂存的 blob** 量大小，因此任何一次改动只要碰到一个超过 20,000 字节的文件就被拦下——尽管说明写的是"仓库里已存在历史大文件，而它要拦的是**本次改动**新写大文件"。实现与说明的这一处出入，曾经让运行时层完全无法改动。上面第七步把两个历史大文件拆开后，这一处就不再挡路；但守卫本身仍会把任何历史大文件挡在门外，而它并没有实现说明里许诺的那份豁免。
   - **量过一遍之后，这件事比原先记的更大**：`backend/internal/graph` 这个包里**有 27 个文件超过 20,000 字节的上限**——`core_task_runtime.go` 197KB、`server_app.go` 96KB、`runtime_agent_tools.go` 62KB、`core_operation_lifecycle.go` 60KB 往下排。**它们一个都没有 `graph:allow-large-file` 标注**，所以今天改动这 27 个文件里的任何一个，守卫都会拦下来，除非像本分支前几次那样用 `--no-verify` 并在提交信息里说明。
   - **本分支已经把 33 个里的 29 个拆掉了**（能力、用量、自改进、Agent 提示词库、受控 provider、对话、任务运行时、HTTP 层、operation 生命周期、受限进程、store、execution、artifact 工作区、interface spec、助手流、节点运行、git 集成、daemon 启动、Pi 扩展、能力库、git、provider、配置、图运行时、布局、harness 探针、文件能力、图服务、Agent 上下文装配、模块运行时），每一个都是纯搬移并且逐字节证明过。**拆开一个文件是把问题消掉，而不是为它求一次例外**——这二十九次提交守卫都正常跑过了，一次 `--no-verify` 都没用。
   - **剩下的四个，各有各的理由，而且理由写在文件自己的头上**（用的是仓库自己的 `graph:allow-large-file` 标注，形式见 `docs/agents/checks.md`）：`core_pinyin_table.go` 是一张拼音表（每个字一行），`runtime_agent_tool_definitions.go` 是一张工具 schema 表（每个工具一条声明），`server_start_daemon.go` 的全部内容是一个 585 行的启动函数（它的闭包互相捕获，拆它是一次重写而不是一次搬移）。**第四个是有意留下的**：`runtime_agent_tools.go` 的 1,033 行全在一个 `AgentTools` 函数里，它造的就是那张工具表——**那张表大到没人能拿两份来比**，这大概就是主会话与节点泳道两份工具表各自漂移开的原因；它要等 id、遥测、panic 三处分歧定下来才能动。
   - **结果**：包里超过上限的文件从 33 个降到 4 个，其中三个带着写明理由的标注；**其余每一个要么低于上限、要么在文件头说明了自己为什么不是**。
   - **该怎么处理，是一个决定而不是一次整理**：把这些文件按职责拆开是安全的，但要拆函数的那几个（工具表）要先定 id、遥测、panic 三处分歧；数据文件则需要守卫承认"文件的大小不一定来自职责"。另一个办法是让守卫真的实现它说明里许诺的那份豁免——只拦本次改动新写的大文件——那是改守卫本身，等于改一条 ADR 写下的规矩。本轮两件都没做。

7. **两条路的工具准入规则本来是一份，被端口分成两份**。`pigToolSpecs`（主会话）与 `pigNodeToolSpecs`（节点泳道）各自建同一张工具表，而它们的差别不是设计出来的：主会话的工具表来自 `e84a8cd`，节点泳道的来自 `1435277e`，是 TypeScript 那一版逻辑的两次独立移植。TypeScript 原件只有一种机制（`src/runtime/tool-gating.ts` 的 `externallyGated` 标记，工具自己说"我已经在效果边界上过了闸门"），执行时的闸门也只有一处（`src/runtime/durable-tools.ts:166`）：外部闸门的工具直接执行，其余走 `broker.dispatch(id, 0, ...)`，**同一个 id** 既给 broker 也给工具，执行完在 `finally` 里 settle，并记一次工具调用遥测。

   - **这一轮把那张表拆开了，于是这三处分歧第一次能并排看**（`AgentTools` 那 1,033 行的函数拆成十二个文件，全部是纯搬移，54 个 handler 的函数体逐字节未变）。原件在 `src/runtime/durable-tools.ts:160-172`：

   | | TypeScript 原件 | Go 主会话 | Go 节点泳道 | 证据指向 |
   | --- | --- | --- | --- | --- |
   | **id** | 同一个 id 既给 broker 也给工具 | **两个 id**：`piWorkerGatedTool` 给 broker 一个 `graphUUID()`，给工具另一个 | 同一个 id ✓ | 应为**一个**：gate 的 id 记进 `invocations`（额度账本按它结算），工具的 id 记进写入账本的 `ToolCallID`——两个 id 就没法把额度记录与写入记录对起来 |
   | **遥测** | 每次调用都记，在 `finally` 里，panic 也记 | 记，但 **panic 时不记**（记在 `gated(...)` 返回之后） | **完全不记** | 应为**每次都记**，panic 也记 |
   | **panic** | 重新抛出 | 重新抛出——但 `PrepareArguments` 的 panic 逃出去 | 转成错误值 | Go daemon 自己的哲学是**转成错误值**（工具表里写着"the host turns that refusal into the tool error the model reads, instead of losing the turn"）。`PrepareToolArguments` 确实会 panic（参数不合法时 `panic(errors.New(problem))`，`runtime_pi_worker_config.go:102`），而它在 `Execute` 之外跑——所以**主会话是那个不一致的一方**，节点泳道才与 Go daemon 自己的哲学一致 |
   | **外部闸门** | 只看 `externallyGated` 标记 | 只看标记 ✓ | 标记 + 一份名字清单 | 节点泳道的 `submit` 是 `PiWorkerTool`（`runtime_pi_worker_config.go:14`），**那个类型根本没有 `ExternallyGated` 字段**——名字清单不是重复标记，而是那种类型里唯一能说这件事的办法 |

   - **先前记的一处是错的，这里更正**："`submit` 本来就带着 `ExternallyGated` 标记，等于同一件事记了两遍"——**不成立**。`submit` 由 `kernelGraphLaneSubmitTool()` 造，是 `PiWorkerTool`，不是 `AgentToolDeclaration`；它没有那个标记，因此那份名字清单不是重复。
   - **所以要定的其实是三件事，都很窄**：主会话的 id 收成一个（与节点泳道、与原件一致）；节点泳道补上遥测（与原件一致）；主会话在 `PrepareArguments` 的 panic 上与节点泳道一致（转成错误值）。三件都只动一次工具调用的准入与结算，不动工具表本身。牵涉每一次工具调用的准入与额度结算，因此本轮只做到拆表那一步，合成那一步连同它要回答的问题一起写在这里。

8. **E2E 门禁横跨两套实现**：64 个 E2E 文件里有 27 个仍然驱动已经退役的 TypeScript 守护进程，产品跑的是 Go daemon，门禁因此没有覆盖出厂执行路径。ADR 0033 明写"TypeScript 守护进程本身保留……退役它属于另一件事，本决策不夹带"，所以这件事需要单独一条 ADR，本轮按约定不碰。

## `tasks` 表与任务闸门的归属缺口已经补上

kernel 层的表与 `tasks` 表现在都有 owner 了。`tasks` 的生命周期（phase、paused）原先由 12 个文件里的 34 处自己写，phase 的词汇散在十六个地方而不是一处；它的五种创建方式（一个 graph、一个对话下的 graph、一次主管回合、一个对话锚定的 task、一个已确认提案的 task）也各自写着 SQL。现在这些全是 store 的方法，创建的方法名说的是"创建什么"而不是"有哪些列"，<span>core_task_lifecycle.go</span> 是这张表唯一的写入口。

任务闸门也不再自己写 SQL。它读的 `operations`、`questions`、`invocations` 三张表的形状原本有两个地方知道：拥有它们的 store，和并不拥有它们的闸门。现在 <span>core_task_invocations.go</span> 回答闸门问的每一个问题，闸门里一条 SQL 都没有了。

**kernel 表现在也只由 store 抵达**。工具闸门（第十五步之前）、节点泳道的读与写（第十五步之前）都各自写着 SQL 问这些表；现在它们问 store，store 之外只有两个文件还写着 kernel 表的名字：

- **harness 的探针与证据**（`runtime_harness_probe.go`、`runtime_harness_evidence.go`）。它们读很多表来汇报一个图——节点、执行、队列、条目、提问、事件、provider 调用——是一个诊断面而不是一个决策面。它要读的那些表分属不同的 store，因此它天然横跨多份 store，而不是绕过它们。
- **执行名额**（`runtime_execution_slots.go`）。它把旧的 `operations` 表与新的 `kernel_executions` 表一起数，是**跨两份 store 的事实**，因此留在那个模块里是合理的。

剩下的同类已经补上了：`invocations` 与 `questions` 这两张表原先各有多个写入口——闸门这一侧已收进 store，operation 生命周期自己写一次调用的 usage 与 cost，`questions` 表更是由 7 个文件写了 14 遍"回答一个问题"、6 种谓词。现在 <span>core_task_questions.go</span> 是这张表唯一的写入口，七条规则各按"它答什么"命名；`invocations` 那一个写入口也走了 store。store 之外只剩两处 **schema 迁移**（退役时删掉已退役 operation 的 invocations、把问题归属从 user 移到 main Agent 的那次迁移）——迁移的 SQL 应该在迁移里。

**到这一步，运行时层与内核层写过的表都有 owner 了**：`tasks`、`questions`、`invocations` 归 task store，`kernel_*` 归 kernel store。剩下的是**读**的归属问题：这些表仍被十来处直接读（harness 的诊断面、预算账本、节点执行器、pi adapter 等），读不写，因此不构成"谁拥有这张表"的争议，但一个列的含义若要改，仍要找许多处。
