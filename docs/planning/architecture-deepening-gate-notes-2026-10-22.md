# 门禁的注记（2026-10-22）

配套文档：[架构深化计划与证据](architecture-deepening-2026-10-22.md) · [后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [v1 的表也有了主人](architecture-deepening-v1-tables-2026-10-22.md) · [表归属这一层，还剩什么](architecture-deepening-table-owners-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [v1 的表也有了主人](architecture-deepening-v1-tables-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [归属那轮的门禁](architecture-deepening-gate-ownership-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)[后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [门禁的注记](architecture-deepening-gate-notes-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)——那里记着每一步做了什么。

这一份是**门禁证据那张表背后的注记**：每一次失败是什么、每一次拆分怎么证明的、以及几条方法上的教训。

**六次拆分全部是纯搬移**：每一次都用两种方式证明过——脚本在写任何文件之前先确认各段接起来与原文件逐字节相同，写完之后再用另一段代码独立地比对一次，两次都报 `identical: True`。







**二十九次拆分没有一次靠推理**：每一次都用两种方式证明过是纯搬移——脚本在写任何文件之前先确认各段接起来与原文件逐字节相同，写完之后再用另一段代码独立地比对一次，两次都报 `identical: True`。**守卫每一次都正常跑过，一次 `--no-verify` 都没用。**



**本分支改动过的文件现在都在守卫上限之内**：kernel 层与节点泳道那几个文件最大的一个是 `runtime_kernel_graph_lane_host.go` 的 18,856 字节。这不等于整个包都小——`backend/internal/graph` 里另有 **33 个文件超过 20,000 字节**，它们本分支没有改过，因此也不在本文件的证据范围里。



门禁配置在 2026-10-23 变了：`vitest.config.ts` 现在是 `bail: 1` + `maxWorkers: 2`，并且 `check` 走 `scripts/check-queue.py` 串行化各 worktree。因此一次失败会停掉整轮门禁，本文件的失败对照改用 `--bail=0` 跑完整套，再与未改动的 main 逐项对照。


`tests/e2e/node-budget.test.ts` 断言结算后节点的 `used: 50, reserved: 0`，正是第三条改动的两条路径。

## 一次抖动掩盖了一次真回归（2026-10-24）

这一轮把 v1 表的尾巴归位时，**我搬错了产出那一行**：语句里的占位符比列多了一个，于是**每一次产出插入都失败**（"expected 31 arguments, got 32"）。

**它伤到了 harness 的教训**：主 Agent 采纳一条教训时要把证据发布成产出，所以**每一条教训都存不进去**，下一个 task 自然读不到「这个项目以前的运行学到了什么」。`tests/e2e/harness-prompt.test.ts` 抓住了它。

**而它一开始看起来像是那台机器的抖动**。那个测试本来就在分支的「满载会超时」名单里，失败的样子也像——**第一反应是「又一个负载超时」**。它不是：它在**机器空着的时候单独跑，也一样失败**，而且**每次都失败**。

**所以教训有两条**：

- **已知的抖动会掩盖真回归**。分辨它们的办法不是读失败的样子，是**单独跑两遍**：抖动的失败单独跑会过（或者每次不一样），**真失败的单独跑还是那样**。
- **搬语句不能靠眼睛数问号**。修法不是改一个字符，是**把搬过去的语句与它来的那一句逐字符比对**；然后**这一轮搬的每一条语句都用同一个办法查了一遍**——**两百九十七条**，每一条的占位符数与那张表原先有过的那些数对照——**只有一处不同**，而那一处是故意的：`result` 列从「绑一个 nil」改成「字面 NULL」。

**这也说明了为什么门禁值得跑**：它跑的是**真实的门禁**（真守护进程、真 provider、真 SQLite），不是被替身搭起来的测试。**一条教训存不进去**，在单元测试里是看不见的——它只有在**下一个 task 的提示词里**才显形。
