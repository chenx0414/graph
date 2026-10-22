# 代码库结构深化：类型化宿主 seam、抽掉死副本、节点预算一本账（2026-10-22）

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

## 过程中查出来、**尚未处理**的问题

1. **系统自模型在 Go daemon 里没有接线**。`GraphServerOptions.SystemContext` 从来没有被设过，因此 `read_system_capabilities`、`inspect_graph_system`、`propose_system_change`、`apply_system_change` 这四个工具对主 Agent 一直不可用。TypeScript 宿主是接了的（`src/server/start.ts:407` 传 `{ systemSummary }`），Go 端口迁移时漏掉。CONTEXT.md 的**系统自模型**把这项列为产品能力，所以这是一个功能缺口，不是设计取舍。补它需要一份 Go 侧的主机清单，属于功能实现而不是结构整理。

2. **节点的"在途占用"记在两个账上**。`kernel_node_state.reserved` 记的是执行器按轮持有的预留，`kernel_provider_calls.reserved` 记的是每次 provider 调用持有的预留。`ReserveNodeTokens` 比预算时只看前者，provider 闸门比预算时只看后者，**两边都没把对方算进来**——一个节点因此可以持有超过预算的量。哪个账本算数是产品决定（收紧额度会让此前能跑完的节点开始被拦），所以本轮只把写入路径统一了，没有动判定。

3. **嵌套事务会死锁，而 `TaskStore.Transaction` 的注释说它会 join**。实现先拿事务锁再看深度，所以从另一个事务里再开一个事务会等一把外层正持有的锁，host 就停在那里。用真实 store 跑的一次探针证实了这一点（探针已删除）。注释现在改成写实际行为，并写明：要在别人事务里跑的 store 方法不该自己开事务（单条语句本身就是原子的），需要多条语句的方法按仓库既有的 `InCurrentTransaction` 命名，让调用方持有事务。**这是下一条候选（把运行时层的裸 SQL 收进 KernelStore）的前置条件**——那些 store 方法会从运行时自己的事务里被调用。

4. **E2E 门禁横跨两套实现**：64 个 E2E 文件里有 27 个仍然驱动已经退役的 TypeScript 守护进程，产品跑的是 Go daemon，门禁因此没有覆盖出厂执行路径。ADR 0033 明写"TypeScript 守护进程本身保留……退役它属于另一件事，本决策不夹带"，所以这件事需要单独一条 ADR，本轮按约定不碰。

## 门禁证据

`node --run check`（`check:backend` + `typecheck` + `lint` + `test:report` + `check:baseline` + `check:evidence`）在本分支各步之后运行。这台机器上同时有五个会话在跑各自的门禁，负载平均一度到 83，满负载下 `node --run check` 会有大批用例如超时失败——因此每一次失败都逐项与**未改动的 main**在同一台机器、同样负载下对照过：

| 提交 | 门禁 | 结论 |
| --- | --- | --- |
| `601ec92` | 287 个文件里 285 通过、1 跳过、1 失败 | 唯一失败是 `tests/m1/recovery.test.ts`（15 秒超时、TypeScript 侧），单独重跑通过；同一份未改动 main 在同样条件下也失败 |
| `c13be7a` | 287 个文件里 281 通过、1 跳过、5 失败 | 5 个失败文件单独重跑时 3 个转为通过；剩下 2 个在未改动的 main 上同样失败 |
| `aeacc0e` | 满负载下 42 个文件失败 | 抽 6 个与本次改动无关的失败文件重跑，两个分支都是 61/61 通过；覆盖节点预算的 `tests/e2e/node-budget.test.ts`、`tests/m8/kernel-node-budget.test.ts`、`tests/m8/node-executor.test.ts` 在满负载那一次里就是通过的 |
| `8c74ef8` | **286 通过、1 跳过、0 失败**；"Suite matches the baseline (files 287, tests 1549)"；"Acceptance evidence is unchanged" | 在另一份干净 worktree 上跑本分支的已提交状态，机器空载（负载平均 7） |
| `cf00356` | 287 个文件里 283 通过、1 跳过、3 失败 | 3 个失败文件单独重跑，在本提交上 3 个全过；同一个 `tests/durable/recovery.test.ts` 在上一个提交 `ff8e580` 上同样失败 |

`tests/e2e/node-budget.test.ts` 断言结算后节点的 `used: 50, reserved: 0`，正是第三条改动的两条路径。
