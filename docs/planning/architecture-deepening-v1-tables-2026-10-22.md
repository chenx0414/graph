# v1 的表也有了主人（2026-10-22）

配套文档：[架构深化计划与证据](architecture-deepening-2026-10-22.md) · [后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [v1 的表也有了主人](architecture-deepening-v1-tables-2026-10-22.md) · [表归属这一层，还剩什么](architecture-deepening-table-owners-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [v1 的表也有了主人](architecture-deepening-v1-tables-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)

这一份接着[一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md)往下走：**v1 那些散在各处的表，一张一张都有了主人**。

35. **git 那一族有了主人**（提交 `28b822b5`）。`git_ops` 记着宿主对仓库做的一次操作，`worktrees` 记着那些操作跑在哪个工作副本里。两张表原先由 **5 个文件**各自写着 SQL。
    - **git 操作真有的规则**：记下它要跑什么，然后以 blocked、failed 或 succeeded 结束，并留下它做出来的东西。**有一条规则比别的宽**：当一个 task 的 HEAD **已经是**它的目标时，**那个 task 的每一次交付一起结算**——因为它们都到了同一个地方。
    - **工作副本真有的规则**：task 的集成副本（**被替换**、或**首次登记**），以及某个节点的副本（**已经在那儿就留着**）。一个结束的 task **释放**它的副本。
    - **git 模块之外唯一写这两张表的地方是项目准备那条路**，它现在问模块。
36. **`runtime` 那一行与 `projects` 有了主人**（提交 `5001462e`）。`runtime` 是那一行，说着**守护进程此刻在做什么**：哪个 task 是当前的、运行时到了第几代。`projects` 是一个项目：它住在哪个根上、有什么授权。
    - **当前 task 需要两条规则而不是一条**，因为它**可以被清空**，也可以被设上——**清空它的那处正是说这件事的地方**。
37. **产出那一行写了一遍**（提交 `6ce5f692`）。两个地方发布产出时，各自把**整行**用 SQL 写了出来：**31 列，两处一模一样**。现在这一行写一次，而且**调用方用列名说哪个值属于哪一列**。
    - **这就是「一行」存在的意义**：一个知道产出有 namespace、有 digest、有 producer 的调用方，**不该同时知道 namespace 是第七列、digest 是第十列**。
    - **列的编码也跟着搬过去了**：tags 与 metadata 是 JSON，**store 现在编**——**一列的编码是这张表形状的一部分**。
38. **最后几张表有了主人，而守卫抓到了自己的一个洞**（提交 `1db7143c`）。命令回执、task 的能力授权、kernel 的图布局——三张表原先各自由不止一处写。
    - **命令回执本来就是 store 的**（store 记下它，好让重复的请求拿到同一个答案），**项目准备那条路现在问 store**。
    - **图布局是 kernel store 的，而两个写者里有一个整个在 store 之外**。
    - **那一条是守卫自己抓到的，而它抓得到，是因为守卫有个洞**：它的正则读 `INSERT INTO`，**没读 `INSERT OR IGNORE INTO` 与 `INSERT OR REPLACE INTO`**。**冲突子句也是语句的一部分**，于是有一处 store 之外的写**一直没被看见**。**正则补上之后，它立刻抓到了那条**——**抓住它的正是它被写出来要做的那件事：读 SQL，而不是读名字**。
    - **一个抓不到东西的守卫不是守卫**，而这一个一直在安静地失败。这一点值得记下来。
    - **保留期清扫一次删好几张表**，那是**关于许多张表的一个事实**，因此它在文件头上写明了。

## 查出来、尚未处理的问题

它们各占一份文档，因为每一件都是不同的性质、需要不同的决定：[架构深化查出来、尚未处理的问题](architecture-deepening-open-2026-10-22.md)。

## 门禁证据

每一次门禁的结果记在另一份文档里：[架构深化门禁证据](architecture-deepening-gate-2026-10-22.md)。
