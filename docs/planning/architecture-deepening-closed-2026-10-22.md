# 架构深化查出来、这一轮处理掉的问题（2026-10-22）

配套文档：[架构深化计划与证据](architecture-deepening-2026-10-22.md) · [后半程：表的归属](architecture-deepening-ownership-2026-10-22.md) · [工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md) · [拆分战役](architecture-deepening-splits-2026-10-22.md) · [门禁证据](architecture-deepening-gate-2026-10-22.md) · [查出来、已经处理的问题](architecture-deepening-closed-2026-10-22.md)

下面每一条都是架构深化过程中查出来、而这一轮**处理掉了**的问题。记在这里，是因为查它们的那段过程本身就是结论的一部分：下一次改动同一个地方的人，需要知道当初看见了什么、为什么那么改。

## 冻结策略原本只还原了一半

4. **冻结策略存了 15 个字段，恢复只还原 8 个 —— 这一件已经做完了**（提交 `9c40debf` 与 `eb60abc7`）。`FrozenExecutionPolicy` 记下工作副本、状态目录、skills、扩展、读写根、保护路径、文件系统可达范围、原生工具、可调工具、能力/工具/运行时策略摘要与思考档位共 15 项，而恢复只读回其中 8 项：文件系统可达范围、原生工具、可调工具、三个策略摘要与思考档位都**没有**被还原。因此一次被重新发出的回合，用的是**此刻**的文件系统可达范围、此刻的工具清单、此刻的策略摘要与此刻的思考档位。CONTEXT.md 的**冻结执行**明写"记录该次执行用的模型、指令、工具与策略"，并把"用目录里此刻的配置重发已受理的输入"列为禁止——记录里存着这些事实，恢复没有读回来。

   - **这一轮把参照实现找出来了，于是缺口有了规格**。TypeScript 原件 `src/runtime/durable-session.ts:35` 在恢复时把**整份冻结策略**盖回请求上：`workspace`、`stateDir`、`binding`、`nativeTools`、`allowedToolNames`、`piExtensionTools`、`skillPaths`、`skillFolder`、`piExtensionPaths`、`readRoots`、`writeRoots`、`protectedPaths`、`readOnly`、`filesystemAccess`、`allowGitMetadataWritesAll`、`networkDomains`、`allowUnrestrictedNetwork`、`allowLocalBinding`、`unixSockets`、`allowAllUnixSockets`、`allowAppleEvents`，外加三个延迟工具的标志。Go 端口还冻了原件没有的三个摘要与思考档位，却只还原了那八个。
   - **两条恢复路径的差别也不同**。**节点泳道**把解算好的**访问策略**从冻结记录里取回来（`runtime_kernel_graph_lane_node.go` 的 `nodeAccess` 读 `Record.Configuration.ExecutionConfiguration["access"]`），把模型也从冻结记录里取回来——所以节点的可达范围与模型**是**冻住的。**主 Agent 会话**（`runtime_pi_adapter_turn.go:167` 起的还原块）只还原了那八个：读写根是冻住的，但**访问策略本身**取自此刻的配置。因此缺口集中在主 Agent 会话这一侧。
   - **还有一个 Go 端口特有的事实**：`request.FilesystemAccess` 在 Go daemon 里被赋值、被冻进记录，但**没有任何地方读它**——真正的强制走的是 `runner.access`（访问策略）与读写根（`runtime_restricted_run.go:44`）。所以"文件系统可达范围没有被还原"这句话在 Go 侧的实际后果，是**访问策略取自此刻**，而不是那个字段本身。
   - **七个没被还原的字段里，只有一部分在 Go daemon 里真的活着**。逐个查过读点：`request.AllowedToolNames` 在 `runtime_pig_extensions.go:60` 被读（它决定这个会话能看到哪些 Pi 扩展工具），`request.ThinkingLevel` 在 `runtime_pig_session.go:107` 被读（会话的思考档位），三个摘要在 `runtime_pig_session.go:327` 起被读（会话的 inspect 记录，即给控制台看的那份）。而 `request.NativeTools` 与 `request.FilesystemAccess` **在 Go 侧没有任何读点**——它们被赋值、被冻进记录，然后就没有然后了。因此真正要修的是**三个**：可调工具、思考档位与三个摘要；另两个是 Go 端口搬过来却没接上的死字段。
   - **把"哪几个字段真的在动"逐个查过之后，这一件缩小成了六行**。Go 的 `AgentSessionRequest`（`runtime_agent_session.go`）**带着原件那份策略的全部字段**——原件恢复时盖回去的二十来个字段，Go 这一侧一个不缺。缺的是**冻结策略那个类型**冻了哪些、以及恢复时读回哪些。
     - **冻了、没读回的字段里，真正在 Go daemon 里被读的有五个**：`AllowedToolNames`（`runtime_pig_extensions.go:60`，它决定这次会话能看到哪些扩展工具）、`ThinkingLevel`（`runtime_pig_session.go:107`）、以及三个摘要（`runtime_pig_session.go:349` 起，进会话的 inspect 记录）。**这五个是真正的缺口**。
     - **另外有一个被读、却根本没冻**：`PiExtensionTools`（`runtime_pig_extensions.go:56`）——它是被读的那一组扩展工具的**候选集**，而 `AllowedToolNames` 是**过滤器**。只还原过滤器，候选集仍然取自此刻。
     - **其余的字段在 Go daemon 里一个读点都没有**：`FilesystemAccess`、`NativeTools`、`NetworkDomains`、`AllowUnrestrictedNetwork`、`AllowLocalBinding`、`UnixSockets`、`AllowAllUnixSockets`、`AllowAppleEvents`、`ReadOnly`。它们被赋值（`runtime_pi_adapter_turn.go:160` 等），然后就没有然后了——**Go 这一侧真正强制可达范围的是解算好的访问策略与读写根**（`runtime_restricted_run.go:44` 用的是 `command.Filesystem`，而那个来自 `runner.access`），不是这些字段。还原它们在 Go 里是化妆，原件还原它们是因为 TS 宿主靠它们强制。
   - **再查一层之后，这件事只剩一样东西**。三个摘要被写进会话的 inspect 记录（`runtime_pig_session.go:349` 起），而**daemon 从那份记录上只读四样东西**：`ExtensionErrors`、`SessionId`、`SessionFile` 与 `Context`（`runtime_pi_adapter_turn.go:208` 起、`runtime_pig_node_host.go:164`）。**三个摘要写进去就没有人读**。`ThinkingLevel` 在 Go kernel 里也只是被存下来（`pigkernel/session.go:45`、`turn.go:40`），没有任何地方消费它。
   - **于是真正在动、真正能被看见的缺口只有一样：扩展工具的那一面**。一个 Pi 扩展的工具要出现在这次会话里，得过两道闸：`PiExtensionTools`（能力声明这个会话可以看到扩展的哪些工具，`runtime_pig_extensions.go:56`）与 `AllowedToolNames`（会话自己的策略说模型可以调其中哪些，`:60`）。**前者根本没冻**，后者冻了却没读回。扩展本身（`PiExtensionPaths`）是冻住也读回的，所以恢复后的会话**仍然会装载那个扩展**——只是它登记的工具全被过滤掉了。
   - **所以要定的只剩一件事**：**把 `PiExtensionTools` 一起冻进记录并读回**（要给冻结记录**加一个字段**——对旧记录向后兼容，旧记录没有就是空），同时读回 `AllowedToolNames`。**这不是五个字段的还原，是一件事**：恢复后的主 Agent 回合必须提供**它被受理时**的那一套扩展工具，而不是此刻装着的那些。
   - **已经做完了**：策略现在**把扩展工具的名字也冻进去**，两条恢复路径都读回它们；三个摘要与思考档位也一并还原。**证据**是一份真图、一个真的 Pi 扩展：扩展注册两个工具，能力声明其中一个；节点的回合被受理但从未发出，守护进程死掉，能力声明在它停下的时候被改写；**被恢复的回合必须仍然拿到它被受理时的那套工具**。**这个 E2E 在父提交上失败**（被恢复的回合拿到的是能力的新工具），在这个提交上通过（`tests/e2e/pig-extension-frozen-tools.test.ts`）。
   - **顺带查清的一件事**：那九个"在 Go daemon 里一个读点都没有"的字段里，`ThinkingLevel` 其实**被读**（`runtime_pig_session.go:107`）只是到不了任何决定什么的地方；三个摘要也**被读**（`:349` 起），只进会话的 inspect 记录。今天它们还原了也看不出差别，但**记录承诺了一件事却只还一部分，就是一份说谎的记录**。
   - **注意这份 E2E 只能与修复一起进**：它断言的是**应当如此**的行为，在现状下会失败，而门禁必须一直是绿的。所以这一件要么整件做（E2E + 修复 + 一次行为变更），要么整件不做——这正是它需要一次决定而不是一次整理的原因。补上是修一个功能缺陷，但它改变恢复路径的行为，因此本轮只写在这里。

## 两条路的工具准入规则本来是一份

7. **两条路的工具准入规则本来是一份，被端口分成两份 —— 已经合成**（提交 `426bd2cb`）。主会话与节点泳道各自建同一张工具表，而它们的差别不是设计出来的：主会话的工具表来自 `e84a8cd`，节点泳道的来自 `1435277e`，是 TypeScript 那一版逻辑的两次独立移植。三处分歧（id、遥测、panic）在这一轮合成了一件事，比较的细节记在[工具表、main 的合入与冻结执行](architecture-deepening-tools-2026-10-22.md)的第二十三步里。

## 一条状态查询不带 task id 就崩

28. **一条状态查询不带 task id 就崩，而原件从来不这样**（提交 `9d2a7480`）。主管的状态查询**先**读图的归属，**后**检查有没有给 task id。于是不给 task id 的查询解引用了一个 nil 指针，工具表把这次 panic 转成模型读到的工具错误，模型读到的是 "runtime error: invalid memory address or nil pointer dereference"，而不是一个答案。
    - **原件带着这个守卫**：TypeScript 实现是 `input.taskId === undefined ? undefined : <查归属>`——**没有 task id 就不查归属**，而没有 task id 时它答的是**调用者自己的任务**。Go 端口把守卫丢了，只留下下面那个 nil 检查，于是**原件特意处理的那一种情况，恰好是端口崩掉的那一种**。
    - **证据**：真的 Go daemon、真的对话。模型问一个它没有点名的任务的狀态。在父提交上，模型读到 Go 运行时的消息；在这一提交上，它读到一份状态投影，里面有它正在服务的那颗 master 节点。
    - **找到它的方式本身是一件要记的事**：E2E 的第一版用的是 `startGraphDaemon`，它起的是 **TypeScript 守护进程**；那份 E2E 在 TypeScript 上**通过**，而且通过得完全正确——TypeScript 实现从来没有这个 bug。**一份通过的测试，量的是另一套实现。**把测试指向 Go daemon（`launchCli` + `--kernel pig`）之后，它才在父提交上失败。第八条（E2E 门禁横跨两套实现）因此不再是一句统计：**有一个缺陷确实因此逃过了门禁**，而逃过的方式是可以写下来的。


