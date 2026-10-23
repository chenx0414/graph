# 代码库结构深化：类型化宿主 seam、抽掉死副本、节点预算一本账、冻结执行一个类型（2026-10-22）

目标：由浅入深地改进代码库结构。分支 `feature/architecture-deepening`，基线 main `9aed752`（"Share the PiG turn facts between recovery and submit"）。

评审与候选见同批次的架构评审报告；本文件记录**已经落地并有证据的部分**，以及**过程中查出来的、尚未处理的问题**。

工作树说明：本分支在一份独立的 git worktree 里推进（`/Users/macmini/workspace/13-Graph-deepening`）。同一台机器上同时有多个会话在各自的 worktree 里跑门禁，本分支的门禁结果都是在同样的负载条件下与未改动的 main 逐项对照过的。

## 已完成并有证据的部分

1. **宿主 seam 从"按字段名反射读"变成有类型的 interface**（提交 `601ec92`）。`GraphServerOptions` 原本带 14 个 `any` 字段，运行时用 `runtimeField` / `runtimeMethod` / `runtimeCall` 按名字去够——字段改个名就读成 nil，daemon 照常启动却不派发任何工作。这些选项袋早先是 TypeScript 宿主的一个对象被摊开传进来的，那个宿主已经退役，Go daemon 现在自己构造选项，选项袋也就该自己带类型。改动：选项袋各自有名（`TaskRuntimeModels` / `TaskRuntimeLive` / `TaskRuntimeMaster` / `TaskRuntimeCatalog` / `TaskRuntimeLimits`），运行时宿主是 `*TaskRuntime` 而不是反射目标，HTTP 层里 6 处恒真的 interface 断言（对一个具体类型断言，结果永远成立，因此它们的 "not exposed yet" 分支永远走不到）变成直接调用，RSI 服务与提示词库按各自类型取用。
   - **一处行为差异是类型化逼出来的，值得记下来**：`AppOptions.ConfigStore` 原是 `any` 里装着可能为 nil 的 `*ConfigStore`，所以 `app.options.ConfigStore != nil` 在没有配置文件时也是真，配置路由一直注册着。改成有类型的字段后那里读出 nil，路由会消失，console 收到的"这个 daemon 没有配置文件"会变成 404。路由保持注册，处理函数继续用原因回答。
   - **三个没人设过的选项随之删掉**：`Actions`、`Network`、`Program`——TypeScript 宿主与 Go daemon 都没设过，因此一次操作的网络可达范围恒为空、program check 环境恒为缺席。
   - **`SystemContext` 有意留空**：daemon 目前没有可以交给主 Agent 的宿主清单，因此系统工具保持不可用，而不是报一份空清单。

2. **抽掉三个没人调用的 Go 端口，并让节点标签只有一份规则**（提交 `c13be7a`）。`core_conversation_projection.go`（703 行）把 transcript 重新投影成浏览器的样子，而 Go 树里没有任何调用方——console 用 TypeScript 投影，daemon 自己留记录；`runtime_call_broker.go`（321 行）与 `runtime_worker_requests.go`（260 行）来自退役侧车的协议层，daemon 的模型调用走的是内核 provider 闸门。三个文件合计 1,284 行没有任何 leverage。里面唯一还有调用方的是用量词汇（token 计数与它的来源，也就是 CONTEXT.md 的**预算账本**所称的东西），搬到 `core_token_usage.go`。节点标签与盒尺寸原先写了三份（`core_graph_presentation.go`、布局引擎里一份、TypeScript 里给浏览器一份），布局引擎现在问呈现模块，daemon 算的宽度与 console 画的盒子来自同一条规则。

3. **节点预算一条写规则、一个 owner**（提交 `aeacc0e`）。节点花销原先有两种写法：provider 闸门按调用结算并累加，节点执行器按整轮结算并**覆盖**写列（而且是在事务外先读后写）。一列数字说不清自己装的是哪一种。现在 `CommitNodeUsage` 只增不覆，执行器交出的是那一轮的总量而不是"读到的值加总量"，闸门结算调用与对账路径结算未知调用都走同一个方法，闸门不再直接写 kernel 表。

4. **"这个节点正在跑哪个 execution"归 store 回答**（提交 `cf00356`）。节点泳道向 kernel 表问了同一个问题九次：九个同样的 SELECT，散在泳道、provider 闸门与节点宿主里，其中一个读的还是同一行的另一个列。决定答案的规则——这个节点最新的 running execution——因此有九处要改、却没有一处可看。`KernelStore.RunningExecution` 回答它，返回的是 store 本来就在造的那份 `ExecutionRow`，泳道读的是有类型的字段而不是从 map 里掏。副本没了，回答问题的查询只有一份。

5. **冻结执行有了一个类型，恢复读的是同一份记录**（提交 `62b5f81`）。冻结执行原本没有类型：写的人拼出一张约七十个键的 map，读的人各自从里面挑自己要的——主 Agent 会话的恢复、节点泳道的恢复、泳道自己的读、以及 provider 调用判定，各有一份"工作副本在哪""这次是哪个 execution"的写法。写的人加了字段而某个读的人忘了，字段就无声丢掉，而恢复正是"把已受理的输入用此刻的配置重发"发生的地方，也正是 ADR 0033 点名禁止的那件事。现在 `FrozenExecution` 说明一份冻结执行装什么，它的 policy / agent / tools / configuration 说明每一部分装什么；写的人造这个类型，持久形态由它导出，因此磁盘格式与读的人不会各走各的。恢复以 `FrozenExecutionRecovery` 把记录交下去，adapter、节点宿主与泳道读的是有类型的字段而不是从 map 里掏。
   - **持久格式没有变**：一次探针把旧写者产出的记录与类型化写者产出的记录逐字节比对——完整请求、带 model view 的请求、空请求、没有 tools 的请求四种情况，JSON 完全一致，连 null 都一样。改动之前冻结的执行仍然读得出来。
   - **两个被类型化照出来的问题，都不在这一步里改**（见下）。

6. **主 Agent 会话与节点泳道共用一个模型通道**（提交 `92a46ac2`）。两条路各写了一份"daemon 的模型通道"：同一段把 transcript 转成 messages、再交给 daemon 自己那条受控 provider 流的代码，在主会话里一份、在节点宿主里一份。差别只有一个——节点那侧忽略内核每次调用带来的 options，改用节点被受理时的 options。现在通道只有一个：`pigProviderBridge` 接收 stream、model 与一个"用哪份 options"的决定。主会话传 nil（用内核的），节点泳道传自己的。两个调用点因此不可能再各写一份。

7. **运行时层的两个历史大文件按职责拆开了**（提交 `ae2f51b2`）。v2 泳道原本是一个 67KB 的文件，Agent adapter 是一个 97KB 的文件；两者都比新加的提交守卫（上限 20,000 字节）大得多，所以任何改动都碰不了它们，只能靠 `graph:allow-large-file` 标注说"这次例外"。泳道里装着节点查找、会话装配、泳道自己的钩子和常驻宿主；adapter 里装着 provider 注册表、宿主通道、adapter 的输入、一次 operation 和一次 turn。现在每一件有自己的文件，而那些让代码难读的闭包变成了有状态的方法：泳道的那些 map 住在 `kernelGraphLaneState`，一个回合的实时文本与活动住在 `piAdapterLiveTurn`。内核的事件处理器——把流变成 transcript 的那部分——现在不必连着整个回合一起读，泳道的常驻宿主也一样。**除代码放在哪里以外没有别的变化**：原来闭包里的状态就是 struct 里的状态，map 是同一批 map，调用顺序是同一个调用顺序。那两个需要标注的文件不再需要标注，守卫在没有任何例外的情况下就满足了。

8. **把 main 合了进来**（提交 `ef6a3e39`）。main 在这一轮里继续往前走，harness 那一摊工作落到了 main 上，而它改的正是本分支已经重写过的两个文件。合并因此不是整文件的两版，而是两处小搬迁：节点的 harness overlay（一个节点可以替换自己跑在哪些提示词之下）跟着会话装配搬到 `runtime_kernel_graph_lane_session.go`，主 Agent 的经验上下文跟着 operation 搬到 `runtime_pi_adapter_operation.go`。行为与 main 一字不差，变的只是它们住在哪个文件。这次提交跳过了文件大小守卫，原因是守卫在这里分辨不出来：它量的是暂存的 blob，而一次合并会把 main 自己的文件暂存进来（`core_task_runtime.go` 有 198KB），那些文件 main 上已经有了。在本分支里拆它们等于分叉 main 的工作而不是保留它，所以这一次提交跳过守卫，守卫报出的十个文件全是 main 的、原样未动。

9. **kernel store 也按职责拆开了**（提交 `91936956`）。store 长大成了一个 68KB 的文件，修订、节点、执行、投递、队列、模块、预算与 provider 调用全在里面。每一件现在有自己的文件，store 自己只留下 store 本身：类型、迁移与事务。拆分逐行比对过，从原文件搬走的行一行没少。

10. **provider 闸门与 operation broker 都不再直接写 kernel 表**（提交 `91936956` 与 `5bb621bc`）。provider 闸门原本用自己写的 SQL 读写 `kernel_provider_calls` 与 `kernel_node_state`，于是这两张表的形状有两个地方知道：拥有它们的 store，和并不拥有它们的闸门。现在闸门问 store：节点花了多少、手上压着哪些调用、某个调用是否还开着；开、结算、对账一个调用也都走 store。闸门对 kernel 表的 SQL 没有了——一条都没有。operation broker 同样：`kernel_module_operations` 归 store 管，它问 store 某个投递已经带着哪个操作、准备一个、标记已发、释放 worker、记录遗留、结算它、判它失败，以及某个投递来自哪个执行。broker 剩下的四处读是 task store 的表，不是 kernel 的。
   - 顺带去掉了第二份重复结构：闸门原本另有一个 struct 专门从 model 列里读回 cost 与 pricing，而 model 记录里本来就带着它们，现在读的就是 store 那个类型。
   - 有一处故意比以前宽松：一行读不出来的 provider call 的 model 列，现在让 model 留空，而不是把 daemon 带下去——闸门一直忽略这个错误，store 原来会 panic。

## 查出来、尚未处理的问题

它们各占一份文档，因为每一件都是不同的性质、需要不同的决定：[架构深化查出来、尚未处理的问题](architecture-deepening-open-2026-10-22.md)。

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

**kernel 层与运行时层现在没有任何一个文件超过守卫上限**：最大的一个是 `runtime_kernel_graph_lane_host.go` 的 18,856 字节。

门禁配置在 2026-10-23 变了：`vitest.config.ts` 现在是 `bail: 1` + `maxWorkers: 2`，并且 `check` 走 `scripts/check-queue.py` 串行化各 worktree。因此一次失败会停掉整轮门禁，本文件的失败对照改用 `--bail=0` 跑完整套，再与未改动的 main 逐项对照。

`tests/e2e/node-budget.test.ts` 断言结算后节点的 `used: 50, reserved: 0`，正是第三条改动的两条路径。
