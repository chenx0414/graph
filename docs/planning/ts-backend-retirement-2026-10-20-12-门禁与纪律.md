# 门禁与纪律

- **契约那条（节点的 `bash` 工具 → `RunHostCommand` → `host-command-worker.mjs`）**：**有监管人** ✓（worker ✓，靠 IPC channel 知道主人没了 ✓，隔离实验里这条路是通的 ✓）——**但 Go 的原生 `bash` 工具是不是也走它，尚未验证**。

**所以 keeper 应该这么写**：让**节点自己的 `bash` 工具**去跑一个长命令（不是 check 模块 ✓），等它真的在跑（心跳 ✓），SIGKILL daemon，断言心跳在有界时间内停。**如果原生 `bash` 工具是直接起命令（没有监管人），它就会像沙箱那条一样成孤儿** ✓——那时的修法就是给它一个监管人（`host-command-worker.mjs` 已经是这个形状 ✓）。

**再更正一处「我给谁装了日志」**：前几轮我给 **TS 的 `restricted-process.ts`** 装日志（它只有一行「干净退出」、没有「即将起命令」），于是我以为「起命令的不是它」——**但真正在跑的是 Go 自己那份 `runtime_restricted_process.go`**（我**没**给它装过日志 ✓，所以当然没有记录 ✓）。**结论不变、依据换了**：起命令的是 **Go 的受限进程** ✓ → 一路 exec（`/bin/sh -c` → `sandbox-exec` → 内层 `/bin/sh -c` → 命令 ✓，`runtime_restricted_process.go:721` ✓）→ **命令的父进程就是 Go daemon 本身** ✓。

**而这条路的形状与 TypeScript 自己的 `restricted-process.ts` 一致**（那边也是 `detached` 一路 exec ✓，命令同样会变成孤儿 ✓）——**所以「命令能在 daemon 死后继续跑」这件事，TypeScript 那边也一样** ✓，**它不是退役带来的回归** ✓。它是一个**两边都有的老问题**，在 Go 侧记成一条独立发现（沙箱路径的命令没有主人）✓；**退役的契约说的是不带座位的那条路** ✓，那条路（`RunHostCommand` + worker 监管人 ✓）**还没单独测过** ✓。

**最后一块拼图（下一轮直接照着写 keeper）**：契约对应的那条路——**不带座位**的 `RunHostCommand`（`runtime_kernel_operation_broker.go:338` ✓，由 `host-command-worker.mjs` 当监管人 ✓）——在今天的默认链路上**走不到**：节点默认跑在 **TS 侧车**里 ✓，它的命令走侧车自己的受限进程（**带座位** ✓）；Go 那份 `RunHostCommand` 是给 **PiG 内核**（`--kernel pig` ✓）的原生工具用的 ✓，而默认是 `--kernel node` ✓。

**所以 keeper 该这么写**：**用 `--kernel pig` 起 daemon** ✓ → 让节点用它的原生 `bash` 工具跑一个长命令 ✓（那才是 `RunHostCommand` ✓）→ 等它真的在跑（心跳 ✓）→ SIGKILL daemon → 断言心跳在有界时间内停 ✓。**如果这条路上命令跟着死了**（worker 的 IPC channel 随 daemon 一起关 → worker 收到 disconnect → `cancel` → 杀掉命令那一组 ✓，隔离实验已证明这条链通 ✓），那么**契约在 Go 侧本来就成立** ✓，只需要把 keeper 落下来；**如果它没死** ✓，修法就是给 PiG 内核那条路也配一个监管人 ✓（`host-command-worker.mjs` 就是现成的形状 ✓）。

**同时记下一条与退役无关的老问题**（两边都有 ✓）：**沙箱路径**（模块的 `workspace.command` → Go 的受限进程 → 一路 exec ✓）里，**命令在 daemon 死后会继续跑** ✓（它成了 launchd 的孩子 ✓）。TypeScript 那边是同一形状 ✓，所以不是退役带来的回归 ✓，但它是一个真实的老问题 ✓，值得单独立一条（命令需要一个能比 daemon 活得久的监管人 ✓）。

**这一条可以结案了，理由如下**。TypeScript 那条契约（`host-command.ts`）说的是**不带座位**的主机命令 ✓——而 TypeScript 的**活的**链路里，主机命令走的也是**带座位**的受限进程 ✓（`restricted-process.ts` 一路 exec ✓）。也就是说：**契约测的那条路，在 TypeScript 那边也不是活链路**；活链路的行为两边一致 ✓（命令在 daemon 死后继续跑 ✓）。

Go 侧同理：**活链路是沙箱那条** ✓（模块的 `workspace.command` → Go 的受限进程 ✓），**不带座位那条（`RunHostCommand` ✓）今天接不到**——它是 PiG 内核原生工具用的 ✓，而 PiG 内核这条路上节点的主机命令**跑不起来**（试过：`--kernel pig` ✓ + 节点给完全访问策略 ✓ + 节点用原生 `bash` 工具 ✓ → **命令压根没被跑** ✓，心跳 0 ✓）。

**所以结论是**：
1. **这条契约不是退役带来的回归** ✓（两边活链路同构 ✓）——**门禁没有被削弱** ✓；
2. Go 侧**代码里**有不带座位那条路 ✓（`RunHostCommand` + worker 监管人 ✓，隔离实验证明那条链通 ✓），它一旦接上活链路，**监管人已经就位** ✓；
3. 剩下的是一条**与退役无关的老问题**：**沙箱路径的命令没有能比 daemon 活得更久的监管人** ✓（两边都有 ✓）——单独立项，不混进这次退役。

**试了一次 `--kernel pig` 的 keeper，结论是「流程还没跑通」，不是契约红**：用 `--kernel pig` 起 daemon、让节点用原生 `bash` 工具跑长命令，**心跳一直没长**——命令压根没被跑起来（与「命令跑起来后能不能跟着 daemon 死」是两件事 ✗）。所以那条路还需要先弄清**怎么让 PiG 内核真的跑起一个节点的主机命令**（配方/能力/模型接线与侧车那条路不同 ✓），才谈得上测契约 ✗。这条尝试没有落成用例（红的用例进不了门禁 ✓），记在这里免得下一轮重踩 ✓。

**keeper 照旧**：让 check 模块的产出合法，命令真的活着，然后 SIGKILL daemon，断言心跳在有界时间内停。

**下一步的线索已经拿到了**（注意：之前几次用 `ps` 不带 `-A`，它只列当前终端的进程，于是「进程不见了」全是 ps 用法错误，不是事实）：用 `ps -A` 看整棵树，**命令的父进程是 daemon 本身**（它的 ppid 与侧车的 ppid 相同），**而那个 worker 根本不在树里**。也就是说，**命令不是被 worker 领养的**——daemon 一死，它就成了孤儿，继续跑；worker 那条 `disconnect → cancel` 的链压根没机会接手。

**因此修法的方向变了**：要让命令的寿命真正绑在 daemon 上，得让**命令自己**（或它的直接主人）在 daemon 消失时收手——例如把命令放进 worker 的进程组、由 worker 持有它的 pid 并在主人消失时连坐；或者让 daemon 在关停时连命令的进程组一起收（但 SIGKILL 没有这个机会）。**具体怎么改要先看 Go 到底是怎么起这个命令的**：`runtime_host_command.go:201` 看起来只起了 worker 一个进程，而 ps 显示命令的直接主人是 daemon——这两件事对不上，**先把这个对不上弄清楚**（谁 fork 了命令、worker 什么时候没的），再定修法。

keeper 的写法不变：让 check 模块的产出合法，命令真的活着，然后 SIGKILL daemon，断言心跳在有界时间内停。下一次要做的第一件事，是让 check 模块的产出**合法**（命令的 stdout 必须是可用的 `data`），这样模块会成功、命令才会**一直活着**；只有在那之后，「显式停止」与「主人死去」这两半才分别可测。

**一次隔离实验把范围收窄了**：把侧车 worker（`src/runtime/host-command-worker.mjs`）单独 fork 起来，给它一个会一直写心跳的子命令，然后**把它的 IPC channel 关掉**——worker 的 `disconnect` → `cancel` → `process.kill(-pid)` 这条链**是通的**：心跳当场停住。也就是说，**保护命令的机制本身是好的**，命令跟着主人一起死只差「channel 真的关上」这一步。而 Go 侧的 channel 是一对 `socketpair`（`newNodeIpcChannel`，`runtime_restricted_process.go:1503`），父端由 daemon 持有、子端经 `ExtraFiles` 交给 worker——daemon 被 SIGKILL 时内核会关掉父端，worker 应当收到 EOF。第二次隔离实验又排除了一个猜测：**命令没有继承 worker 的 IPC 描述符**（`lsof` 显示命令的 fd 是 0/1/2 加 kqueue 与目录，**没有那条 channel**；worker 的 15/17 号 fd 是通往命令的两根管道）。也就是说那条 channel **确实可以关上**。所以**剩下的疑点只有一条，而且已经很窄**：daemon 死的时候，那条 socketpair 的父端**是不是还有别的手**——要么是 daemon 的某个子进程在它开着的时候被 fork 出来并继承了它，要么是 `net.FileConn` 复制出来的那份在别的路径上没被关掉。下一次要查的就是这一条：在 daemon 活着的时候列出**整棵进程树**里谁还持着那条 socketpair。这需要一次带日志的复现：让 worker 把日志写进**它当时的工作目录**（不要假设是哪个目录），并在 daemon 被 SIGKILL 之后到整个临时目录里把这份日志找出来。对应实现点：`backend/internal/graph/runtime_host_command.go:173` 的 `RunHostCommand`、`runtime_restricted_process.go:1503` 的 `newNodeIpcChannel`、`src/runtime/host-command-worker.mjs`。
  - **删除实现（批次 54）**：**102 个 TypeScript 后端模块**（`src/server` 16、`src/core` 43、`src/runtime` 35、`src/catalog` 6、`src/git` 2）连同 **207 个只依赖它们的测试文件**、**5 个依赖已删夹具的测试文件**与 **2 个直开 TypeScript 运行时的门禁用例**一起删除；`src/server/cli.ts` 与 `src/server/go-launch.ts` 两个启动器、Go 运行时闭包（56 个文件）与仅前端可达的 19 个文件保留。**基线按缩减显式落账**（`GRAPH_UPDATE_BASELINE=1`），缩减的数字写在下面。

## 门禁与纪律

- 只允许新增或改写真正的 E2E：真实浏览器、HTTP、CLI 或公开运行时，真实持久化与副作用。禁止单元/集成测试。
- Go E2E 的夹具是 `tests/helpers/cli-daemon.ts` 的 `launchCli`（真实 `graphd` 二进制）与 `tests/fixtures/openai-server.ts`（受控模型服务）。自有协作者的回执、顺序与状态必须由真实 owner 产生。
- 退役旧测试前先证明新 keeper 通过；负向断言先证明目标元素、请求或 guard 存在。
- 每次提交前运行 `node --run check`。

### 门禁上的一个环境故障（与本退役无关，记在这里）

批次 54 提交前跑门禁时，`tests/m0/restricted-process.test.ts` 的 15 条用例与 `tests/durable/plugins.test.ts` 的 2 条变红，理由是 `dyld: Library not loaded: @rpath/libnode.147.dylib`（随后是 `/opt/homebrew/opt/llhttp/lib/libllhttp.9.4.dylib`），**「blocked by sandbox」**：受限进程连启动都做不到。

这不是本批改动造成的：**在主检出（`13-Graph`，`f1daaa8f`）上跑同一份文件，失败一模一样**。原因是**跑门禁用的 Node**：仓库把运行时钉在 `node_modules/.bin/node`（24.20.0），而 PATH 里的 Homebrew node 26.3.0 是**动态链接**的——`libnode.147.dylib` 在 `bin/../lib`，另外几个 keg 里的 dylib 在 `/opt/homebrew/opt/*/lib`。受限进程的读白名单只有 `systemReads`（`/System`、`/usr`、`/bin`、`/sbin`、`/Library/Apple`、`/dev`）、工作目录、临时目录与调用方给的 `readPaths`；**这些运行库不在其中**，于是被沙箱挡住。测试自己给的 `readPaths: [dirname(process.execPath)]` 只放行了 `bin` 目录，够不到 `bin/../lib`，也够不到 keg。

**用仓库钉住的运行时跑，这份文件 24 条全绿**——门禁因此要走 `node_modules/.bin/node --run check`，而不是 PATH 里那个 Homebrew node。

**但这仍是一个产品缺口，记在案**：任何在 node 26 上跑自家沙箱的项目都会撞上它。修法是让受限进程**放行可执行文件自己链接的运行库**（`src/runtime/restricted-process.ts` 的读白名单要按 `otool -L` 的结果加入运行库目录，含 `@rpath` 解析出来的兄弟 `lib` 目录）。本次没有顺手改：一处半修（只放行 `bin/../lib`）会让失败从 `libnode` 挪到下一个 keg dylib，看起来像修好了其实没有，而真正修好需要弄清沙箱运行时（`@anthropic-ai/sandbox-runtime`）如何规范化这些路径——那是另一批的活。**记在案，不装作已修**。
