# Graph harness 内核版本追踪：2026-10-23

[返回总报告](harness-token-efficiency-2026-10-22.md) · [返回验证与证据](harness-token-efficiency-2026-10-22-verification.md)

这一段原本写在验证文档里。**它讲的是另一件事**——上游内核什么时候发布了什么、报告里那句警告当时对不对、现在还成不成立——所以单独成篇，验证文档只留一个指针。

**2026-10-22 那轮门禁唯一红的那一项，现在已经绿了，而原因不在本分支**：红的是 `tests/e2e/pig-kernel-update.test.ts :: the updater pins the kernel in an isolated checkout...`。这项测试把内核钉到**最新发布版**（PiG v0.5.3），而写报告时模块代理上**还没有** `extensions/sdk v0.5.3`。

**这条警告当时是对的，现在不成立了，而"对"与"不对"的分界可以查**——模块代理的 `@v/<版本>.info` 端点带发布时间戳：

| 版本 | 发布时间（UTC） | |
| --- | --- | --- |
| `extensions/sdk v0.5.0` | 2026-10-19T14:36:35Z | |
| `extensions/sdk v0.5.1` | 2026-10-19T19:20:06Z | **报告写作时的最新版** |
| `extensions/sdk v0.5.2` | 2026-10-22T12:45:23Z | |
| `PiG v0.5.3` | 2026-10-23T05:12:06Z | |
| `extensions/sdk v0.5.3` | 2026-10-23T05:12:06Z | 与主模块**同一刻**发布 |

**报告写于 2026-10-22 约 15:05（CST）= 07:05Z**：那时 `extensions/sdk` 的最新版是 v0.5.1，**v0.5.3 根本还不存在**，所以"上游没发布 extensions/sdk v0.5.3、`go mod tidy` 因此 404"这个结论当时成立。

**但那一段列的版本清单是错的**：写的是"只有 v0.2.0、v0.3.1、v0.4.0、v0.4.1、v0.5.1"，**漏了 v0.3.0 和 v0.5.0**（两个都是 10-19 发布的，早于写作时点）。清单不全，结论对。

**现在是 2026-10-23**：主模块与 `extensions/sdk` 的 v0.5.3 在 2026-10-23T05:12:06Z 一起发布，**同一份测试现在 2/2 全绿**（12.2 秒）。所以"内核更新器的'钉到最新'这条路现在是断的"这句话**已经不成立**——**上一版报告里那句警告已按实测改写在这里**。

仓库钉的仍是 v0.5.1（`node scripts/pig-kernel-update.mjs` 报 `pinned: v0.5.1` / `latest: v0.5.3`），本分支对 `backend/go.mod`、`backend/go.sum` 与 `scripts/pig-kernel-update.mjs` **零改动**（`git diff main...HEAD -- backend/go.mod backend/go.sum scripts/pig-kernel-update.mjs` 为空）。
