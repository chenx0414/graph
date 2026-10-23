# 架构深化的后半程：表的归属（2026-10-22）

配套文档：[前半程](architecture-deepening-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md)

## 已完成并有证据的部分（后半程）

9. **kernel store 也按职责拆开了**（提交 `91936956`）。store 长大成了一个 68KB 的文件，修订、节点、执行、投递、队列、模块、预算与 provider 调用全在里面。每一件现在有自己的文件，store 自己只留下 store 本身：类型、迁移与事务。拆分逐行比对过，从原文件搬走的行一行没少。

10. **provider 闸门与 operation broker 都不再直接写 kernel 表**（提交 `91936956` 与 `5bb621bc`）。provider 闸门原本用自己写的 SQL 读写 `kernel_provider_calls` 与 `kernel_node_state`，于是这两张表的形状有两个地方知道：拥有它们的 store，和并不拥有它们的闸门。现在闸门问 store：节点花了多少、手上压着哪些调用、某个调用是否还开着；开、结算、对账一个调用也都走 store。闸门对 kernel 表的 SQL 没有了——一条都没有。operation broker 同样：`kernel_module_operations` 归 store 管，它问 store 某个投递已经带着哪个操作、准备一个、标记已发、释放 worker、记录遗留、结算它、判它失败，以及某个投递来自哪个执行。broker 剩下的四处读是 task store 的表，不是 kernel 的。
   - 顺带去掉了第二份重复结构：闸门原本另有一个 struct 专门从 model 列里读回 cost 与 pricing，而 model 记录里本来就带着它们，现在读的就是 store 那个类型。
   - 有一处故意比以前宽松：一行读不出来的 provider call 的 model 列，现在让 model 留空，而不是把 daemon 带下去——闸门一直忽略这个错误，store 原来会 panic。


11. **`tasks` 表有了 owner**（提交 `f45dcef2` 与 `d426952d`）。这张表是 graph 的生命周期表，phase 与 paused 原本由 12 个文件里的 34 处自己写，phase 的词汇散在十六个地方而不是一处；五种创建方式也各自写着 SQL。现在生命周期与创建都是 store 的方法，创建的方法名说的是"创建什么"而不是"有哪些列"。**这张表在整棵树里只有一个写入口**。

12. **任务闸门不再自己写 SQL**（提交 `2a5b23fb`）。闸门读三张表：问 operation 跑在哪个节点上，问节点或 operation 是否被一个开着的问题卡住（usage 说不清的那种），问一次调用是不是已经发出过，把调用开出去，读回它记下的 usage，再把 usage 与 cost 写回去。这些表的形状因此有两个地方知道：拥有它们的 store，和并不拥有它们的闸门——改一列要同时找两处。现在 store 回答这些问题，闸门只问：`OperationNode` 答"这个 operation 在哪个节点上"，`OpenUnknownUsageQuestion` 与 `OpenUnknownUsageQuestionForOperation` 答"它被卡住了吗"，`InvocationExists` 答"这次调用是不是已经发过"，`OpenInvocation` 开一次，`InvocationUsage` 读回记下的 usage，`RecordInvocationUsage` 写下去。**闸门里一条 SQL 都没有了**，它读到的是有类型的答案而不是从 map 里掏出来的值。
    - **一处细节值得写下来**：store 把记下的 usage 以指针交回来，因为 usage 列是 NULL 的调用是**还没结算**，不是"记下了一个空的 usage"——后者会让第一次结算拿闸门刚拿到的证据跟自己撞出一个冲突。旧代码是检查值是否为 nil 来分辨这两者，现在仍然这样分辨。
    - **证据**：一次探针把闸门推过完整条路径——发出、结算、同一份证据结算两次、不同的证据结算一次、结算一个没人开过的调用、结算一个 usage 从没记过的调用、靠 store 找到自己节点的闸门、卡住闸门的问题、归 agent 所有因而不卡闸门的问题、没人能算清的 usage、以及一个 task 记下的调用行。探针在这个提交上跑了一遍，在它的父提交上又跑了一遍，**两遍打印出同样的 26 行**。探针已删除——仓库只允许真正的 E2E。
    - **这一次守卫没有例外**：闸门 7,167 字节、新的 store 文件 4,320 字节，都远低于 20,000 字节的上限。

13. **工具闸门也问 store**（提交 `2c7d7e5a`）。闸门决定一次宿主工具能不能跑，而它是用自己写的 SQL 读三张 kernel 表来决定的：这个节点在跑哪个 execution、这个节点花了多少、是不是被暂停、哪些 provider 调用还占着预留。它是最后一个这样决定预算的模块——provider 闸门、节点泳道与 operation broker 早就已经问 store 了。现在它问：`RunningExecution` 答"在跑哪个 execution"，`NodeUsage` 答"花了多少、是否暂停"，`PendingProviderCalls` 答"哪些调用还占着预留"。闸门自己的 SQL 没有了。
    - **一处差异值得写下来，因为它是唯一一处**：闸门原先问"在跑哪个 execution"时**没有说它要哪一个**——那条查询既没有顺序也没有限制，因此一个节点有不止一个 running execution 时，它拿到的是数据库碰巧给的那一行。另外九个问这个问题的地方说的都是同一句话——**这个节点最新的 running execution**——store 的 `RunningExecution` 也是这么说的。闸门现在也这么说了，这意味着它不会再在节点跑着 A 的时候去查 B 的预算。**九份副本与这第十份，现在是一份规则**。
    - **证据**：一次探针把闸门推过十种情况——没有 running execution、有 running execution、正在关闭的节点、被暂停的节点、正在停止的 task、花光了预算的节点、算进预算的在途 provider 预留、没人算得清的 usage、无限额预算、以及无效的预留。在这个改动上跑一遍，在它的父提交上又跑一遍，**两遍打印出同样的 11 行**。探针已删除。

14. **节点泳道读表也走 store**（提交 `8d750d38`）。泳道用自己写的 SQL 读四张 kernel 表：某个 task 收到过哪些边上的工作、某个节点被受理时用的是哪个 instance、某个节点是不是有算不清的 usage、某个 execution 到底有没有发过 provider 调用。节点宿主又问了节点表第五个问题，用的是同一个查询的另一份拷贝。现在它们问 store：`NodeInstanceID` 答"这个节点跑在哪个 instance 上"（泳道与宿主共用同一个查询，两份拷贝变成一份）、`DeliveryEdges` 答"工作沿哪些端点对走过"（这样禁用一条边不会抹掉已经收到过的工作的身份）、`HasUnknownProviderCall` 答"这个节点有没有算不清的 usage"，而 store 原有的 `ProviderCallsOfExecution` 答"这个 execution 有没有发过 provider 调用"。**背后的查询就是原来那些查询，同样的谓词、同样的顺序**。

15. **节点泳道写表也走 store**（提交 `bac1d6bf`）。泳道用自己写的 SQL 写四张 kernel 表：一个节点被送出的提示词（同一段 INSERT 写了两遍，两处送提示词的地方各一份）、一个节点跑着的会话绑定、一个 task 的完成工作被交付用的那个 commit，以及恢复一个冻结回合期间某个 execution 的状态。现在这些都归 store：`RecordPrompt` 记提示词与工具表，`RecordNodeBinding` 记模型、提示词、工具、状态目录、角色与环境，`RecordCompletionDelivery` 记交付用的 commit，`SetExecutionState` 记一个 execution 的状态（泳道在恢复冻结回合时把 execution 置为 running、事后把旧状态放回去——这本来就是关于 execution 的事实）。
    - **到这一步，kernel 表只由拥有它们的 store 抵达**。泳道、节点宿主、工具闸门、provider 闸门、operation broker 与节点恢复都问它。store 之外只有两个文件还写着 kernel 表的名字：harness 的探针与证据（它们读很多表来汇报一个图，是诊断面），以及执行名额（它把旧的 `operations` 表与新的 `kernel_executions` 表一起数——这件事天然不属于任何一份 store）。

16. **`questions` 表只有一个写入口**（提交 `32fb586a`）。这张表原本由 7 个文件自己写，"回答一个问题"这句话被写了 **14 遍**，而"回答"有 **6 种谓词**：按 id、按 id 且只答还开着的、按 operation、按 operation 且只答 `recovery` 的、按 task、按 task+node 且只答 `budget` 的。要改"一个问题是什么"或者"什么算回答了"，得找齐这十四处。现在这些规则归 store：`OpenQuestion` 记下 task 等着的那个问题，七条解决规则各按"它答什么"命名——`ResolveQuestion`、`ResolveOpenQuestion`、`ResolveOperationQuestions`、`ResolveOperationRecoveryQuestions`、`ResolveTaskQuestions`、`ResolveNodeBudgetQuestions`——外加 `AmendQuestionData`（替一个还开着的问题换掉它的 data）。其中两条报出答了几条，因为调用方要用那个数。
    - **每个方法收的是答案本身，不是存好的文本**——存成什么样子由 store 决定。因此调用方只说"这个问题被这样回答了"，不再说答案怎么存。
    - `invocations` 表还剩一个写入口：operation 生命周期原本自己写这次调用的 usage 与 cost，而任务闸门写同样两列时是走 store 的。现在它走 store。
    - **store 之外只剩两处 schema 迁移**——退役时删掉已退役 operation 的 invocations，以及把问题归属从 user 移到 main Agent 的那次迁移。迁移的 SQL 应该在迁移里。
    - **这一次提交跳过了文件大小守卫**，理由与合并、任务生命周期那两次相同：守卫量的是暂存的 blob，而这四个文件改动前就很大（`core_task_runtime.go` 197KB、`core_operation_lifecycle.go` 60KB、`core_execution.go` 46KB、`core_graph_runtime.go` 22KB），而且**四个都比改动前小了**——456、608、99、70 字节。这次新增的文件 `core_task_questions.go` 是 3,031 字节。
    - **证据**：一次探针把每条规则推过真实的行——开一个问题与它的 canonical data、同一问题答两次、只答还开着的那个（已答过的不再答）、一个 operation 的问题不动另一个 operation、recovery 规则不动另一个 kind、两条要计数的规则与它们的计数、改 data 而不回答问题、以及一次调用的 usage 与 cost——**24 项检查全过**。探针已删除。

23. **两条工具表合成了同一套规则**（提交 `426bd2cb`）。第二十二步把表拆开只是为了能读它；拆开之后，三处分歧第一次能并排看，于是它们也就第一次能被改：
    - **id 收成一个**。主会话原先给闸门一个 id、给工具另一个，于是额度账本数的那次调用与写入账本记的那次调用**是两条对不上的记录**。节点泳道与原件本来就只用一个 id。
    - **节点泳道补上遥测**。PiG kernel 自己那个 `OnToolCall` 钩子**从来没有被触发**——它被一路传下去，却没有任何地方调用它。所以记录只能来自工具自己，主会话那样做的，节点泳道现在也这样做。
    - **主会话的 `PrepareArguments` panic 转成错误值**。`PrepareToolArguments` 确实会 panic（参数不合法时），而它在 `Execute` 之外跑；主会话原先让它逃出去、连回合一并带走。工具表里写着这个 daemon 自己的做法——"the host turns that refusal into the tool error the model reads, instead of losing the turn"——节点泳道一直照做，主会话现在也照做。
    - **证据**：一份真图里的节点先读一个文件再提交。那次 read 走的正是节点的工具闸门，因此它就是统计表该记下的那次调用。**这个 E2E 在父提交上失败**（read 根本不出现），在这个提交上通过。

#### 第二十三步的细节：两条工具表曾经差在哪

TypeScript 原件在 `src/runtime/durable-tools.ts:160-172` 恢复时只做了一件事：**把整份冻结策略盖回请求上**。

| | TypeScript 原件 | Go 主会话（改之前） | Go 节点泳道（改之前） |
| --- | --- | --- | --- |
| **id** | 同一个 id 既给 broker 也给工具 | **两个 id** | 同一个 id ✓ |
| **遥测** | 每次调用都记，在 `finally` 里 | 记，但 **panic 时不记** | **完全不记** |
| **panic** | 重新抛出 | 重新抛出（`PrepareArguments` 的 panic 逃出去） | 转成错误值 |
| **外部闸门** | 只看 `externallyGated` 标记 | 只看标记 ✓ | 标记 + 一份名字清单 |

**先前记的一处是错的，这里更正**："`submit` 本来就带着 `ExternallyGated` 标记，等于同一件事记了两遍"——**不成立**。`submit` 由 `kernelGraphLaneSubmitTool()` 造，是 `PiWorkerTool`，不是 `AgentToolDeclaration`；它没有那个标记，因此那份名字清单不是重复。

三行现在都说同一句话了：**id 收成一个**（额度账本与写入账本记的是同一次调用）；**遥测补上**（PiG kernel 那个 `OnToolCall` 钩子从来没有被触发，所以记录只能来自工具自己）；**panic 转成错误值**（那正是这个 daemon 自己说的做法）。

24. **main 又前进了十三个提交，合进来了**（提交 `45b66d4c`）。那十三个提交全是 harness 的活：一个同时装着"项目遇到的摩擦"与"项目采纳的教训"的**知识库**、一次让一个任务在几个 harness 下各跑一遍的探针、跑过的候选、它们教出来的教训，以及把教训读回去的循环。

    **这一次合并不是"解冲突"那么简单。** 本分支拆过其中几个文件，因此 main 的内容必须**放到每个声明现在所在的地方**；而 main 自己也拆了 harness 那几个文件——**main 的拆法更新，而且它装的东西是本分支那份的超集**（逐个函数比过：main 有 45 个，本分支有 39 个，本分支的一个都不缺 main 的），所以那五个文件直接取 main 的，本分支多出来的两个删掉。

    - **工具表**：graph management 那个面多了 `HarnessDecision` 与 `HarnessFriction` 两个字段，工具表多了两个 handler（记摩擦、声明领域）。**字段进放类型的文件，handler 进放 harness handler 的文件**，探针那个 handler 换成 main 的版本（它现在要 task、recipe、model、base harness 与那几个变体）。
    - **Agent 上下文**：main 把 classified 那段身份改成了由默认那段**推导**出来的，因此两段声明都按 main 的取；overlay（让一个节点跑在与其余节点不同的 harness 下）进 library 文件与提示词文件。
    - **图服务与任务运行时**：接口与接线多了摩擦记录器，经验的那次读**现在带着它该回答的那个 scope**。
    - **工具 schema 表**：保留本分支写明它为何大的标注，取 main 新增的工具声明。

    **这一次合并是查过的，不是看过的**：把 main 自分支分叉以来**新增的每一行**拿到合并后的树里去找，**找不到的行数是零**。第一次合并时这个数是 **174**——冲突只是看得见的那一部分，其余是本分支拆过、而 main 只是编辑过的文件。查出来之后才知道：只看冲突是不够的。

    合并在本分支之上动了 22 个文件。合并跳过了文件大小守卫，理由与前一次相同：守卫量的是暂存的 blob，而一次合并会把 main 自己的文件暂存进来（`src/runtime/agent-context.ts` 47KB，逐字节是 main 的）。

## 查出来、尚未处理的问题

它们各占一份文档，因为每一件都是不同的性质、需要不同的决定：[架构深化查出来、尚未处理的问题](architecture-deepening-open-2026-10-22.md)。

## 门禁证据

每一次门禁的结果记在另一份文档里：[架构深化门禁证据](architecture-deepening-gate-2026-10-22.md)。
