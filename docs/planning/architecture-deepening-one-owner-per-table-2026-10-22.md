# 一张表一个主人：把主张查到底，再加一道守卫（2026-10-22）

配套文档：[架构深化计划与证据](architecture-deepening-2026-10-22.md) · [后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [v1 的表也有了主人](architecture-deepening-v1-tables-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)

这一份讲的是**一句主张怎么被查到底**，以及查完之后**怎么让它不再退回去**。



26. **「kernel 表归 store」这条主张，此前只查过两个层**（提交 `07ef0b92`、`83c16062`、`9894782f`、`4c821127`）。第十五步写下这句话时，它查过的是**运行时层**与**内核层**：泳道、节点宿主、工具闸门、provider 闸门、operation broker 与节点恢复都不再自己写 kernel 表。**图服务层没有查过**。一查就发现 **12 个文件里 38 处越界写**——而且它们写的是 `kernel_create_requests`、`kernel_graph_owners`、`kernel_graph_layouts`、`kernel_module_operations`、`kernel_module_inbox`、`kernel_transition_outbox`、`kernel_queue`、`kernel_node_state`、`kernel_nodes`、`kernel_modules`、`kernel_executions`、`kernel_lifecycle`。**一条被写下来的主张，如果只查了一半，那它就不是主张，是愿望。**

    - **图的创建请求与归属**（`07ef0b92`）。同一个 request id 问两次要拿到同一个图，让这件事成真的是那张记着"第一次问了什么"的行——图 id、要的定义、准备到了哪一步。图服务原先自己读它、自己写它三个状态，因此知道它的列。store 现在持有它：`FindCreateRequest` 答"这个 request id 用过没有"，`RecordCreateRequest` 记下这次问，`MarkCreateRequestReady` 与 `MarkCreateRequestFailed` 记下准备到了哪一步，`RecordGraphOwner` 与 `GraphOwner` 记与答"这张图归谁"。
    - **图的控制面**（`83c16062`）。relayout、取消一个 operation、重试/跳过/取消一个队列项、暂停/恢复一个节点、停掉整张图——每一样都在调用点写着 kernel 表的 SQL：布局行、module operation、module inbox、队列、节点自己的行、节点的暂停标志。现在它们问 store，而方法名说的是**做什么**而不是**动哪些列**：`ResetGraphLayout`、`CancelModuleOperation`、`UnblockNode`（被挡住的节点回到 idle）、`ReleaseNode`（跑不了的节点回到 idle）、`RetryQueueItem`（放回队列并把 generation 加一）、`SettleQueueItem`（结束，不再跑）、`CancelQueuedWork`、`MarkDeliveryProcessed` 与 `MarkGraphDeliveriesProcessed`。
        - 一条语句变成两条，而差别是**一条规则**而不是一次重写：重试路径原本一条语句同时写队列状态、原因与 generation，而 generation 只在重试时加一。`RetryQueueItem` 与 `SettleQueueItem` 各自说明自己是哪一种，于是 generation 只在它该加的地方加。
    - **修订、执行与模块**（`9894782f`）。新修订不是换掉一张图，而是把它挪动：修订新增的节点被受理，留下的节点被放到新修订上并带上新的 spec，被移除的节点被退休——这三条原先由图运行时自己写，因此它知道节点表与模块表的列。store 现在知道：`ApplyNodeRevision`、`ApplyModuleRevision`、`RetireNode`。执行身上那个"还缺什么"的标志由节点执行器与提交桥各写一次，现在由 `MarkExecutionMissingRequired`、`ClearExecutionMissingRequired`、`MarkExecutionPendingGap` 说。图请求完成由 `RequestGraphCompletion` 与 `ClearGraphCompletionRequest` 说。模块的触发由 `ResetModuleTrigger` 说，operation 占着 worker 由 `HoldModuleOperationWorker` 说——它就挨着 store 原有的 `ReleaseModuleOperationWorker`。
    - **暂停时钟与执行时钟**（`4c821127`）。两个时钟原先是自由函数，写着 kernel 表：暂停时钟写节点行的暂停列（图可以暂停，图里的一个节点也可以暂停，时钟是共用的），执行时钟写执行行的两段区间。它们现在是 store 的方法：`SetNativePause`、`FinishNativePauses`、`NativePauseMs`、`SetExecutionWaiting`、`CloseExecutionTiming`。**改签名是这次交出的要点**：要用这些时钟的地方手里正好有 kernel store，于是它们现在这么说——图的控制面与节点泳道本来就有，任务运行时一直有（store 建起来那天它就有了），**执行名额只有 task store**，因为它把旧的 `operations` 表与新的 kernel 表一起数：那是关于两份 store 的事实，它留在原处；但它不再自己写 kernel 表，它问 store 要 worker 与执行等待。
        - **一处必须记下来的约束**：执行名额的等待**开着事务**再调 store。因此 store 的方法要写成**加入调用方已经持有的事务**而不是自己再开一个——事务里再 BEGIN 正是宿主一直拒绝的。store 那个方法就是这么写的，所以等待既不死锁也不开嵌套事务。
    - **每一条新方法都是一条语句**，这正是它们能在调用方已经持有的事务里跑的原因——一条语句本身就是原子的。图的控制在事务里应用（重试路径把队列项、节点的暂停标志与节点的状态一起改，要么都成要么都不成），store 的方法因此**加入那个事务，而不是自己开一个**。
    - **这一轮没有新写测试**：改的是**谁写哪张表**，不是**写什么**。行为由完整的门禁证明（见门禁证据那份文档）。

27. **内核表有了一道守卫**（提交 `bd063ba4`）。一句没人检查的话是话，不是规则。`scripts/check-kernel-ownership.mjs` 去找 `backend/internal/graph` 里 store 自己文件之外对 `kernel_` 表的写，并报出文件、行与表名。它**读 SQL 本身**，因此写法不同的写也是写；注释里提到一张表不是写，因此它先去掉注释再看。**守卫也试过它能不能失败**：拿一个有写的文件试，它报出了那一行；拿一个只提到表的注释试，它没有报。
    - **它暂时不进 `node --run check`，也不进 Pre-commit Hook**：main 与并行的几个分支仍有几十处越界写（main 61 处），而 Hook 与门禁是**这个仓库所有工作树共用的**，现在接进去只会打断它们的提交，不会教会它们什么。检查自己站得住（`node --run check:ownership`），检查操作指南里写清了接进 `check-queue.py` 的条件：**那些分支都取了这次改动之后**。
    - **后来它管得更宽了**（提交 `23ad0a79`，脚本改名为 `scripts/check-table-ownership.mjs`）：既然 `nodes` 表也有了主人，守卫就该看着 store 拥有的**每一张**表——`kernel_` 那批归 `KernelStore`，`tasks`/`questions`/`invocations`/`nodes` 归 `TaskStore`。**两种文件可以例外，但要在文件头上写明为什么**：`// graph:table-writes-exempt: <理由>`。一是**迁移**（迁移的 SQL 描述的就是形状本身），二是**一次跨多张表的操作**（退役一个图连同它的一切，是关于许多张表的一个事实；拆开它会让这次操作对自己在做什么说谎）。

29. **`nodes` 表也有了一个主人**（提交 `6161e550`、`61dea066`、`ffb87d40`、`20b61fc0`）。`nodes` 是 v1 的节点表：每个任务每个节点一行，记着节点的规格、它跑在哪个 instance、它的 activation、它的状态与它的产出。它**原先由 17 个文件各自写着 SQL**，于是这张表的形状有 17 个地方知道——**和 kernel 表当初一模一样的缺口，就在一层之下**，而这一层分支从没查过。
    - **状态是规则最多的地方，而规则只有几条**：节点在等、在准备、在跑、被挡住、或者已经结束。**18 处**各自写着 SQL 说明节点到了哪个状态。task store 现在说这件事，方式和它说任务在哪个 phase 一样：`SetNodePending`、`SetNodePreparing`、`SetNodeRunning`、`SetNodeBlocked`、`SetNodeStatus`，外加两条**自带条件**的规则——`ResumeSucceededNode`（只有真的结束过的节点才被放回队列）与 `SetNodeRunningForActivation`（activation 对得上才认领这个节点）。**词汇表现在在一处**，和 phase 一样。
    - **规格、activation 与节点本身**（`61dea066`）：`SetNodeSpec`、`SetNodeActivation`、`CreateNode`。activation 那一处原本在**创建 activation 的那个函数**里——那正是唯一该说这件事的地方。
    - **产出**（`ffb87d40`）：一轮结束时节点留下产出、route 被清掉（它等的东西到了）、output_version 加一、记下是哪个 operation 产出的；一次会被重试的尝试则还要把 stall_count 加一，让重试预算看得见。`SettleNodeOutput` 与 `RetryNodeOutput` 说这两件事。
    - **两个时钟**（`20b61fc0`）：图被暂停时它的节点开始计暂停的时长，节点等用户时它开始计等待的时长。跟着它们一起搬过来的还有**节点不会自己回来的那几种状态**（succeeded、skipped、retired、failed）——它原本住在时间账本自己的文件里，现在它和时钟待在一起，因为它是一条关于节点状态的规则。
    - **每一个方法都是一条语句**，因此它们**加入调用方已经持有的事务**。这一点在这里是要紧的：operation 生命周期在**同一个事务**里给节点改状态、开 operation、发 operation、结算 operation，而一个自己开事务的 store 方法会等一把外层正持有的锁。
    - **store 之外剩下的写只有两处，而且两处都写明了为什么**：schema 迁移（迁移的 SQL 描述的就是形状本身）与退役一个图的那次跨表操作（关于许多张表的一个事实）。


30. **节点的那一轮（`activations` 表）也有了一个主人**（提交 `f77e7674`）。`activations` 是 v1 路径上**节点的一轮**：一行一轮，记着这一轮在哪个状态、第几轮。它原先由 **8 个文件**各自写着 SQL，于是这张表的形状有 8 个地方知道。
    - **一轮真正有的那几条规则**：它在被准备、它在跑、它被挡住、它会被再试一次（进下一轮）、它又在等了、它结束了并**取它那个节点到达的状态**，以及**某个节点的那一轮**因为一个问题被回答而重新在等。
    - **开一轮现在是一个方法**：它既加上这一轮，也把节点指向它。这两处写原本在同一个函数里，但那个函数是自由的，而且**节点的列**——也就是 `nodes` 表的形状——被写在了它里面。
    - **那个自由函数没了**：store 的方法在两个调用点替掉了它，而**一个没人调用的函数只是形状的另一个住处**。
    - 守卫也看着这张表了。store 之外剩下的写只有 schema 迁移那一条。

31. **`instances` 表（节点跑在哪个 runtime 上）也有了一个主人**（提交 `b616bb83`）。`instances` 是 v1 节点的那个 runtime：它跑哪个模型、哪个 definition 版本、它的额度从哪来、它花了多少。它原先由 **7 个文件**各自写着 SQL。
    - **身份是一条规则**：这个 instance 跑哪个模型、哪个 definition 版本。额度是另一条。store 现在知道它们各自记在哪。
    - **额度的规则留在账本里**：**账本决定**额度什么时候变、scope 什么时候共享、usage 什么时候记；**store 说**额度和已花的 token 记在哪。这和节点的状态是同一个分工——**生命周期决定，store 写**。
    - **「这个 instance 跑过哪些模型」是成对搬过去的**：读那个列表与写那个列表是同一列，而 store 现在两端都管，**包括它的编码**。**一列的编码也是这张表形状的一部分**，账本不该自己拼那段 JSON。
    - **额度那几列原先是由账本一个人写的**（`budget_scopes` 也是），所以这一步真正消掉的是**身份那一面**的分散：执行、对话、任务运行时四个地方原先各自写着 instance 的 model 与 definition。

32. **`operations` 表（一次 operation）也有了一个主人**（提交 `0b9bad7e`）。`operations` 记着一次 operation：跑它的意图、占着它的 worker、它等的那个名额、它按住的额度预留、它产出了什么、它怎么结束的。它原先由 **11 个文件**各自写着 SQL——**v1 里散得最开的一张表**。
    - **生命周期仍然决定**：被受理、被发出、结算、说不清、没发出去——**store 说这些状态记在哪**。预留是额度账本的事、回复是对话的事，**它们也在这里说**。
    - **唯一一条自带条件的规则是预留**：只有**还没发出、且手上没有预留**的 operation 才能拿到预留。store 说它拿到了没有，**账本决定这意味着什么**。
    - **有一处写本来就在 store 里**（记 operation 跑的是哪段提示词与哪张工具表），它搬进了**拥有这张表的那个文件**——**一张表的写属于一处**，而提示词那个文件留读的那一半。
33. **守卫认得两种主人**（提交 `c87ad1ea`）。一条表**一个主人**，而主人**不一定是 store**：`wake_intents` 归唤醒账本、`tool_calls` 归工具调用 store、`git_commits` 归 git 集成。**这些表本来就只由一个文件写**，所以规则对它们**已经成立**——但没有人说过主人是谁，而**没有人说过，就没人会注意到第二个写者来了**。守卫现在把它们逐个点名。
    - **措辞也跟着改了**：规则原先写的是「拥有它的 store 是唯一写它的人」，而那句话**只对了一半**——主人也可能是这张表所属的那个模块。
    - 又一个迁移文件补上了声明：**schema 版本脚本**（它们带着填 newly 加列的回填语句）。

34. **对话域的三张表都有了主人**（提交 `e3f37853` 与 `670ab552`）。`conversations`（3 个文件）、`proposals`（2 个）、`messages`（2 个）——**这一组是彼此相关的**，所以一起做。
    - **`conversations`**：一个对话属于哪个项目、锚在哪个 task、它的标题、它有没有被收起、它跑在哪个思考档位、以及它的**绑定从哪一条消息开始**。规则就是对话真有的那几条：被开出来、被收起、被放回来、被绑到某个项目、被重新绑定、被设成某个思考档位。
    - **有一条规则值得单独说，因为它读起来像奇事**：对话的绑定**从它最后一条消息开始**——因此在它之前说的话，说的都是**上一个项目**的事。这正是**项目一换，旧草稿就不可确认**的原因。
    - **`proposals`**：一个提案的某个版本——它带的定义、它是针对哪个需求版本做的、对它做了什么决定、以及它是否还只是一份草稿。
    - **`messages`**：一条消息——谁说的、是什么种类、它的正文与载荷、它在哪个状态、它属于哪次调用与哪一轮。
    - **唯一自带条件的规则是取消**：只有**还排在队列里**的消息能被取消。store 说它是不是还排着，**调用方决定这意味着什么**。
