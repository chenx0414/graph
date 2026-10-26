# 依据

批次 42 把设置界面的浏览器轨也改到 Go daemon 上（`tests/m8/settings-ui.test.ts` 9 条，断言一个字没改），把那条直接读内部运行时的用例退休掉，并把它承载的契约搬进 Go（`tests/e2e/go-model-binding-guard.test.ts`）：被运行中的图占用的模型删不掉，daemon 保留绑定，指名拒绝，图修订仍钉着那个模型，停掉那张图之后同一份改动才通过。这一批**逼出了 Go 侧一个真 bug**：**daemon 重启后，已经打开的控制台全线 401**——会话 cookie 每进程随机，而 daemon 被换掉之后（升级、桌面端在同一端口上重启它）浏览器手里还是旧进程的那张 cookie；TypeScript 那边是同样的设计，只是 Node 每次恰好拿到不同端口才没暴露。现在**会话令牌属于这份安装而不是这个进程**：它落在状态目录里（0600），daemon 重启之后还是同一张 cookie，控制台继续工作（`tests/e2e/go-session-across-restart.test.ts`）。批次 43 把应用外壳的浏览器轨也搬到 Go daemon 上（`tests/m8/app-shell-ux.test.ts` 32 条中的 12 条，断言一个字没改）——它们本来就是在浏览器里 stub API 来测控制台，daemon 只负责端出控制台壳子；剩下 20 条要靠 TS 运行时的内部面造状态，随实现一起退休，公开面的造状态路径留在 Batch 44。批次 44 算清了删除集合（**102 个模块 + 211 个只依赖它们的测试文件**）并逐个处置 15 个外部消费者；批次 45 给 Go 后端补上了第一个缺失的入口：**`graphd reclaim`**——状态回收的规则 Go 侧一直有，却只有 TypeScript 脚本能触发，现在命令直接跑在 Go 自己的数据库与锁上，`scripts/state-reclaim.ts` 随之退休。批次 46 补上第二个缺失的入口：**`graphd review-module`**——评审策略的规则（`ReviewPolicyCode` / `ReviewPolicyInputs` 与策略校验）Go 侧一直有，却只有 TypeScript 脚本能触发，现在命令自己写出隔离求值代码并打印普通 command 模块声明，`scripts/create-review-module.ts` 随之退休。这一批**逼出了 Go 侧一个真 bug**：`RunModuleContainer` 在容器**成功退出时没有写退出码**（`Code` 留空），宿主把每一次成功的模块求值都当成「退出码未知」的失败（`graph.module.failed` 写着 `module process exited with null`，模块队列被暂停）——**Go 侧的 command 模块此前从来没有成功跑过一次**，而这条路径既没有 Go E2E 覆盖，TypeScript 那边的测试又走的是 TS 运行时。修法是成功时把退出码写成 0；新的 `tests/e2e/go-review-module.test.ts` 用真实的命令、真实的 daemon 与真实的隔离容器证明它：生成的模块接进真实的图之后真的判出业务返工（`rework` 输出、评审人的话、要改的文件、未归属路径），必填输入没到齐时模块等着不动。批次 47 补上第三个缺失的入口：**`graphd assemble-team`**——团队装配的规则（`AssembleMattTeam`）Go 侧一直有，却只有 TypeScript 示例脚本能触发；现在命令打开本地控制台的会话、读它真实的能力库、把每个角色发布成一条配方，再把团队写成一份普通的 v2 图定义，`examples/assemble-matt-team.ts` 随之退休。新的 `tests/e2e/go-assemble-team.test.ts` 证明：缺的每一个角色都在保存任何东西之前被点名（一个配方都没发布、定义文件也没落地），装配成功时四个角色的配方真的进了控制台的目录、定义点名的是已发布的版本（同名旧配方让 worker 变成 `@2`），已存在的定义文件不被覆盖。**三个「Go 有实现、没有入口」至此全部补齐**。批次 48 把「原生 shell 的大输出」那条一直留在案的契约钉在 Go daemon 上（`tests/e2e/go-native-shell-output.test.ts`，3 条）：整份输出留在磁盘上、模型只看到紧凑视图与整份的路径、模型能真的读到中间那段、daemon 被换掉之后文件与字节都还在、被压缩的结果不会被后来的命令清掉——这一条**在 Go 侧本来就不是缺口**：daemon 现在跑的是运行时闭包里保留的 TypeScript 侧车，那层钩子由侧车提供；但 Go 自己的 `ToolResultHook` / `RenderToolResult` 依旧是死代码，**等 PiG 内核接管主会话时必须接回**。批次 49 把节点泳道最要紧的两条契约钉在 Go daemon 上（`tests/e2e/go-node-lane.test.ts`，2 条）：worker 只写自己的工作副本（用户项目里没有那份文件）、它被告知自己要过的检查与验收（图的其余部分不进它的提示）；reviewer 被告知该发什么（`FINAL REVIEW REQUIREMENTS` / `graph.review@1` / `{commit,passed,reason}`），它发出来的报告真的让那条 review 验收通过。批次 50 把「未知的用量挡住下一次 provider 调用」与「原生对账各记一次」钉在 Go daemon 上（`tests/e2e/go-unknown-usage.test.ts`，1 条），并**逼出了 Go 侧一个真 bug**：受控流在拿不到用量时把这次调用结算成一份**全零的记录**，而 TypeScript 结算成**没有证据**——全零记录等于宣称「这次调用免费」，于是 `kernel_provider_calls.state` 永远是 `settled`，**Go 侧的未知用量闸门与 `reconcile_usage` 入口此前一次都没被真正走到过**；修法是拿不到用量就结算成「没有证据」。修好之后，一个声明了自己预算的节点遇到一个不说价的 provider 时：账上分得清**有价的那次**与**没价的那次**（各记一次）、没价的那次记成 `unknown`、工具闸先拒绝、**下一次 provider 发送真的被拒绝**（provider 只被问两次）、节点真的停住，而 main 通过 `graph_control` 的 `reconcile_usage` 对账时**同值再来一次是同一答案、不同值被拒**、缺价的那次最后真的记成 `reconciled`。批次 51 把 `tests/m3/production.test.ts` 点算出来的最后几条也钉在 Go daemon 上（`tests/e2e/go-master-surface.test.ts` 2 条、`tests/e2e/go-read-graph.test.ts` 1 条），并**逼出了 Go 侧一个真差异**：`validate_proposal` 在 TypeScript 那边把「不合法」当成**答案**（`{valid:false, error:{code, message}}`），在 Go 侧却是**工具失败**——模型读到的是一句报错，而不是「哪条规则拒了它」；现在两边同构。master 真的收到 `<rules>` 段与 R14 那条文案（被删掉的 `<workflow>` 提示与旧形状 `proposalJson` 真的不在），真的能先问「这份提案会被接受吗」再落成草稿；节点在一张六十一个节点的图上真的把点名的对象整份读出、真的分页（`total` 与 `nextAfter`），**变更落在执行进行当中时那次执行读到的仍是它自己冻结的那一版**，下一次执行才读到改过的那一版。至此 `tests/m3/production.test.ts` 的十一条在 Go 侧全部有 keeper。批次 52 把控制台的浏览器轨整体搬进 Go daemon：`tests/m8/app-shell-ux.test.ts` 原来靠 TypeScript 运行时内部面造状态的 21 条里，18 条改由 daemon 自己的门面造状态（真的 master 真的去提草稿、真的被打断），剩下 5 条构造的就是实现内部状态，随实现一起退休；分支确认那条另写成新的 `tests/e2e/go-project-branches-ui.test.ts`（三种模式：当前分支／准备过的分支／未知的游离分支）。这一批逼出 Go 侧三处真缺口并修掉：**草稿图永远画不出来**（`/api/conversations/{id}/draft-graph` 按记录读提案、而会话视图给的是提案本身，于是定义读不到；顺带补上控制台点开某版草稿时用的 `?version=`）、**控制台的「准备 Git」按钮没有路由**（两边都缺，Go 运行时本就有这个能力，现在露出来了）、**`ProjectPreparation` 用 Go 默认字段名序列化**（控制台读 `branch`/`state`，拿到的是 `Branch`/`State`，于是项目准备状态与分支证据都看不见）。删除 TypeScript 实现本身尚未开始。批次 53 把删实现之前的最后一批消费者改道：评估 harness（`scripts/harness-real-eval.mjs`）改由真实的 `graphd` 进程驱动（新增 `scripts/go-daemon.mjs`，全部走 daemon 的公开 HTTP 面），三个活测试因此由 Go daemon 驱动；这一批逼出 Go 侧一个真 bug——**provider 永不应答时控制面被在途回合卡死**：`pause` 与 `interrupt` 都要软停主回合，而软停走侧车的 `stop`/`interrupt`，侧车原本 `await conversation.abort()`，永远不会回答的 provider 让 abort 落不下来，于是整个 daemon 在那段时间只读不写；修法是侧车把 abort 当作**请求**而不是**等待**（`src/runtime/durable-session.ts`），TypeScript 那边本来就没有这个问题（它的 `pause` 只置标志）。`tests/e2e/go-wake-notification.test.ts` 也摘掉了对 `src/git/git.ts` 的依赖，改用真的 `git` 二进制建夹具仓库。另有九个直开 TypeScript 运行时或直接写 TypeSQLite 表的工具随实现退休（`console-ui-e2e`、`branch-edge-e2e`、`mcp-adapter-e2e`、`skill-sediment-e2e`、`harness-worker-eval`、`m1-demo`、`m7-acceptance`、`perf/bench/measure`），它们承载的产品契约在 Go 侧的去处逐条记在退役计划里；两处尚无 Go keeper 的缺口也照实记在案（worker 读不到工作副本之外的文件、沉淀产物本身的形状规则）。批次 54 删掉 **102 个 TypeScript 后端模块**（`src/server` 16、`src/core` 43、`src/runtime` 35、`src/catalog` 6、`src/git` 2）与 **212 个只依赖它们的测试文件**，保留两个启动器（`src/server/cli.ts`、`src/server/go-launch.ts`）、Go 运行时闭包（55 个文件）与仅前端可达的 19 个文件；基线的缩减按约定显式落账。**后端从此只有 Go 一门实现语言**。批次 55 把批次 54 记在案的两条缺口补成了 Go 的 keeper：**沉淀产物的形状规则**（`tests/e2e/go-sediment-skill.test.ts`：真实的评审提出什么，就按规则落成项目自己的技能或一个字节都不写）与 **worker 的访问边界**（`tests/e2e/go-node-sandbox.test.ts`：同一份宿主文件在标准访问下读不到、在完全访问下读得到，边界来自访问策略而不是路径碰巧不存在），两条各有一次回退证明断言咬得住。**还有一条没有补上，记在案**：宿主命令的寿命——显式停下时命令确实停了，但**daemon 被 SIGKILL 后命令没有跟着停**，与 TypeScript 的契约不一致；而显式停下这一半在钉死真正的结束机制之前不落用例。

## 依据

- **两套实现已经漂移**。Go 侧 183 个文件约 80k 行，TypeScript 侧同构模块约 41k 行，两边各自演化。CI 的绿色主要由 TypeScript 实现背书，实际跑生产的是 Go，而 Go 侧只有少量 E2E——覆盖不对称，漂移抓不到。
- **没有任何一条产品行为是 Go 模型有意丢掉的**。逐条比对 35 个驱动 TypeScript daemon 的测试文件、176 条契约：`dropped-in-go` 数量为 0。空缺全部是「Go 侧还没有这条 E2E」、「这条证明写的是 TypeScript 内部实现」，或「Go 侧确实少一个能力」。
- **仓库政策要求先迁入真实 E2E 再退休旧测试**（`CODING_STANDARDS.md` 测试编写规则、`tests/AGENTS.md`、`.agents/skills/test-audit/SKILL.md`）。因此顺序不可颠倒：先补 Go keeper，再删 TypeScript 实现与其实现耦合测试。

## 退役边界：按活跃引用，而不是按目录

Go daemon 在运行时直接 spawn 六个 TypeScript 入口（`src/runtime/durable-service.ts` 等），它们承载崩溃恢复语义与图节点泳道，PiG 内核接管这两项之前不能删除。**从这六个入口出发的运行时闭包是 56 个 TypeScript 文件，必须保留**。

闭包必须同时按 **import 语句**与 **URL/路径字符串**两种引用计算：`src/runtime/durable-storage.ts` 用 `new Worker(new URL('./durable-storage-worker.ts', import.meta.url))` 拉起存储 worker，worker 再 import `durable-sqlite.ts`。只跟 import 会漏掉这两个文件，从而误判它们可删。

`src/server`、`src/core`、`src/runtime`、`src/catalog`、`src/git` 共 179 个 TypeScript 模块的处置：

| 类别 | 数量 | 处置 |
| --- | --- | --- |
| Go 运行时闭包 | 56 | 保留，随 PiG 内核接管恢复语义后另行退役 |
| 仅前端可达 | 19 | 保留，属于浏览器侧契约 |
| 启动器 | 2 | `src/server/cli.ts`（`pnpm start` 启动器）与 `src/server/go-launch.ts`（Go E2E 夹具依赖）保留 |
| 本次删除 | 102 | `src/server` 16、`src/core` 43、`src/runtime` 35、`src/catalog` 6、`src/git` 2；先迁移或退休这些工具，再删实现 |

本次实际可删的是 **102 个模块**，随实现退休的测试文件是 **212 个**。

## 顺序

1. **补 Go E2E**：每条独立契约在 Go 上有一份真实 E2E（真实 `graphd` 进程 + 真实回环 HTTP + 受控 provider），证明它成立。
2. **退休 TypeScript 实现耦合测试**：证明写的是 TypeScript 内部实现（直接调用 `openTaskRuntime` / `TaskStore`、断言私有字段、手写私有表记录、注入假协作者）的测试随实现一起退役。
3. **迁移或退休 `scripts/`、`examples/` 里的 TypeScript 工具**：它们是 100 个待删模块的最后消费者。
4. **删除实现并更新门禁**：`package.json`、`tsconfig.json`、`tests/suite-baseline.json` 与文档同步落账。

## Go 侧仍缺的能力

删除 TypeScript 实现之前，Go 必须补上这两处，否则相关契约无法证明：

- **provider 传输证据**。TypeScript 侧每次 provider 尝试写一条 `provider.transport` 事件（`fetch_started` / `response_headers` / `transport_error`，带 `requestSha256`、`responseIds`、`usageRecoverableFromTransport`），并发送 `x-opencode-request-id` 关联头。Go 侧只有 `provider.request_profile`，证据面缺失。
- **确定性的价格校验口子**。`DaemonOptions.PriceVerify` 存在但 `serveDaemon` 从不设置，校验永远走归档 `sourceUrl` 的网络请求，真实 E2E 无法指向本地服务。

## 对既有决策的影响

不取代 ADR 0032 与 ADR 0033，只把「Go 拥有后端」从「实现选择」推进为「唯一实现」。ADR 0006 关于 TypeScript 作为领域内核实现语言的选择，其后端部分由本决策取代；Web 与桌面壳仍为 TypeScript，`src/web` 对 `src/core` 的投影依赖属于浏览器侧契约，不在本次删除范围。

## 计划与证据

[退役计划与覆盖矩阵](planning/ts-backend-retirement-2026-10-20.md) 记录模块清点、测试清点、逐文件覆盖矩阵、Go 侧缺口与每批交付。
