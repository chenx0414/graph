# 代码库结构深化的门禁证据（2026-10-22）

配套文档：[架构深化计划与证据](architecture-deepening-2026-10-22.md)——那里记着每一步做了什么。

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

**本分支改动过的文件现在都在守卫上限之内**：kernel 层与节点泳道那几个文件最大的一个是 `runtime_kernel_graph_lane_host.go` 的 18,856 字节。这不等于整个包都小——`backend/internal/graph` 里另有 **33 个文件超过 20,000 字节**，它们本分支没有改过，因此也不在本文件的证据范围里。

门禁配置在 2026-10-23 变了：`vitest.config.ts` 现在是 `bail: 1` + `maxWorkers: 2`，并且 `check` 走 `scripts/check-queue.py` 串行化各 worktree。因此一次失败会停掉整轮门禁，本文件的失败对照改用 `--bail=0` 跑完整套，再与未改动的 main 逐项对照。

`tests/e2e/node-budget.test.ts` 断言结算后节点的 `used: 50, reserved: 0`，正是第三条改动的两条路径。
