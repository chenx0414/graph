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

后半程记在另外两份文档里：表的归属在[架构深化的后半程](architecture-deepening-ownership-2026-10-22.md)，二十九次拆分在[拆分战役](architecture-deepening-splits-2026-10-22.md)。
