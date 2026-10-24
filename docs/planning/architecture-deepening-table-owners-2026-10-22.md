# 表归属这一层，还剩什么（2026-10-22）

配套文档：[架构深化计划与证据](architecture-deepening-2026-10-22.md) · [后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [v1 的表也有了主人](architecture-deepening-v1-tables-2026-10-22.md) · [表归属这一层，还剩什么](architecture-deepening-table-owners-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [v1 的表也有了主人](architecture-deepening-v1-tables-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)

这一份是[尚未处理的问题](architecture-deepening-open-2026-10-22.md)里关于**表的主人**的那一半：v1 剩下的散表、kernel store 内部那一层的判断、以及守卫自己那个洞。

**v1 全部归位之后，剩下的是 store 内部的那一层**。kernel 表的主人是 `KernelStore`，这一点从来没问题；**问题是 store 自己**——它按职责拆成了二十几个文件，于是**同一张表的形状在几个文件里都知道**：

| 表 | 写在哪几个文件 | 它自己的那个文件写了多少 |
| --- | --- | --- |
| `kernel_executions` | 6 个（执行、执行状态、执行时钟、预算、恢复、provider 调用） | 8 / 19 |
| `kernel_node_state` | 4 个（预算、节点、控制面、恢复） | 7 / 18 |
| `kernel_nodes` | 7 个（节点、暂停时钟、执行、控制面、预算、恢复、修订） | 6 / 17 |
| `kernel_queue` | 5 个（队列、控制面、执行、节点、恢复） | 6 / 13 |
| `kernel_module_operations` | 4 个 | 7 / 11 |

**这一层的判断：kernel store 内部的分散是设计，不是毛病，而 v1 那层的毛病已经不存在了。**

两层的差别在于**谁在写**。v1 的毛病是**跨层写**——operation 生命周期、问题路由、任务运行时这些**不相干的模块**在写一张它们没有理由拥有的表，于是那张表的形状在十几个地方都知道。kernel store 没有这个问题：store 内部的每一个文件写的是**它自己那个域的表**——预算账本写节点预留的 token，暂停时钟写节点的暂停列，执行模块在它的执行开始时写节点在跑。**那不是第二个主人，那是同一个主人在按域分工。**

**store 是主人，它的文件按职责分开**——这是分支早先就定下的决定（"每一件现在有自己的文件"），不是这一轮该推翻的东西。**真正要守住的边界是 store 之外**：守卫现在查的就是这一条，而它**查得住了**——修掉图布局那处之后，**没有一张 kernel 表在 store 之外被写**。

**若还想更严一层的规矩**（每张 kernel 表的形状只在一个文件里），那是**另一个决定**，而不是一个缺陷：它会把预算账本里"预留加了多少"的 SQL 搬到一个与预算无关的文件里，让**规则与它写下的列分开**。本分支在 v1 那层选了相反的方向（规则留在原处、SQL 落到表的家里），因为那里的调用方是**另一层**；store 内部是**同一层**，因此这条规矩在这里不适用。

**守卫自己也有过一个洞，值得记下来**：它的正则读的是 `INSERT INTO`，而**没有读 `INSERT OR IGNORE INTO` 与 `INSERT OR REPLACE INTO`**。那些冲突子句也是语句的一部分，于是**有一处 store 之外的写一直没被看见**（`kernel_graph_layouts`，写在任务运行时里）。**正则补上之后，它立刻抓到了那条**——**抓住它的正是它被写出来要做的那件事：读 SQL，而不是读名字**。它们与 kernel 表、nodes 表是**同一个形状的问题**——一张表的形状被许多地方知道——因此这是**下一步的候选**，不是一次产品决定。本轮没有做。

**而这句话原本只覆盖了一半——图服务层没有查过**。一查就发现 **12 个文件里 38 处越界写**（`kernel_create_requests`、`kernel_graph_owners`、`kernel_graph_layouts`、`kernel_module_operations`、`kernel_module_inbox`、`kernel_transition_outbox`、`kernel_queue`、`kernel_node_state`、`kernel_nodes`、`kernel_modules`、`kernel_executions`、`kernel_lifecycle`）。现在它们都归 store 了：`backend/internal/graph` 里 **store 之外一处 kernel 写都没有**，而 `node --run check:ownership` 查的就是这件事（守卫与它的启用条件记在[后半程](architecture-deepening-ownership-2026-10-22.md)的第二十七步）。**一句只查了一半就写下来的主张，是愿望，不是主张。**

## 顺带查出来的一件更重的事：事务的状态是全局的（2026-10-24）

这一轮在查「store 内部的跨文件写是不是也是毛病」的时候，撞见了一件**不属于表**、但更重的事。

`TaskStore` 的连接池是**一个连接**。`BEGIN IMMEDIATE` 之后那条连接回到了池里，于是**任何并发语句都落在那个开着的事务里**。一次探针（用真实 store，探针已删除）把后果坐实了：

```
while the transaction is open, the other writer's row is visible: 1
after that transaction rolled back, the other writer's row is still there: 0
=> the concurrent write was rolled back by a transaction it was never part of
```

**一次并发写被一个它从未参与的事务回滚了。**

而**十二处**写成了「已经在事务里就内联，否则开一个」——`withStoreTx`、`k.tx`、`ModuleTransaction` 那一族——而 `IsTransaction()` 答的是「**有没有人**在事务里」，代码问的却是「**我**在不在事务里」。**全局的状态，被当成了自己的。**

**这一件是决定，不是整理**：修它要么每个 goroutine 一条连接（那么事务里的每一条语句也得用那条连接，而现在是直接打 `k.Db` 的），要么把**所有**写都串行化到同一把锁后面（那么整个 daemon 的写都排队）。两条都动 `TaskStore` 的接口与面。**这一轮把事实与代价摆出来，没有动。**
