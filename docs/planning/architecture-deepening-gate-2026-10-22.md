# 代码库结构深化的门禁证据（2026-10-22）

配套文档：[架构深化计划与证据](architecture-deepening-2026-10-22.md) · [后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [一张表一个主人](architecture-deepening-one-owner-per-table-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [尚未处理的问题](architecture-deepening-open-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)——那里记着每一步做了什么。

## 门禁证据

`node --run check`（`check:backend` + `typecheck` + `lint` + `test:report` + `check:baseline` + `check:evidence`）在本分支各步之后运行。这台机器上同时有五个会话在跑各自的门禁，负载平均一度到 83，满负载下 `node --run check` 会有大批用例如超时失败——因此每一次失败都逐项与**未改动的 main**在同一台机器、同样负载下对照过：

| 提交 | 门禁 | 结论 |
| --- | --- | --- |
| `601ec92` | 287 个文件里 285 通过、1 跳过、1 失败 | 唯一失败是 `tests/m1/recovery.test.ts`（15 秒超时、TypeScript 侧），单独重跑通过；同一份未改动 main 在同样条件下也失败 |
| `c13be7a` | 287 个文件里 281 通过、1 跳过、5 失败 | 5 个失败文件单独重跑时 3 个转为通过；剩下 2 个在未改动的 main 上同样失败 |
| `aeacc0e` | 满负载下 42 个文件失败 | 抽 6 个与本次改动无关的失败文件重跑，两个分支都是 61/61 通过；覆盖节点预算的 `tests/e2e/node-budget.test.ts`、`tests/m8/kernel-node-budget.test.ts`、`tests/m8/node-executor.test.ts` 在满负载那一次里就是通过的 |
| `8c74ef8` | **286 通过、1 跳过、0 失败**；"Suite matches the baseline (files 287, tests 1549)"；"Acceptance evidence is unchanged" | 在另一份干净 worktree 上跑本分支的已提交状态，机器空载（负载平均 7） |
| `cf00356` | 287 个文件里 283 通过、1 跳过、3 失败 | 3 个失败文件单独重跑，在本提交上 3 个全过；同一个 `tests/durable/recovery.test.ts` 在上一个提交 `ff8e580` 上同样失败 |
| `62b5f81` | 287 个文件里 280 通过、1 跳过、6 失败 | 6 个失败文件单独重跑，在本提交上 6 个全过（51/51）；覆盖本次改动的 `tests/e2e/pig-durable-recovery.test.ts`、`tests/e2e/pig-node-recovery.test.ts`、`tests/e2e/pig-node-lane.test.ts` 在满门禁那一次里就是通过的 |
| `92a46ac2` | **286 通过、1 跳过、0 失败**（1546 个测试） | 在一份干净 worktree 上跑本分支的已提交状态，与**未改动的 main 同时跑**（同一台机器、同一套 vitest 配置、同样 `--bail=0`）：未改动的 main 同样是 0 失败（287 通过、1 跳过），两边的判定一致 |
| `ae2f51b2`（拆分运行时层） | **286 通过、1 跳过、0 失败**（1546 个测试） | 同样与未改动的 main 同时跑：main 也是 0 失败（292 通过、1 跳过、1551 个测试；main 又前进了几个提交，所以文件数更多）。拆分前另有 11 个泳道与回合的 E2E 文件先跑过一遍，76/76 通过 |
| `ef6a3e39`（合入 main） | 294 个文件里 292 通过、1 跳过、1 失败 | 唯一失败是 `tests/e2e/command-output-preservation.test.ts`，满负载下超时；单独重跑时它在 main 与本分支上都通过（3/3） |
| `91936956` + `5bb621bc`（拆 store、闸门与 broker 归 store） | **293 通过、1 跳过、0 失败**（1552 个测试） | 拆 store 之前另有 10 个 kernel 路径的 E2E（node-budget、kernel-node-budget、node-executor、pig-node-recovery、pig-node-lane、graph-modules、kernel-git-integration、loops、faults、execution）跑过一遍 67/67 通过；改 broker 之后另有 8 个模块路径的 E2E 跑过一遍 58/58 通过 |
| `cf1135b8`（节点恢复归 store） | 见下一行 | 改之前另有 6 个恢复路径的 E2E（pig-node-recovery、pig-durable-recovery、node-executor、recovery、faults、pig-node-lane）跑过一遍 41/41 通过 |
| `037a66f6`（拆 kernel views） | **293 通过、1 跳过、0 失败**（1552 个测试） | 拆 views 之前另有 6 个视图路径的 E2E（go-graph-view、pig-node-lane、kernel-git-integration、execution、graph-final-acceptance、node-executor）跑过一遍 51/51 通过 |
| `cf1135b8` + `213bfa9f`（节点恢复归 store、记下剩下的归属缺口） | **293 通过、1 跳过、0 失败**（1552 个测试） | 改之前另有 6 个恢复路径的 E2E（pig-node-recovery、pig-durable-recovery、node-executor、recovery、faults、pig-node-lane）跑过一遍 41/41 通过 |
| `f45dcef2` + `d426952d`（tasks 表归 store） | **293 通过、1 跳过、0 失败**（1552 个测试） | 在一份干净 worktree 上跑本分支的已提交状态，机器负载平均 8 |
| `2a5b23fb`（任务闸门归 store） | **293 通过、1 跳过、0 失败**（1552 个测试） | 同一份干净 worktree 上跑已提交状态，用仓库自己的 vitest shim（`--bail=0`），539 秒 |
| `2c7d7e5a` + `8d750d38` + `bac1d6bf`（工具闸门、泳道读与写归 store） | **293 通过、1 跳过、0 失败**（1552 个测试） | 同一份干净 worktree 上跑最终 head（`bac1d6bf`），672 秒，机器负载平均 10；改之前另有 9 个泳道与恢复路径的 E2E（pig-node-lane、pig-node-recovery、pig-durable-recovery、node-budget、graph-modules、graph-lane、graph-lane-run、kernel-node-budget、node-executor）跑过一遍 50/50 通过 |
| `32fb586a`（questions 表归 store） | 294 个文件里 293 通过、1 跳过、**1 失败** | 唯一失败是 `tests/e2e/harness-prompt.test.ts`（"a lesson claimed on the general axis…"），满负载下的超时型失败；**单独重跑通过**，它讲的是经验沉淀，与本轮改动无关 |
| `e7971253`（拆能力文件） | **293 通过、1 跳过、0 失败**（1552 个测试） | 在一份干净 worktree 上跑已提交状态（708 秒），**与未改动的 main 同时跑**（700 秒，同样负载）：main 也是 293 通过、1 跳过、1552 个测试、0 失败，**两边的判定一致**；上一轮那个 harness-prompt 的失败在这一次两边的完整套里都没有再出现 |
| `293716eb`（再拆五个文件：用量、自改进、提示词库、受控 provider、对话） | **293 通过、1 跳过、0 失败**（1552 个测试）；"Suite matches the baseline (files 294, tests 1556)" | 在一份干净 worktree 上跑最终 head（`293716eb`），604 秒；`check:backend`、`typecheck`、`lint`、`check:baseline`、`check:evidence` 同时全部通过 |

**六次拆分全部是纯搬移**：每一次都用两种方式证明过——脚本在写任何文件之前先确认各段接起来与原文件逐字节相同，写完之后再用另一段代码独立地比对一次，两次都报 `identical: True`。

| 提交 | 门禁 | 结论 |
| --- | --- | --- |
| `e7971253` … `45f43f73`（二十三次拆分） | **293 通过、1 跳过、0 失败**（1552 个测试）；"Suite matches the baseline (files 294, tests 1556)"；"Acceptance evidence is unchanged" | 在一份干净 worktree 上跑最终 head（`45f43f73`），543 秒；`check:backend`、`typecheck`、`lint`、`check:baseline`、`check:evidence` 同时全部通过。二十九次拆分合起来动了 285 个 Go 文件，因此这一次门禁跑的是整个拆分战役之后的状态 |
| `98d18e59`（拆工具表） | 294 个文件里 293 通过、1 跳过、**1 失败** | 唯一失败是 `tests/e2e/pig-kernel-update.test.ts`（"the backend pins a published PiG kernel…"），**满负载下的网络超时**：该测试驱动 `scripts/pig-kernel-update.mjs` 走**真实的模块代理**与真实的 Go 工具链（它自己的注释写着"nothing here fakes a release, a download or a compiler result"），全程不启动 daemon；它在完整套里花了 14,370 毫秒，**单独重跑只花 1,683 毫秒并通过**。拆工具表只改了 Go 文件的布局，与这个测试无关 |
| `98d18e59`（拆工具表，重跑） | 294 个文件里 293 通过、1 跳过、**1 失败** | 唯一失败换成了另一个：`tests/e2e/go-wake-notification.test.ts`（"a confirmed graph wakes main with the graph id"，31,682 毫秒，超时），**单独重跑只花 3,228 毫秒并通过**。两次运行各有一个不同的超时，两次单独重跑都通过 |
| `426bd2cb`（两条工具表合成同一套规则） | **294 通过、1 跳过、0 失败**（1553 个测试）；"Suite baseline increased to files 295, tests 1557"；"Acceptance evidence is unchanged" | 在一份干净 worktree 上跑最终 head，632 秒。新增的 `tests/e2e/pig-node-tool-telemetry.test.ts` 就在这一套里——**它在父提交上失败**（节点那次 read 根本不出现在统计表里），在这个提交上通过 |
| 未改动的 main（同一台机器、同样负载） | **293 通过、1 跳过、0 失败**（1552 个测试） | 与本分支的两次运行同时跑，main 一次都没失败；本分支那两次失败都是满负载下的超时，且两次单独重跑都通过 |
| `eb60abc7`（把剩下的冻结字段也还原） | 298 个文件里 296 通过、1 跳过、**1 失败**（连跑两次，两次各有一个失败，都是那一个网络测试） | 唯一失败是 `tests/e2e/pig-kernel-update.test.ts`，而它**在未改动的 main 上一样会失败**：连跑三次，本分支 1 过 2 败，**未改动的 main 1 过 2 败 1 过**——同一个测试、同样的失败，因为 `go list -m -versions` 要访问 `proxy.golang.org`，而那条连接会随机断（`Get "https://proxy.golang.org/…": EOF`）。它与本次改动无关 |
| `06373560`（合入 main 的最后一个提交后的最终状态） | 299 个文件里 **297 通过、1 跳过、1 失败**（1557 个测试） | 唯一失败是 `tests/m0/restricted-process.test.ts`（依赖安装在授权内进行），**未改动的 main 上以同样的方式、同一个临时目录、同一个 ENOENT 失败**——当时记为「这台机器的环境问题」，**后来查明不是**：main 已经修了它（npm 12 拦截 install script），分支只是还没合那次修复，见 `b8c7cc1` 那行。这一轮里模块代理那个测试与探针比较那个测试都通过了 |
| `feab0cf7`（合入 main 的最后一个提交） | 299 个文件里 296 通过、1 跳过、**2 失败** | 两个失败都**不是**本次改动带来的：<br/>· `tests/m0/restricted-process.test.ts`（依赖安装在授权内进行）——**未改动的 main 上以同样的方式失败**（同一个 ENOENT，同一个临时目录），当时记为「这台机器的环境问题」——**后来查明是 main 上游的修复没合进来**，见 `b8c7cc1` 那行<br/>· `tests/e2e/harness-axes.test.ts`（探针比较两个 harness 轴）——**单独重跑三次全过**，它在前两次的完整套里也是过的，是满负载下的超时<br/>另外 `tests/e2e/pig-kernel-update.test.ts`（模块代理）在这一轮里通过了 |
| `6df12b5c`（main 又合了一次 harness 的活） | **296 通过、1 跳过、0 失败**（1556 个测试） | 在一份干净 worktree 上跑合并后的 head，541 秒。**同样的查法**：main 新增的每一行都拿到合并后的树里去找，找不到的数是零（只剩 baseline 的计数，那由门禁自己重算）。合并之后 **main 是本分支的祖先** |
| `45b66d4c`（合入 main 的十三个 harness 提交） | **296 通过、1 跳过、0 失败**（1556 个测试）；"Suite baseline increased to files 297, tests 1560"；"Acceptance evidence is unchanged" | 在一份干净 worktree 上跑合并后的 head，547 秒。**合并本身是查过的**：main 自分支分叉以来新增的每一行都拿到合并后的树里去找，**找不到的是零**（第一次合并时是 174 行）。第一次合并后完整套里有一个失败（`tests/e2e/harness-axes.test.ts` 读不到候选跑在哪个 harness 下），那正是漏掉的那处改动 |


| `07ef0b92` … `4c821127`（kernel 表的写只有一个主人） | 300 个文件里 **299 通过、1 跳过、1 失败**（1563 个测试）；"Suite baseline increased to files 300, tests 1563"；"Acceptance evidence is unchanged"；`check:ownership` 通过 | 完整套 502 秒。**唯一失败是 `tests/m0/restricted-process.test.ts`——而它不是环境问题**：main 已经修了它（npm 12 拦截 install script，除非项目按名字允许那一个），分支还没合那次修复，见下面最后一行 |
| `bd063ba4`（内核表有了一道守卫） | 同上一行 | 守卫**试过自己能不能失败**：拿一个有写的文件试，它报出文件、行与表名；拿一个只提到表的**注释**试，它没有报。它**暂时不进 `node --run check`**，因为 main 与并行的分支仍有几十处越界写，而门禁与 Hook 是所有工作树共用的 |
| `9d2a7480`（一条状态查询不带 task id 就崩） | 同上一行 | 新增的 `tests/e2e/task-status-without-task-id.test.ts` **在父提交上失败**（模型读到 `runtime error: invalid memory address or nil pointer dereference`），在这个提交上通过。**第一版那份 E2E 驱动的是 TypeScript 守护进程，在 TypeScript 上通过**——把测试指向 Go daemon 之后它才说得上话 |
| `8d670c3c`（文档按主题拆开） | 同上一行 | 门禁**第一次拦下**这两份文档（21,224 与 25,464 字节，超 20,000 的上限）。**拆，不求例外**：未处理的问题与已经处理的问题分成两份，工具表/main 的合入/冻结执行另占一份，七份文档互相链接 |
| `b8c7cc1`（合入 main 的两个提交） | 301 个文件里 **299 通过、1 跳过、1 失败**（1564 个测试）；"Suite baseline increased to files 301, tests 1564"；"Acceptance evidence is unchanged" | 完整套 498 秒。**唯一失败换了一个**：`tests/e2e/go-wake-notification.test.ts`（"a confirmed graph wakes main with the graph id"），满负载下的超时，**单独重跑只花 2,552 毫秒并通过**——分支以前也撞见过它。而上一行那条 `restricted-process` 的失败**被 main 的修复带走了**。合并用分支的老办法查过：main 自分叉以来新增的每一行都拿到合并后的树里去找，**找不到的只有 baseline 自己的计数**（门禁重算它）。合并后 **main 是本分支的祖先** |

| `b8c7cc1`（合入 main 的两个提交，**再跑一次**） | 301 个文件里 **300 通过、1 跳过、0 失败**（1564 个测试）；"Suite matches the baseline (files 301, tests 1564)"；"Acceptance evidence is unchanged" | 完整套 497 秒，**这一次全绿**。上一轮那个 `go-wake-notification` 的超时因此确认是满负载下的抖动（它单独跑只要 2,552 毫秒），不是本分支的问题 |
**二十九次拆分没有一次靠推理**：每一次都用两种方式证明过是纯搬移——脚本在写任何文件之前先确认各段接起来与原文件逐字节相同，写完之后再用另一段代码独立地比对一次，两次都报 `identical: True`。**守卫每一次都正常跑过，一次 `--no-verify` 都没用。**
| `6161e550` … `20c61fc0`（`nodes` 表也有了主人） | 301 个文件里 **300 通过、1 跳过、0 失败**（1564 个测试）；"Suite matches the baseline (files 301, tests 1564)"；"Acceptance evidence is unchanged"；`check:ownership` 通过 | 完整套 502 秒，**全绿**。这一轮改的是**谁写哪张表**，不是写什么：18 处节点状态、3 处规格与 activation、2 处产出、4 处时钟都搬进了 task store，`nodes` 表在 store 之外只剩 schema 迁移与那次跨表退役（两处都写明了为什么） |

| `f77e7674`（节点的那一轮（`activations` 表）也有了主人） | 301 个文件里 299 通过、1 跳过、**1 失败**（1564 个测试） | 唯一失败是 `tests/e2e/harness-composition.test.ts`（"a second probe starts from the harness the project already adopted"），满负载下的超时：它在完整套里花了 **120,346 毫秒**却没拿到比较结果，**单独重跑只花 1,010 毫秒并通过**。它讲的是 harness 探针的比较，与本轮改动无关（本轮改的是**谁写哪张表**） |
**本分支改动过的文件现在都在守卫上限之内**：kernel 层与节点泳道那几个文件最大的一个是 `runtime_kernel_graph_lane_host.go` 的 18,856 字节。这不等于整个包都小——`backend/internal/graph` 里另有 **33 个文件超过 20,000 字节**，它们本分支没有改过，因此也不在本文件的证据范围里。
| `b616bb83`（`instances` 表（节点跑在哪个 runtime 上）也有了主人） | 301 个文件里 **300 通过、1 跳过、0 失败**（1564 个测试）；"Suite matches the baseline (files 301, tests 1564)"；"Acceptance evidence is unchanged"；`check:ownership` 通过 | 完整套 540 秒，**全绿**。`instances` 原先由 7 个文件各自写着 SQL；额度那几列本来只有账本一个人写（`budget_scopes` 也是），所以这一步消掉的是**身份那一面**的分散：执行、对话、任务运行时四个地方原先各自写着 instance 的 model 与 definition |
| `f77e7674`（节点的那一轮，**再跑一次**） | 301 个文件里 **300 通过、1 跳过、0 失败**（1564 个测试）；"Suite matches the baseline (files 301, tests 1564)"；"Acceptance evidence is unchanged"；`check:ownership` 通过 | 完整套 500 秒，**这一次全绿**。上一轮那个 `harness-composition` 的超时因此确认是满负载下的抖动（它单独跑只要 1,010 毫秒），与本轮改动无关 |
| `64cf797`（合入 main 的「用真模型评判 harness」） | 302 个文件里 **301 通过、1 跳过、0 失败**（1565 个测试）；"Suite baseline increased to files 302, tests 1565"；"Acceptance evidence is unchanged"；`check:ownership` 通过 | 完整套 **全绿**。合并用分支的老办法查过：main 自分叉以来新增的每一行都拿到合并后的树里去找，**找不到的只有门禁账本自己的计数与哈希**（门禁重算它们）。main 新增了一个测试文件，因此文件数 301→302、测试数 1564→1565 |

| `0b9bad7e` + `c87ad1ea`（`operations` 表（一次 operation）也有了主人；守卫认得两种主人） | 302 个文件里 **301 通过、1 跳过、0 失败**（1565 个测试）；"Suite matches the baseline (files 302, tests 1565)"；"Acceptance evidence is unchanged"；`check:ownership` 通过 | 完整套 **全绿**。`operations` 原先由 **11 个文件**各自写着 SQL，是 v1 里散得最开的一张表；守卫现在逐个点名了**模块自己的表**（`wake_intents`、`tool_calls`、`git_commits` 等），它们本来就只由一个文件写 |
门禁配置在 2026-10-23 变了：`vitest.config.ts` 现在是 `bail: 1` + `maxWorkers: 2`，并且 `check` 走 `scripts/check-queue.py` 串行化各 worktree。因此一次失败会停掉整轮门禁，本文件的失败对照改用 `--bail=0` 跑完整套，再与未改动的 main 逐项对照。
| `e3f37853` + `670ab552`（对话域的三张表都有了主人） | 302 个文件里 **301 通过、1 跳过、0 失败**（1565 个测试）；"Suite matches the baseline (files 302, tests 1565)"；"Acceptance evidence is unchanged"；`check:ownership` 通过 | 完整套 **全绿**。`conversations`（3 个文件）、`proposals`（2 个）、`messages`（2 个）一组一起做——**这一组是彼此相关的** |

`tests/e2e/node-budget.test.ts` 断言结算后节点的 `used: 50, reserved: 0`，正是第三条改动的两条路径。
