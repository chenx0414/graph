# ADR 0035：一张持久表只有一个主人

日期：2026-10-24

## 状态

已接受。

## 背景

Graph 的 Go daemon 有两份 store：`TaskStore`（任务、会话与 v1 的图）与 `KernelStore`
（v2 的内核表）。它们背后是同一份 SQLite。

问题是**谁在写这些表**。一张表的形状——哪一列放什么、哪些列可以一起改、哪些状态是合法的
——应该在**一处**知道。如果十几处各自写着那张表的 SQL，那么改一列就要找十几处，而且每一处
都可能理解得不一样。

这件事在 v2 的内核表上一直是对的：`KernelStore` 拥有 `kernel_*`，别的模块问它要答案、要它
去写。但**v1 的表从来没有主人**。`nodes`、`operations`、`instances`、`activations`、
`conversations`、`proposals`、`messages`、`projects`、`artifacts`、`commands`、
`task_grants` 这些表，原先由**十几个不相干的模块**各自写着 SQL：operation 生命周期在写
`nodes`，问题路由在写 `nodes`，任务运行时在写 `nodes` 与 `operations`，额度账本在写
`instances` 与 `operations`……**每张表的形状因此有十几个住处。**

有一处特别值得记：`artifacts` 表的插入语句有 31 列，原先在**两个文件里一模一样地写了两遍**。

还有一层区别需要说清楚。`KernelStore` 内部的几个文件也各自写着好几张 kernel 表：预算账本写
节点预留的 token，暂停时钟写节点的暂停列，执行模块在它的执行开始时写节点在跑。**那不是第二个
主人**——那是**同一个主人在按域分工**，与 v1 那种「不相干的模块写别人的表」是不同的事。store
本来就按职责拆成许多个文件（见 [ADR 0033](0033-pig-go-kernel.md) 的内核归属）。

## 决策

- **一张持久表只有一个主人**，而主人是二者之一：
  - **拥有它的那份 store**：`kernel_*` 归 `KernelStore`；`tasks`、`questions`、
    `invocations`、`nodes`、`activations`、`instances`、`operations`、`conversations`、
    `proposals`、`messages`、`runtime`、`projects`、`artifacts`、`artifact_links`、
    `commands`、`task_grants` 归 `TaskStore`。
  - **这张表所属的那个模块**：`wake_intents` 归唤醒账本，`tool_calls` 与
    `tool_call_spools` 归工具调用 store，`git_commits`、`git_ops`、`worktrees` 归 git 集成，
    `pause_continuations` 归暂停续跑，`rsi_continuations` 归 RSI 续跑，
    `agent_context_bindings` 归上下文绑定。
- **写表的方法说做什么，不说什么列**。规则留在决定它的地方，SQL 落在拥有这张表的文件里。
  一个知道产出有 namespace、有 digest 的调用方，不该同时知道 namespace 是第几列。
- **一条规则若天然横跨多张表**（退役一个图连同它的一切、保留期清扫、一次跨表操作），
  **在文件头上写明**，并且那一条规则的每个参与表都归它自己。
- **迁移的 SQL 归迁移**：schema 的形状写在迁移里，那是写下形状的地方。
- **读不算第二个主人**：读不改表的形状，所以一张表可以被许多地方读。
- **守卫生效**：`scripts/check-table-ownership.mjs` 查这件事，两种看法：
  - 整棵树（`node --run check:ownership`）：谁在写谁的表。
  - **只看这次改动新增了什么**（`--staged`）：**一张已经有主人的表，这次改动又添一个写者，
    就拒绝**；这个决定还没走到的表**一个也不碰**。
  后者因此可以进**每一个 worktree 的 commit Hook**——它拦的是本次改动新写的东西，不是历史上
  就有的东西。仓库里没有这个检查时，Hook 跳过它。
- **store 内部的分散不算第二个主人**。若还想更严（每张 kernel 表的形状只在一个文件里），那是
  另一个决定：它会把预算账本里「预留加了多少」的 SQL 搬到一个与预算无关的文件里，让规则与它
  写下的列分开。**本决策不采用那一条**，因为 store 内部是同一层，而 v1 那层的调用方是**另一层**。

## 后果

- **改一列只在一个文件里**。`artifacts` 的 31 列从此只有一处。
- **表的形状与它的规则分开存放**：写表的方法读起来是「这个节点被挡住」「这次交付结算了」，
  而不是一串 SQL。
- **新写者会被拦下**：守卫进每个 commit Hook，一个模块想给别人的表加一处写，它会在提交时
  被拒。
- **守卫整树那一种暂时不进门禁**：main 与并行的几个分支仍是旧布局，等它们都取了这次改动
  之后再接进 `check-queue.py`。
- **这一决策没有碰 store 的并发模型**。`TaskStore` 的连接池是一个连接，因此一个事务开着
  的时候，并发语句会落在那个事务里——那是另一件事，代价与两条修法见
  [尚未处理的问题](../planning/architecture-deepening-open-2026-10-22.md)。
