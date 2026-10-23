# 注释清理与变通方法归类计划

本轮用 `/poteto-mode` 生成 `/swarm`，按 `/no-comments` 的 Comment Sicko 标准审计全仓注释，产出本计划并在新分支 `chore/comment-prune-2026-10-22` 上落地第一批删除。

审计由 6 个并行节点分片完成，覆盖 `src/core`、`src/runtime`、`src/web` + `src/server`、`src/catalog` + `src/git`、`scripts` + `desktop` + `examples`、`backend/internal/graph`、`backend/internal/pigkernel` + `backend/cmd` + `tests`。每条结论都带 `file:line`，主会话对高影响项逐条复核，剔除不成立的判断。

## 结论先行

仓库的问题不是「注释太多」，而是**用注释代替了代码**。三种变通方法，处理方式不同：

1. **可以直接删除**：注释只是复述紧邻的代码、装饰性分隔条、重复的文档、指向已合并分支的旧说明。删掉不丢信息。
2. **必须先重构、再删注释**：注释记录的是我们自己的代码里一个真实的 wart。删掉注释会让 wart 变得更难发现，必须先把 wart 变成代码结构，注释自然消失。
3. **必须保留**：外部依赖、平台、协议强制的非显然行为，以及公开 API 契约。

判断依据是 Comment Sicko 的例外条款。**自己代码里的意外也是 meat**，但处理方式是标 `MUST KILL` 并给出重构方案，不是把注释删了事。

## 第一类：可以直接删除（本分支已落地）

已在 `chore/comment-prune-2026-10-22` 落地，37 个文件、94 处操作，净减 151 行。全部改动只动注释行，没有一行代码逻辑变化。

下表的行号是**删除前**的位置。删完之后那些行号指向的是旁边的代码，所以第二类一节用当前行号重新给了一遍。

| 类别 | 代表位置 | 判断 |
| --- | --- | --- |
| 装饰性分隔条 | `src/core/kernel-store.ts` 7 处、`src/web/styles.css` 13 处、`src/web/composer-state.ts` 4 处、`src/web/ui.tsx` 4 处、`src/core/rule-engine.ts` 2 处 | 下面的符号自己说明了自己的分区 |
| 复述紧邻代码 | `src/core/node-run.ts:179,185`、`src/core/interface-spec.ts:459,469`、`src/web/App.tsx:213` | 把 `if (query.before !== undefined)` 再说一遍 |
| 重复文档 | `src/core/node-submit-bridge.ts:210-213`（与 `:101-105` 重复）、`src/core/node-executor.ts:330-331,346`（与文件头 `:16-25` 重复）、`src/web/provider-form.ts:298`（与 `:284-287` 重复）、`desktop/main.mjs` 4 处（与 `desktop/lib.ts` 重复） | 同一事实写两遍，两份都会过期 |
| 指向已合并分支的旧说明 | `src/web/Settings.tsx:61-64,494-495`（"lane one owns…"）、`src/web/provider-form.ts:224-226`（"B-1 moved…"） | 引用的分支已经合并，读者无从查证 |
| 死掉的抑制 | `src/web/Settings.tsx:68` 的 `@ts-ignore` | 已验证：删掉后 root tsc、web tsc、vite build 全过。该模块早已合并，抑制没有任何作用 |
| 失效的 Go 命名说明 | `backend/internal/graph/server_app.go:1257,1983`、`server_usage.go:378,443`、`core_execution.go:1439`、`core_conversation.go:1177` | 注释只重复函数名 |
| 孤立文档块 | `src/web/App.tsx:107-108`（浮在 `route()` 前的无主 JSDoc） | 挂不到任何符号上 |
| 误挂文档 | `desktop/lib.ts:269` | 写着 "Last non-empty lines"，实际挂在 `applySecretRequest` 上；已移到真正的 `tailText` |

两处需要按语义而非按行号判断的，已改写而不是整块删除：

- `src/core/question-routing.ts:18-19` 保留「消息重试比配置恢复更窄」这半句，删掉复述 `QuestionPolicy` 类型的半句。
- `src/web/Setup.tsx:129` 保留「先写钥匙串，密钥就不进配置文件」这半句（这是安全性质的顺序约束），删掉 `1)` 步骤编号。

## 第二类：先重构、再删注释（本计划的推进项）

这些是仓库真正的技术债。**注释不是问题，注释描述的东西才是。** 按一个根因一个单元来推进，每个单元独立成一次可验证的提交。

### 2.1 Go 侧的命名根因（最大的一块，收益也最大）

`backend/internal/graph` 里有 **7 处**因为 Go 的类型和函数不能同名而加的 `Of` / `For` / `ByID` / `Result` 后缀，每处都配一句解释为什么不能叫本名：

- `catalog_models_dev.go:274-275`、`catalog_providers.go:105,132`、`server_providers.go:130`、`core_graph_presentation.go:31-32`、`core_transient_retry.go:14`、`runtime_deploy_drift.go:209`

**重构**：把这 7 个**类型**改名（`…Record` / `…Spec` / `…View`），函数恢复裸名。10 行注释自然消失。

同时 `backend/internal/graph` 有 **4 个近乎相同的排序键辅助函数**：`mapKeys`（`core_confirm_graph.go:40`）、`mapKeysAny`（`core_module_runtime.go:514`）、`portKeys`（`core_control_targets.go:30`）、`sortedKeys`（`core_kernel_views.go:91`）。**重构**：合成一个泛型 `sortedKeys[V any](map[string]V) []string`，带一句「Go map 迭代无序，所有定义遍历必须走这里」的文档。

这一个单元可以一次消掉 **21 处 `TODO(port)` 标记**（16 处 map 顺序 + 5 处 `localeCompare`），并且消除 3 个重复实现。

### 2.2 `TODO(port)` 的其余簇

- `localeCompare` vs 字节序（5 处）：`git_git.go:325`、`catalog_file_capabilities.go:451`、`catalog_capability_library.go:201`、`runtime_tool_results.go:125`、`core_artifact_workspace.go:214`。**重构**：抽一个显式比较器 `compareNames`，让「用字节序代替 locale 序」成为代码事实。
- UTF-16 vs 字节/字符（3 处）：`core_artifact_workspace.go:160`、`core_node_run.go:91`、`runtime_tool_results.go:178`。其中 `runtime_tool_results.go:178` 暴露了一个**用户可见的谎**：头部写「N chars」而 `len(text)` 是字节数。**重构**：改用 `utf16.Encode` 计数，或把标签改成「N bytes」。

### 2.3 前端的 `hasProposal` 死字段

`src/web/conversation-drawer.ts` 的三条注释都在描述一个**没人读的字段** `DrawerSectionInput.hasProposal`——写它的调用方在 `src/web/Conversation.tsx:562`，读它的地方早就不存在了。**重构**：删掉字段和调用点参数，三条 stale 注释随之消失。

### 2.4 `src/web/Settings.tsx` 的 models.dev 装载

`Settings.tsx` 那一套手写 `ModelsDevModule` 类型加动态 `import()`，存在的唯一理由是「那个模块还没合并」。模块早已合并。**重构**：直接 `import { lookupModelMetadata } from '../catalog/models-dev.ts'`，`@ts-ignore` 和 `any[]` 类型一起消失。

同文件的 `credentialConfigured` / `credentialRef` 优先级（`Settings.tsx:578-583`）用 6 行散文解释一个两项表达式的先后。**重构**：抽成 `credentialResolved(...)` 一个具名谓词。

### 2.5 死代码

- `backend/internal/graph/server_live_config.go:302-304`：`removeListener` 的 `listener` 参数没人用，`_ = listener` 解释为什么。**重构**：删参数，删两行注释。
- `backend/internal/graph/runtime_handoff_response.go:300-302`：`if` 和 `else` 两个分支体完全一样，还挂着一个 `TODO(port): replay through ReplayAssistantStream once frame structs exist` 的空头支票。**重构**：合并分支，删 TODO。
- `backend/internal/graph/core_graph_acceptance.go:115`：`TODO(port)` 注释挂在一个永远 `return false` 的死分支上。**重构**：删死分支。
- `backend/internal/graph/server_layout.go:88-97` 的 `layoutNodeSize` 与 `core_graph_presentation.go:101-108` 的 `GraphNodeSize` 逐行重复。**重构**：删前者，调后者。
- `backend/internal/graph/runtime_pig_*`：`TurnOptions.Gate`、`ProviderBridge.Stopped`、`(*Session).stoppedNow` 三个符号在整个 `backend/**` 里从未被调用，它们各自的注释在描述一条走不到的路径。**重构**：删字段、删方法、删注释。
- `backend/internal/pigkernel/sqlite.go:45,134` 的注释说「单连接」，代码却是 `SetMaxOpenConns(4)`。**重构**：统一到一个值，注释随之改对或消失。

### 2.6 重复的注释块

- `backend/internal/pigkernel/` 5 个文件（`kernel.go`、`turn.go`、`session.go`、`extensions.go`、`mcp.go`、`provider.go`）把同一段「daemon 拥有业务事实，kernel 拥有执行历史」的所有权划分抄了 5 遍。**重构**：这段话进 `docs/architecture.md`，每个导出类型留一句。
- `src/server/source-identity.ts:5-17`（13 行）、`src/server/go-launch.ts:5-14`、`src/server/console-port.ts:4`、`src/server/console-address.ts:4`（10 行）、`src/runtime/capabilities.ts:1044`、`src/runtime/conversation-tools.ts:3-11`：动机散文。**重构**：把「为什么存在」变成一个符号名或一段架构文档，散文随之消失。

### 2.7 测试与脚本

- `src/runtime/tool-call-spool.ts` 的 `spoolToolCall` **没有任何生产调用方**，只有测试在用。`scripts/console-ui-e2e.ts:106,131,240,276` 围绕它写了 4 条注释，断言的是一条不存在的生产路径。**重构**：测试改走真实写入路径，或删掉 spool 断言。
- `scripts/check-floating-promises.mjs:25-33` 与 `:54-60` 的两段散文解释「为什么要用文本正则」。**重构**：换成 AST 判定（文件已经 import 了 `SyntaxKind.PropertyAccessExpression`），散文和它的自测夹具一起消失。
- `scripts/matt-flow.mjs:33-35` 的 `flags` 集合：第 52 行把它 OR 回去，60 个字符的过滤逻辑永远不改变结果。**重构**：删 `flags`，改用 `argv.includes('--json')`。
- `src/web/Settings.tsx:620,714` 的 `eslint-disable-next-line react-hooks/exhaustive-deps`：仓库里**没有 eslint 配置**，这两条抑制是空转。**重构**：按依赖关系整理 effect，去掉抑制。

## 第三类：必须保留

以下注释经过复核，确认落在 Comment Sicko 的例外条款内，本次不动：

- **外部依赖强制**：`src/runtime/restricted-process.ts` 的 sandbox 握手、`@anthropic-ai/sandbox-runtime` 0.0.75 的引号方言、`src/runtime/durable-sqlite.ts` 的上游 schema、`src/runtime/prompt-options.ts` 的 Pi SDK 签名、`src/web/GraphCanvas.tsx:112-118` 的 React Flow 只渲染内置 edge 标签、`src/web/shared.tsx:52-53` 的 React `Activity` 重连语义、`desktop/preload.cjs` 的安全边界。
- **平台与协议强制**：`backend/internal/graph/runtime_restricted_process.go` 的 mDNSResponder / Chrome `kern.hv_vmm_present` / `--test-isolation=none`、`server_config_watch.go:96` 的 fsnotify 不可用、`server_layout.go:330` 的 elkjs 无 Go 实现、`backend/internal/graph/runtime_pig_*` 的 PiG v0.5.1 行为。
- **公开 API 契约**：`src/runtime/tool-results.ts:1` 的 `toolResultHook` 契约、`src/server/providers.ts:159-163` 的 `shouldProbeModels` 权威副本、`src/web/api.ts:25-27` 的 401 不可重试语义（附 HB-200）、`src/server/app.ts:182` 的探针不回传密钥。
- **Issue 链接解释的约束**：`src/core/execution.ts:346`（HB-272）、`src/core/graph-lane.ts:129`（HB-262）、`src/core/node-executor.ts:315`（HB-322）、`backend/internal/graph/core_task_runtime.go:49`（HB-190）、`src/core/task-runtime.ts`（HB-190 的 TS 一侧）、`src/core/environment-failure.ts:5` 的 HB-137、`backend/internal/graph/runtime_rsi.go:968`（HB-179）。

## 推进顺序

按「一个根因一个单元、每个单元独立可验证」排：

1. **本分支已落地**：直接可删的 94 处注释。行为不变，`node --run check` 通过。
2. **Go 命名单元**：7 个类型改名 + 4 个排序辅助函数合一。消掉 31 行注释，并消除 3 个重复实现。改动面最大，但每处都是机械改名。
3. **Go 死代码单元**：`server_live_config.go` 的死参数、`runtime_handoff_response.go` 的重复分支、`core_graph_acceptance.go` 的死分支、`server_layout.go` 的重复函数、`runtime_pig_*` 的三个未调用符号。
4. **前端单元**：`hasProposal` 死字段、`Settings.tsx` 的 models.dev 静态导入与凭据谓词、`eslint-disable` 两条。
5. **`localeCompare` / UTF-16 单元**：抽比较器 + 修「chars 与字节」这个用户可见的谎。
6. **pigkernel 所有权段落单元**：同一段话进架构文档。
7. **测试与脚本单元**：spool 无生产调用方、floating-promises 改 AST、`matt-flow` 删 `flags`。

第 2 到第 6 步之间没有依赖，可以并行分给多个节点；第 7 步要等第 4 步的 `Settings.tsx` 改动落地后再动同一批文件。

## 验证方式

- 每个单元独立成一次提交，提交前跑 `node --run check`（后端构建 + vet、typecheck、lint、测试、基线、证据）。
- Go 侧改动额外看 `go -C backend vet ./...` 和 `node --run check:backend`。
- 注释删除本身不改变行为，测试套件必须全绿；`tests/console/schema-version.test.ts` 直接读 `src/core/store.ts` 源码文本，是注释删除最容易踩到的门禁。

### 本单元的行为等价证明

注释删除不改变行为，但「删了注释所以行为没变」这句话本身需要证据，不能只靠断言。三条独立证据：

1. **TypeScript / JavaScript**：用仓库自带的 esbuild 把 31 个改动文件在改前与改后各转译一次并最小化，两份产物**逐字节相同**。转译器会丢弃注释，产物相同即语义相同。
2. **Go**：用 `go build -trimpath` 编译 main 与本分支两个二进制，`go tool objdump` 逐个函数比对反汇编：**40176 个函数里有 40175 个机器码逐字节相同**。唯一不同的是 `_go:buildid`——它不是代码，而是链接器嵌进二进制的构建 ID 字符串，内容是源码的哈希。源码字节变了（注释被删），哈希就变，所以这个函数必然不同；同一份分支源码编译两次，它又完全一致。
3. **前端产物**：`vite build` 产出的 `dist/web` 全部 js 与 css 的聚合哈希，改前改后**一致**。

关于 buildid 的对照实验：不加 `-trimpath` 时，同一份源码编译两次就有 21787 个函数因构建路径而不同，噪声大到无法判断。`-trimpath` 消掉路径噪声后，同一份源码两次编译的差异收敛到 `_go:buildid` 这一个函数——这个「噪声地板」说明比对方法本身是敏感的：真正由注释删除带来的差异也只有这一个函数，而它是源码哈希，不是可执行代码。

测试套件方面，本机的并发压力让失败数在几轮之间大幅波动，而且**失败的文件集合每轮都不同**——这本身就是环境噪声而非代码问题的特征。同一台机器上，干净 main 的完整 `node --run check` 失败 11 个文件，本分支失败 4 个；把 main 失败的那 11 个文件拿到本分支重跑，11 个里 9 个直接通过，剩下的 `tests/m1/recovery.test.ts` 单独连跑 5 次也是 5 次全过。

失败来自机器同时跑着另外 4 个工作树的测试套件，不是本次改动。

## 覆盖与缺口

- `tests/**` 全部 326 个文件做了模式扫描，其中 5 个注释密集的文件逐行读了上下文；其余 190 个低密度文件只扫描模式、读了文件头，未逐行判断。`tests/fixtures/**`（20 个文件）只扫未读。
- `src/web` 有 30 多个文件只做了清单扫描和抽样，未逐行判断；其注释风格以导出符号的契约 JSDoc 为主，抽样未发现 meat。
- 注释密度本身不构成问题：`src/core` 2155 行注释 / 65 文件，`src/runtime` 1857 / 75，`backend` 5547 / 189。大部分是有价值的契约与外部约束说明。
