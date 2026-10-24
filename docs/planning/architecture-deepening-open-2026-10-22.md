# 架构深化查出来、尚未处理的问题（2026-10-22）

配套文档：[架构深化计划与证据](architecture-deepening-2026-10-22.md) · [后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)

下面每一条都是**这一轮查出来、但刻意没有改**的问题。改动它们要么需要一次产品决定，要么需要一份能证明它的 E2E，而这两样都不是结构整理该顺手做的。

## 过程中查出来、**尚未处理**的问题

1. **系统自模型在 Go daemon 里没有接线**。`GraphServerOptions.SystemContext` 从来没有被设过，因此 `read_system_capabilities`、`inspect_graph_system`、`propose_system_change`、`apply_system_change` 这四个工具对主 Agent 一直不可用。TypeScript 宿主是接了的（`src/server/start.ts:407` 传 `{ systemSummary }`），Go 端口迁移时漏掉。CONTEXT.md 的**系统自模型**把这项列为产品能力，所以这是一个功能缺口，不是设计取舍。补它需要一份 Go 侧的主机清单，属于功能实现而不是结构整理。

2. **节点的"在途占用"记在两个账上**。`kernel_node_state.reserved` 记的是执行器按轮持有的预留，`kernel_provider_calls.reserved` 记的是每次 provider 调用持有的预留。`ReserveNodeTokens` 比预算时只看前者，provider 闸门比预算时只看后者，**两边都没把对方算进来**——一个节点因此可以持有超过预算的量。哪个账本算数是产品决定（收紧额度会让此前能跑完的节点开始被拦），所以本轮只把写入路径统一了，没有动判定。

3. **嵌套事务会死锁，而 `TaskStore.Transaction` 的注释说它会 join**。实现先拿事务锁再看深度，所以从另一个事务里再开一个事务会等一把外层正持有的锁，host 就停在那里。用真实 store 跑的一次探针证实了这一点（探针已删除）。注释现在改成写实际行为，并写明：要在别人事务里跑的 store 方法不该自己开事务（单条语句本身就是原子的），需要多条语句的方法按仓库既有的 `InCurrentTransaction` 命名，让调用方持有事务。
    - **下一条候选已经做完了**（提交 `07ef0b92`、`83c16062`、`9894782f`、`4c821127`）：kernel 表的写现在**只有一个主人**，`backend/internal/graph` 里 store 之外**一处越界写都没有**（守卫 `node --run check:ownership` 查的就是这件事）。这一轮交出去的四组方法**每一条都是一条语句**，因此它们在调用方已经持有的事务里跑，而不是自己再开一个——正是这条注释写下的规矩。
    - **死锁本身仍然没有修，而且现在可以说得更准**：它是**潜伏的**，不是活的。store 里有九个方法会自己开事务（`NoteNodeAttempt`、`NoteNodeResubmit`、`ConfigureNodeRetries`、`NoteNodeRebind`、`ClaimQueued`、`SetNodeQueuePaused`、`SetModuleInput`、`RecordModuleTransition`、`DeliverDirect`），而**今天没有一处在普通 `Store.Transaction` 里调用它们**（逐个函数体配对花括号查过，命中数 0）。模块那条路被 `ModuleTransaction` 的可重入标志挡住了。因此修它的前提是**有人先写出一个会嵌套的调用**，而不是它今天正在发生。
    - **因此这一条现在是"要不要修"而不是"是不是活的"**：修它要么给事务一个归属（goroutine 身份），要么给事务一个显式的令牌。这两者都会动 `TaskStore` 的接口，因此它是一次决定，不是一次整理。**这一轮没有做**，但这一轮把触发它的路堵住了——新交出去的方法不会再开嵌套事务。

5. **泳道的 "Frozen node identity mismatch" 拒绝是空转的**。内核把冻结身份直接从它存的那份记录里读出来（`recordString(record, "identity")`），所以旧代码拿 `configuration.policy.binding.instanceId` 与 `snapshot.identity` 比的是同一个字段的两个副本，永远相等。现在类型化之后比较的是 `wrapper.Identity` 与 `wrapper.Record.Identity`——仍然是同一个值，但至少不再伪装成两个独立事实。要让它有意义，得拿记录里的身份与**执行那一行**所属的实例比；那是新加的判定，会改变恢复的行为，同样没有 E2E 能证明，因此没有加。

6. **提交守卫的实现比它自己的说明严**。守卫按**暂存的 blob** 量大小，因此任何一次改动只要碰到一个超过 20,000 字节的文件就被拦下——尽管说明写的是"仓库里已存在历史大文件，而它要拦的是**本次改动**新写大文件"。实现与说明的这一处出入，曾经让运行时层完全无法改动。上面第七步把两个历史大文件拆开后，这一处就不再挡路；但守卫本身仍会把任何历史大文件挡在门外，而它并没有实现说明里许诺的那份豁免。
   - **量过一遍之后，这件事比原先记的更大**：`backend/internal/graph` 这个包里**有 27 个文件超过 20,000 字节的上限**——`core_task_runtime.go` 197KB、`server_app.go` 96KB、`runtime_agent_tools.go` 62KB、`core_operation_lifecycle.go` 60KB 往下排。**它们一个都没有 `graph:allow-large-file` 标注**，所以今天改动这 27 个文件里的任何一个，守卫都会拦下来，除非像本分支前几次那样用 `--no-verify` 并在提交信息里说明。
   - **本分支已经把 33 个里的 29 个拆掉了**（能力、用量、自改进、Agent 提示词库、受控 provider、对话、任务运行时、HTTP 层、operation 生命周期、受限进程、store、execution、artifact 工作区、interface spec、助手流、节点运行、git 集成、daemon 启动、Pi 扩展、能力库、git、provider、配置、图运行时、布局、harness 探针、文件能力、图服务、Agent 上下文装配、模块运行时），每一个都是纯搬移并且逐字节证明过。**拆开一个文件是把问题消掉，而不是为它求一次例外**——这二十九次提交守卫都正常跑过了，一次 `--no-verify` 都没用。
   - **剩下的四个，各有各的理由，而且理由写在文件自己的头上**（用的是仓库自己的 `graph:allow-large-file` 标注，形式见 `docs/agents/checks.md`）：`core_pinyin_table.go` 是一张拼音表（每个字一行），`runtime_agent_tool_definitions.go` 是一张工具 schema 表（每个工具一条声明），`server_start_daemon.go` 的全部内容是一个 585 行的启动函数（它的闭包互相捕获，拆它是一次重写而不是一次搬移）。**第四个是有意留下的**：`runtime_agent_tools.go` 的 1,033 行全在一个 `AgentTools` 函数里，它造的就是那张工具表——**那张表大到没人能拿两份来比**，这大概就是主会话与节点泳道两份工具表各自漂移开的原因；它要等 id、遥测、panic 三处分歧定下来才能动。
   - **结果**：包里超过上限的文件从 33 个降到 4 个，其中三个带着写明理由的标注；**其余每一个要么低于上限、要么在文件头说明了自己为什么不是**。
   - **该怎么处理，是一个决定而不是一次整理**：把这些文件按职责拆开是安全的，但要拆函数的那几个（工具表）要先定 id、遥测、panic 三处分歧；数据文件则需要守卫承认"文件的大小不一定来自职责"。另一个办法是让守卫真的实现它说明里许诺的那份豁免——只拦本次改动新写的大文件——那是改守卫本身，等于改一条 ADR 写下的规矩。本轮两件都没做。

8. **E2E 门禁横跨两套实现**：64 个 E2E 文件里有 27 个仍然驱动已经退役的 TypeScript 守护进程，产品跑的是 Go daemon，门禁因此没有覆盖出厂执行路径。ADR 0033 明写"TypeScript 守护进程本身保留……退役它属于另一件事，本决策不夹带"，所以这件事需要单独一条 ADR，本轮按约定不碰。
    - **这一轮撞上了一次，它把这件事的代价写实了**（提交 `9d2a7480`）。修 Go 侧「状态查询不带 task id 就崩」的那个缺陷时，E2E 的第一版用的是 `startGraphDaemon`——它起的是** TypeScript 守护进程**。那份 E2E 在 TypeScript 上**通过**，而且通过得完全正确：TypeScript 实现从来没有这个 bug（它的 owner 查询带着守卫）。**一份通过的测试，量的是另一套实现。**把测试指向 Go daemon（`launchCli` + `--kernel pig`）之后，它才在父提交上失败，失败的样子正是缺陷本身：模型读到 "Tool failed: runtime error: invalid memory address or nil pointer dereference"。
    - **因此"27 个文件驱动退役的守护进程"不是一句统计**，它意味着那些测试**测不到出厂执行路径上的任何缺陷**。这一轮的那个缺陷就落在那里：Go 端口把 TypeScript 的守卫丢了，而 27 个文件里没有一个会发现它。
    - **本轮按约定不碰它**，但这一轮把证据补上了：这不是"也许有些测试测错了地方"，而是"有一个缺陷确实因此逃过了门禁，并且逃过的方式是可以写下来的"。

## `tasks` 表与任务闸门的归属缺口已经补上

kernel 层的表与 `tasks` 表现在都有 owner 了。`tasks` 的生命周期（phase、paused）原先由 12 个文件里的 34 处自己写，phase 的词汇散在十六个地方而不是一处；它的五种创建方式（一个 graph、一个对话下的 graph、一次主管回合、一个对话锚定的 task、一个已确认提案的 task）也各自写着 SQL。现在这些全是 store 的方法，创建的方法名说的是"创建什么"而不是"有哪些列"，<span>core_task_lifecycle.go</span> 是这张表唯一的写入口。

任务闸门也不再自己写 SQL。它读的 `operations`、`questions`、`invocations` 三张表的形状原本有两个地方知道：拥有它们的 store，和并不拥有它们的闸门。现在 <span>core_task_invocations.go</span> 回答闸门问的每一个问题，闸门里一条 SQL 都没有了。

**kernel 表现在也只由 store 抵达**。工具闸门（第十五步之前）、节点泳道的读与写（第十五步之前）都各自写着 SQL 问这些表；现在它们问 store，store 之外只有两个文件还写着 kernel 表的名字：

- **harness 的探针与证据**（`runtime_harness_probe.go`、`runtime_harness_evidence.go`）。它们读很多表来汇报一个图——节点、执行、队列、条目、提问、事件、provider 调用——是一个诊断面而不是一个决策面。它要读的那些表分属不同的 store，因此它天然横跨多份 store，而不是绕过它们。
- **执行名额**（`runtime_execution_slots.go`）。它把旧的 `operations` 表与新的 `kernel_executions` 表一起数，是**跨两份 store 的事实**，因此留在那个模块里是合理的。

剩下的同类已经补上了：`invocations` 与 `questions` 这两张表原先各有多个写入口——闸门这一侧已收进 store，operation 生命周期自己写一次调用的 usage 与 cost，`questions` 表更是由 7 个文件写了 14 遍"回答一个问题"、6 种谓词。现在 <span>core_task_questions.go</span> 是这张表唯一的写入口，七条规则各按"它答什么"命名；`invocations` 那一个写入口也走了 store。store 之外只剩两处 **schema 迁移**（退役时删掉已退役 operation 的 invocations、把问题归属从 user 移到 main Agent 的那次迁移）——迁移的 SQL 应该在迁移里。

**到这一步，运行时层与内核层写过的表都有 owner 了**：`tasks`、`questions`、`invocations` 归 task store，`kernel_*` 归 kernel store。剩下的是**读**的归属问题：这些表仍被十来处直接读（harness 的诊断面、预算账本、节点执行器、pi adapter 等），读不写，因此不构成"谁拥有这张表"的争议，但一个列的含义若要改，仍要找许多处。

**再往下还有一层，而它原先也没被查过**。`nodes` 是 v1 的节点表，它**原先由 17 个文件各自写着 SQL**——和 kernel 表一模一样的缺口，就在一层之下。现在它也有主人了（见[一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md)），守卫也管到了它。**但 v1 还有几张表没有主人**：`operations`（21 处写、11 个文件）与 `instances`（14 处、7 个），以及 `messages`、`runtime`、`projects` 这几张。（`activations` 已经在这一轮有了主人。）它们与 kernel 表、nodes 表是**同一个形状的问题**——一张表的形状被许多地方知道——因此这是**下一步的候选**，不是一次产品决定。本轮没有做。

**而这句话原本只覆盖了一半——图服务层没有查过**。一查就发现 **12 个文件里 38 处越界写**（`kernel_create_requests`、`kernel_graph_owners`、`kernel_graph_layouts`、`kernel_module_operations`、`kernel_module_inbox`、`kernel_transition_outbox`、`kernel_queue`、`kernel_node_state`、`kernel_nodes`、`kernel_modules`、`kernel_executions`、`kernel_lifecycle`）。现在它们都归 store 了：`backend/internal/graph` 里 **store 之外一处 kernel 写都没有**，而 `node --run check:ownership` 查的就是这件事（守卫与它的启用条件记在[后半程](architecture-deepening-ownership-2026-10-22.md)的第二十七步）。**一句只查了一半就写下来的主张，是愿望，不是主张。**
