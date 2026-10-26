# 批次 55

    - **两条直开 TypeScript 运行时的门禁用例随实现退休，缺口照实记在案**：`tests/m8/execution-drive-liveness.test.ts`（在子进程里开 TypeScript 的 drive loop，证明「图在派发前等待时不会饿死事件循环、等待解除后同一笔投递仍然被消费」）与 `tests/m8/host-command-lifecycle.test.ts`（直接 `import { runHostCommand } from 'src/runtime/host-command.ts'`，证明「宿主命令在主人死去 / 显式中止 / 超时时都会停」）。两份证明写的是**被删掉的那套实现**，因此随实现退休；它们承载的两条产品契约在 Go 侧**尚无 E2E 证明，记在案**——Go 的对应实现点是 `backend/internal/graph/core_execution.go` 的 drive 循环与 `backend/internal/graph/runtime_host_command.go:173` 的 `RunHostCommand`（超时、中止信号、主人断开三条都在）。这一条不装作已覆盖。
    - **补回两条在案的 keeper（批次 55）**：批次 54 记下的缺口里，有两条可以由 Go 自己证明，现在各有一条新用例。
    - **沉淀产物的形状规则**（`tests/e2e/go-sediment-skill.test.ts`，1 条）：真实的 master 回合用真工具换来一次真实评审，评审提出的东西**要么**按规则落成项目自己的技能（`created-by: graph-agent`、描述写明何时用、正文原样落盘，下一次评审的 `existingSkills` 里真的能看见它），**要么**一个字节都不写——逃出项目目录的 id、没有「何时使用」的描述、别人写的技能，都被拒，而且**目录也不留**。两次回退证明断言咬得住：不再盖自著声明 → 「落盘带自著声明」那条红；不再要求描述说明何时使用 → 「被拒的没留目录」那条红。
    - **worker 的访问边界**（`tests/e2e/go-node-sandbox.test.ts`，2 条）：**同一份宿主文件**，在标准访问策略下 worker 读不到（拒绝理由是「Path is outside the workspace」，宿主字节一次也没进过模型的任何一次请求，账上把它记成 worker 这一次**失败**的调用）；在完全访问策略下读得到。两条合起来证明的是**边界来自访问策略，而不是那个路径碰巧不存在**。一次回退证明断言咬得住：让所有节点都拿到完全访问 → 标准访问那条立刻读到宿主文件（红）。
    - **drive 循环那条：在 Go 侧由已有的 keeper 承担**。`tests/m8/execution-drive-liveness.test.ts` 证的是 TypeScript 那个 drive 循环「await 只等已结算的活」时不会饿死事件循环，等待解除后同一笔投递仍然被消费。Go 的 drive 循环不是这个形状（它不在一次 provider 调用上同步等待），所以那个**机制**随 TypeScript 一起走了；**看得见的两个事实**由已有的 Go 用例承担：图卡在派发前时 daemon 仍然是活的（`tests/e2e/go-unknown-usage.test.ts` 在节点被未知用量挡住的这段时间里一直读 daemon、一直对账、daemon 都答得上来），等待解除之后**同一笔工作继续跑完**（同一条用例：对账之后节点的下一次调用真的发生、节点真的收尾）。
    - **还差一条，记在案**：`tests/m8/host-command-lifecycle.test.ts` 承载的「宿主命令在主人死去 / 显式中止 / 超时时都停」，在 Go 侧**没有证成，而且要更正上一版的说法**。上一版写的是「显式让图停下之后，宿主命令确实停了（心跳不再增长）」——**这一句站不住**：复查时发现，那次心跳只长了 4 个字节（约 200ms）就冻住了，**冻结发生在「让图停下」之前**：命令跑起来之后，check 模块的产出不是一个合法的 `data` 值，**模块先失败了**，图随即停下，命令是被**模块失败后的取消**带走的，不是被「显式停止」带走的。所以「显式停止会结束宿主命令」**至今没有被证明**，上一版那条用例因此没有落（它证明不了自己要证明的事）。**这一条量过三轮，结论是「不成立」**（下面那段是最终结论；这一句是它前面的一次中间测量，已经被推翻，留在案卷里是为了让改动可追溯）。当时那次独立探针只量了 3 秒窗口，看到心跳又长了 58 个字节，就以为「尾巴约三秒、契约成立」——**那个窗口太短**：命令并没有在三秒后停，它一直活着，60 秒的断言窗口里心跳都在涨。

**这一条最终量出来是「不成立」，而且用例已经写出来了**。用真实 daemon、真实图、真实命令（心跳稳定增长）测三次：SIGKILL 掉 daemon 之后，**命令一直活着**——心跳在整整 60 秒的断言窗口里持续增长（有一次是清理临时目录与残留写入相撞、先报了清理错误，但那说明断言其实过了，所以这条是**时好时坏**，不能当证明）。隔离对照说明**机制本身是好的**：把侧车 worker 单独 fork 起来、让它的主人被 SIGKILL，命令当场就停（心跳冻住）——Node 的 IPC 确实会把主人没了这件事告诉 worker。

**所以缺口在 Go 这一侧**：daemon 被 SIGKILL 时，**那条 socketpair 的父端没有关上**，worker 收不到 EOF，于是 `disconnect → cancel → kill(-pid)` 那条链根本没被触发。试着给 worker 加一道**不依赖 channel** 的兜底（盯住主人的 pid，主人被 reparent 就收手），**不可靠**：三轮测量里时好时坏，说明这条兜底在 daemon 这一侧也没能稳定生效。**因此 keeper 与这个兜底都没有落**：keeper 是红的（它证明的是真实缺口，不能以失败状态进门禁），兜底是没被证实的（不能拿一条时好时坏的修复去换一条契约）。

**还有两处必须说清楚「未证实」**：① 之前说「worker 的四个处理函数一个都没触发」，依据是**没找到** worker 的日志——但**从没确认过 worker 的工作目录**，日志完全可能落在别处，所以「处理函数没触发」**没有成立**；② 说「daemon 硬杀了 worker」也不对——`runtime_host_command.go` 里**根本没有 `Process.Kill()`**（只有 `killTree()`，那是给 worker 发一条 'cancel' 消息），Go 并没有硬杀它。**所以 worker 是自己走的**，走的时候没有把命令带走。

**于是要分辨的就是这两种**：(a) worker 收到了 'disconnect'，它的 `cancel` 也跑了，但 `process.kill(-pid, 'SIGKILL')` **没能杀掉命令那一组**（命令是 worker 用 `detached: true` 起的，独占一个进程组）；(b) worker 是以别的方式结束的，命令压根没收到任何信号。(a) 与 (b) 的判据很干净：**让 worker 把日志写进它自己知道的那个目录——命令的工作目录（`prepared.cwd`）**，命令就在那儿跑，日志就在那儿；再顺带记下 worker 自己的 pid、它的 ppid、以及它起的那个命令的 pid。**命令的 ppid 是 daemon** 这件事也一并解释：worker 退出后，命令被 reparent 到了 daemon（而 daemon 还活着），所以后来 daemon 被 SIGKILL，命令就成了孤儿。

**最硬的一条线索拿到了**：给侧车 worker 装上日志（记录它自己的 pid、ppid、它起的命令的 pid，以及 disconnect / cancel / 命令 close 三个事件），日志**先写进命令的工作目录、再改写 `/tmp`**——**两次都一个字都没有**。而命令确实被起了（心跳在涨）、确实是从这个仓库的 `src/runtime/host-command-worker.mjs` 起的路径（`hostCommandWorkerPath()` 指向它）。**所以：起那个命令的进程，不是 `host-command-worker.mjs`。**

**owner 链量出来了（用唯一文件名做标记，无歧义）**：

```
14315  ppid=1  S  node …/node/bin/node hold-12072-1792755976010.cjs
<- 1    Ss    /sbin/launchd
```

**命令的父进程是 launchd——它已经是一个孤儿。** 也就是说：**起它的那个进程在起完它之后就退了**，命令被 reparent 给了 launchd，从此**没有任何主人**——daemon 死它不死，worker 死它不死，谁都不欠它。

（顺便更正上一版：「命令的父进程是 daemon」这个读法**也是错的**——那次的 ps 过滤词是 `hold.cjs`，**匹配到了别的会话的同名进程**，读到的 ppid 属于别人的进程。这一版用唯一文件名重测，才是对的。）

**命令的「主人」是谁，代码这边已经能读出来了**（这是读码结论，与上面的测量互为印证）：**TS 侧车的 shell 执行器**（`src/runtime/durable-tools.ts` 里那个 `shell`）→ **受限进程**（`src/runtime/restricted-process.ts`）→ 它用 `detached: true` 起 `/bin/sh -c "<launch>"` → 那条命令。

**关键在于：受限进程才是命令的监管人**（超时、取消、主人断开，都由它执行）——但**它没有待在命令跑完**。于是命令成了 launchd 的孩子，**没有任何人负责结束它**：daemon 死它不死，监管人死它也不死。而这条链上真正「该负责」的是受限进程——它本来就是那个角色。

**但真正的机制比这更靠后一层，而且已经查清（测量 + 代码互证）**：Go 侧的沙箱宿主命令走的是一条**全是 exec 的链**——`backend/internal/graph/runtime_restricted_process.go:721` 的 `spawnAndWait` 起 `/bin/sh -c`（`Setpgid: true`）→ 它 exec `sandbox-exec` → 它 exec 内层 `/bin/sh -c` → 它 exec **命令本身**。**exec 会把进程换成目标，pid 不变**，所以整条链只有一个进程：**命令的父进程就是 Go daemon 本身**。测量也对得上：daemon 活着时它是 daemon 的孩子，daemon 被 SIGKILL 之后它被 reparent 给 launchd（ppid=1 ✓），**从此没有任何人负责结束它**。Go 的 `spawnAndWait` 确实在等结果 ✓，但**它自己就是那个监管人**——daemon 一死，监管也跟着没了。

（顺带排除两条：TS 侧车那条 `restricted-process.ts` 的路径**没有参与**——给它装日志，它只有一行「干净退出」，**连「即将起命令」都没有**；Go 的 `host-command-worker.mjs` 那条路径也没参与——worker 的日志两次都空。真正在跑的是 Go 自己那份 `runtime_restricted_process.go` ✓。）

**因此修法只有一个形状**：**命令和 daemon 之间必须隔着一个能比 daemon 活得久的监管人**。仓库里已经有这个形状——`src/runtime/host-command-worker.mjs`：它是独立进程，靠 IPC channel 知道主人没了（channel 的父端随 daemon 一起关掉 → 它收到 disconnect → `cancel` → 杀掉命令那一组）✓，隔离实验里这条路是通的 ✓。所以要么让沙箱路径也走同样的监管人，要么让命令自己盯着 daemon 的 pid。

**但这里要分清两条路径（这决定了改哪里、也决定了该测什么）**：Go 侧有**两种**跑命令的方式——**节点自己的 `bash` 工具**走 `runtime_restricted_process.go`（沙箱里跑，`/bin/sh -c` + `sandbox-exec` 一路 exec，**命令的父进程就是 daemon**）；**图的 `workspace.command` 模块**走 `runtime_kernel_operation_broker.go:338` 的 `RunHostCommand`（**不走沙箱**，由 `host-command-worker.mjs` 当监管人）。**退役的那条 TypeScript 契约（`host-command.ts`：「宿主命令像宿主自己那样跑，不带座位」）说的是后者** ✓——而探针里的 check 模块走的正是后者 ✓，所以**测的是对的那条路** ✓。

那条路上：Go 起 worker ✓ → worker 起命令（`detached`，独占进程组 ✓）→ **worker 随即退出** ✓ → 命令被 reparent 给 launchd（ppid=1 ✓）→ **没有任何人负责结束它** ✓。worker 为什么会退，是这条路上最后要查的一步（它的日志两次都空，说明它没走到我装日志的地方；这本身也是一条线索）。**修法也因此收窄到一处**：worker 必须活到它起的命令结束（它就是那个监管人），或者 Go 不能在命令还在跑的时候关掉那条监管通道。

**最后再分清一次「契约对应哪条路」**（这一步决定 keeper 该怎么写）：退役的那条契约是 TypeScript 的 `host-command.ts`——「宿主命令像宿主自己那样跑，**不带座位**」——它的对应物是 **Go 的 `RunHostCommand`** ✓，而它服务的是**节点自己的 `bash` 工具**（`runtime_kernel_node_host.go` 给节点挂了 `NativeTools: ["bash"]` ✓，走 operation broker ✓）。**探针里的 check 模块走的是另一条**——图的 `workspace.command` 模块 → 受限进程（**带座位** ✓）→ 那条 exec 链 → 命令的父进程是 daemon ✓。**所以探针量的是沙箱那条路，不是契约那条路** ✓。

两条路的现状因此是：
- **沙箱那条（模块的 `workspace.command`）**：命令的父进程就是 daemon ✓，daemon 一死它成孤儿 ✓。**这条与 TypeScript 自己的 `restricted-process.ts` 同构**（那边也是一路 exec ✓），**所以它不是退役带来的回归** ✓。
