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

## 第二类：先重构、再删注释（已按单元落地）

这些是仓库真正的技术债。**注释不是问题，注释描述的东西才是。** 按一个根因一个单元推进，每个单元独立成一次可验证的提交。下文每节标注了落地结果。

### 2.1 Go 侧的命名根因（最大的一块，收益也最大）

`backend/internal/graph` 里有 **7 处**因为 Go 的类型和函数不能同名而加的 `Of` / `For` / `ByID` / `Result` 后缀，每处都配一句解释为什么不能叫本名：

- `catalog_models_dev.go:274-275`、`catalog_providers.go:105,132`、`server_providers.go:130`、`core_graph_presentation.go:31-32`、`core_transient_retry.go:14`、`runtime_deploy_drift.go:209`

**重构**：把这 7 个**类型**改名（`…Record` / `…Spec` / `…View`），函数恢复裸名。10 行注释自然消失。

**已落地**：类型改名为 `CatalogProvenanceRecord`、`ProviderTemplateRecord`、`TemplateModelEntryRecord`、`PlatformPresetRecord`、`GraphNodeVisualKindValue`、`RetryDecisionRecord`、`DeployDriftReport`，函数恢复 `CatalogProvenance`、`ProviderTemplate`、`TemplateModelEntry`、`PlatformPreset`、`GraphNodeVisualKind`、`DeployDrift`（`RetryDecision` 的函数本来就叫这个名字，方向与计划相反）。

同时 `backend/internal/graph` 有 **5 个近乎相同的排序键辅助函数**：`mapKeys`（`core_confirm_graph.go:40`）、`mapKeysAny` 与 `mapKeysSet`（`core_module_runtime.go:514,526`）、`portKeys`（`core_control_targets.go:30`）、`sortedKeys`（`core_kernel_views.go:91`）。**重构**：合成一个泛型 `sortedKeys[V any](map[string]V) []string`，带一句「Go map 迭代无序，所有定义遍历必须走这里」的文档。

**已落地**：合并进 `backend/internal/graph/keyutil.go` 的 `sortedKeys` 与 `anySortedKeys`，35 处调用点全部更新，4 个旧函数删除。`mapKeysAny` 原本不排序，合并前逐个核对了它的 3 个调用点都与顺序无关，行为不变。这个单元消掉 **12 处 map 顺序 `TODO(port)`**（不是计划的 16 处——另外 10 处形状相似但说的是新文档表达不了的事实，保留）。

### 2.2 `TODO(port)` 的其余簇

- `localeCompare` vs 字节序（5 处）：`git_git.go:325`、`catalog_file_capabilities.go:451`、`catalog_capability_library.go:201`、`runtime_tool_results.go:125`、`core_artifact_workspace.go:214`。**重构**：抽一个显式比较器，让「用字节序代替 locale 序」成为代码事实。**已落地**：`lessByByteOrder` 放在 `textutil.go`，5 处全部改用它，5 个 `TODO(port)` 删除；字节序与 `sort.Strings` 相同，行为不变。
- UTF-16 vs 字节/字符（3 处）：`core_artifact_workspace.go:160`、`core_node_run.go:91`、`runtime_tool_results.go:178`。其中 `runtime_tool_results.go:178` 暴露了一个**用户可见的谎**：头部写「N chars」而 `len(text)` 是字节数。**重构**：按 UTF-16 计数。**已落地**：
  - `artifactRequiredText` 上的标记其实描述的是 `artifactUTF16Len`，而后者与包内 `utf16Len` 逐字重复。删掉重复实现，改调 `utf16Len`，事实只在 helper 的文档里说一次。
  - `core_node_run.go` 的标记直接删除：裁剪走 `truncateRunes`，名字与文档已经说明单位，而 `node.entry` 另有 `TextBytes` 存字节。
  - **「N chars」这个谎已修**：头部与「omitted X of N」都改为按 UTF-16 码元计数，与 TypeScript 端口一致。ASCII 结果完全不变；非 ASCII 的数字变小（CJK 65 字节从「65 chars」变成「25 chars」）。头尾的字节预算不变，因为 `limit` 本来就按字节算。

### 2.3 前端的 `hasProposal` 死字段

`src/web/conversation-drawer.ts` 的三条注释都在描述一个**没人读的字段** `DrawerSectionInput.hasProposal`——写它的调用方在 `src/web/Conversation.tsx:562`，读它的地方早就不存在了。**重构**：删掉字段和调用点参数，三条 stale 注释随之消失。

**已落地**：字段、调用点参数与三条注释都删了。`tests/m8/conversation-drawer.test.ts` 里传这个参数的地方一并改掉，断言没有放松——被删掉的那条不变式（「结果忽略 `hasProposal`」）现在由 TypeScript 的多余属性检查来保证，比原来更强。

### 2.4 `src/web/Settings.tsx` 的 models.dev 装载

`Settings.tsx` 那一套手写 `ModelsDevModule` 类型加动态 `import()`，存在的唯一理由是「那个模块还没合并」。模块早已合并。

**已落地（与计划不同）**：`@ts-ignore` 与 `any[]` 消失了，但**导入保持动态**。该模块在导入期就读快照，且那个顶层 `await fetch` 没有任何保护；改成静态导入会把它挪到 Settings chunk 的模块求值期。真实浏览器里挡住快照资源后实测：基线的 chunk 仍能求值，静态导入版本不能——一个缺文件的 vendored 资源会拖垮整个设置页。现在类型用 `typeof import('../catalog/models-dev.ts')` 声明，两个 typecheck 都不再需要抑制。

同文件的 `credentialConfigured` / `credentialRef` 优先级（`Settings.tsx:578-583`）用 6 行散文解释一个两项表达式的先后。**重构**：抽成 `credentialResolved(...)` 一个具名谓词。

### 2.5 死代码

- `backend/internal/graph/server_live_config.go:302-304`：`removeListener` 的 `listener` 参数没人用，`_ = listener` 解释为什么。**重构**：删参数，删两行注释。**已落地**。
- `backend/internal/graph/runtime_handoff_response.go:300-302`：`if` 和 `else` 两个分支体完全一样，还挂着一个 `TODO(port): replay through ReplayAssistantStream once frame structs exist` 的空头支票。**重构**：合并分支，删 TODO。**已落地**。注意这个 TODO 的前提是错的——`ReplayAssistantStream` 与 `AssistantMessageFrame` 在 Go 里已经存在，但 Go 端口确实没有像 TypeScript 那样回放。**这是真实的移植缺口，值得单独开 issue。**
- `backend/internal/graph/core_graph_acceptance.go:115`：`TODO(port)` 注释挂在一个永远 `return false` 的死分支上。**重构**：删死分支。**已落地**：改成比较归一化后的身份字符串。用 `*string` 而不是 `string`——空串身份与缺失身份在 `string` 下会相等，而原行为对 `("",<非字符串>)` 返回 `false`。改动前用 361 组输入（含 `""`、nil、数字、布尔、map、slice、struct）比对，新旧零差异，且不会对不可比较的动态类型 panic。
- `backend/internal/graph/server_layout.go:88-97` 的 `layoutNodeSize` 与 `core_graph_presentation.go:101-108` 的 `GraphNodeSize` 逐行重复。**重构**：删前者，调后者。**已落地**：删除前用一个临时包内校验器比对了 15 种 id × 9 种 kind × 7 种 action 的全组合，外加 CJK、unicode 与超长文本的宽度情形，共 888 组，标签、宽、高全部无差异。
- `backend/internal/pigkernel/` 的 `TurnOptions.Gate`、`ProviderBridge.Stopped`、`(*Session).stoppedNow` 三个符号在整个 `backend/**` 里从未被调用，它们各自的注释在描述一条走不到的路径。**重构**：删字段、删方法、删注释。**已落地**。`stoppedNow` 删掉后 `Session.stopped` 变成只写，连带 `Stop` 里空转的加锁一并去掉。
- `backend/internal/pigkernel/sqlite.go:45,134` 的注释说「单连接」，代码却是 `SetMaxOpenConns(4)`。**未做**：统一到一个值会改变连接池行为，是另一个根因。

### 2.6 重复的注释块

- `backend/internal/pigkernel/` 6 个文件（`kernel.go`、`turn.go`、`session.go`、`extensions.go`、`mcp.go`、`provider.go`）把同一段「daemon 拥有业务事实，kernel 拥有执行历史」的所有权划分抄了 6 遍。**重构**：这段话进 `docs/architecture.md`，每个导出类型留一句。**已落地**：段落写进 `docs/architecture.md` 的新一节「daemon 与内核的分工」，代码里 7 处改成指针。`backend/internal/graph` 的 `runtime_pig_session.go` 与 `runtime_pig_node_host.go` 还有两段，也一并改了——否则同一段话仍然抄着 9 遍。
- `src/server/source-identity.ts:5-17`（13 行）、`src/server/go-launch.ts:5-14`、`src/server/console-port.ts:4`、`src/server/console-address.ts:4`（10 行）、`src/runtime/capabilities.ts:1044`、`src/runtime/conversation-tools.ts:3-11`：动机散文。**重构**：把「为什么存在」变成一个符号名或一段架构文档，散文随之消失。**未做**：这批散在 `src/server` 与 `src/runtime`，每个都牵一个独立的小重构，合并成一个单元就不再是「一个根因」。

### 2.7 测试与脚本

- `src/runtime/tool-call-spool.ts` 的 `spoolToolCall` **没有任何生产调用方**，只有测试在用。`scripts/console-ui-e2e.ts:106,131,240,276` 围绕它写了 4 条注释，断言的是一条不存在的生产路径。**重构**：测试改走真实写入路径，或删掉 spool 断言。**已落地**：查清了调用图——TS 侧最后一个调用方是 `src/runtime/pi-worker.ts`，在迁移到 pi-durable 1.1.0（提交 `685d88dc`）时随进程内 agent loop 一起被删；Go 侧的 `SpoolToolCall` 同样没有调用方。真正的写入方是 `store.recordToolCall`，由 `pi-adapter.ts` 与 `kernel-graph-lane.ts` 在进程内调用。写路径确实是死的，于是删掉；E2E 改用 `TaskStore.recordToolCall` 播种——就是生产代码用的那个方法。页面断言未变，数字也一致。ingest 读路径保留，它仍在被调用，也仍能收拢旧 lane 留下的文件。
- `scripts/check-floating-promises.mjs:25-33` 与 `:54-60` 的两段散文解释「为什么要用文本正则」。**重构**：换成 AST 判定（文件已经 import 了 `SyntaxKind.PropertyAccessExpression`），散文和它的自测夹具一起消失。**已落地**：两个文本正则都换成了语法树判定，散文收成 `rootCall` 上的一段事实说明。**等价性是证明过的**：在全仓上旧脚本与新脚本都报零违规；在覆盖每一种写法的夹具上旧脚本报 9 处、新脚本报 13 处，`comm -23` 显示**旧的一处都没丢**，新增的 4 处是旧脚本看不到的真阳性。
- `scripts/matt-flow.mjs:33-35` 的 `flags` 集合：第 52 行把它 OR 回去，60 个字符的过滤逻辑永远不改变结果。**重构**：删 `flags`，改用 `argv.includes('--json')`。**已落地**：穷举 7381 种 argv 组合（长度 0-4，取自 `--json`、`--stage`、`merge`、一个 slug 和两个取值 token），新旧零差异。`VALUE_FLAGS` 与它的理由保留——没有那个集合，现在的解析器确实会把「merge」当成 slug。
- `src/web/Settings.tsx:620,714` 的 `eslint-disable-next-line react-hooks/exhaustive-deps`：仓库里**没有 eslint 配置**，这两条抑制是空转。**重构**：按依赖关系整理 effect，去掉抑制。**已落地**（注释在第 1 步已删，这里补的是依赖表本身）：账号切换的 effect 补上它读的 `vendors`；自动探测的 effect 把 `runProbe` 收成 `useCallback(..., [])` 后加进依赖表。两个 effect 都不再需要抑制，而且 `useEffect` 总是调用最新的闭包，所以原来也不是读到冻结的值——依赖表不完整，不是行为错乱。

## 第三类：必须保留

以下注释经过复核，确认落在 Comment Sicko 的例外条款内，本次不动：

- **外部依赖强制**：`src/runtime/restricted-process.ts` 的 sandbox 握手、`@anthropic-ai/sandbox-runtime` 0.0.75 的引号方言、`src/runtime/durable-sqlite.ts` 的上游 schema、`src/runtime/prompt-options.ts` 的 Pi SDK 签名、`src/web/GraphCanvas.tsx:112-118` 的 React Flow 只渲染内置 edge 标签、`src/web/shared.tsx:52-53` 的 React `Activity` 重连语义、`desktop/preload.cjs` 的安全边界。
- **平台与协议强制**：`backend/internal/graph/runtime_restricted_process.go` 的 mDNSResponder / Chrome `kern.hv_vmm_present` / `--test-isolation=none`、`server_config_watch.go:96` 的 fsnotify 不可用、`server_layout.go:330` 的 elkjs 无 Go 实现、`backend/internal/graph/runtime_pig_*` 的 PiG v0.5.1 行为。
- **公开 API 契约**：`src/runtime/tool-results.ts:1` 的 `toolResultHook` 契约、`src/server/providers.ts:159-163` 的 `shouldProbeModels` 权威副本、`src/web/api.ts:25-27` 的 401 不可重试语义（附 HB-200）、`src/server/app.ts:182` 的探针不回传密钥。
- **Issue 链接解释的约束**：`src/core/execution.ts:346`（HB-272）、`src/core/graph-lane.ts:129`（HB-262）、`src/core/node-executor.ts:315`（HB-322）、`backend/internal/graph/core_task_runtime.go:49`（HB-190）、`src/core/task-runtime.ts`（HB-190 的 TS 一侧）、`src/core/environment-failure.ts:5` 的 HB-137、`backend/internal/graph/runtime_rsi.go:968`（HB-179）。

## 推进顺序

按「一个根因一个单元、每个单元独立可验证」排。**第 1 到第 7 步已全部落地**，每个单元一个根因一次提交：

| 步 | 单元 | 落地结果 |
| --- | --- | --- |
| 1 | 直接可删的注释 | 94 处、37 个文件，行为不变 |
| 2 | Go 命名单元 | 7 个类型改名让函数拿回裸名；**5 个**排序辅助函数合一（原计划写 4 个，树里是 5 个） |
| 3 | Go 死代码单元 | `removeListener` 死参数、重复的终止分支、死分支、重复的 `layoutNodeSize` |
| 4 | 前端单元 | `hasProposal` 死字段、models.dev 模块类型、两个 effect 的依赖表 |
| 5 | `localeCompare` / UTF-16 单元 | 字节序比较器；「N chars」改按 UTF-16 计数 |
| 6 | pigkernel 所有权段落 | 段落进 `docs/architecture.md`，代码里 7 处改成指针 |
| 7 | 测试与脚本单元 | spool 写路径（无生产调用方）、floating-promises 改 AST、`matt-flow` 删 `flags` |

第 2 到第 6 步之间没有依赖，实际按 5 个并行节点推进；第 7 步等第 4 步的 `Settings.tsx` 改动落地后再动同一批文件。

### 计划落地时与代码不符的地方

计划是在审计时写的，落地时发现几处与树里的实际情况不符。**以代码为准**，计划已更正：

- **排序辅助函数是 5 个不是 4 个**：`mapKeys`、`mapKeysAny`、`mapKeysSet`、`portKeys`、`sortedKeys`。`mapKeysAny` 从不排序，合并前逐个核对了它的 3 个调用点都与顺序无关。
- **`RetryDecision` 的命名方向反了**：树里函数已经叫 `RetryDecision`，带后缀的是结构体 `RetryDecisionResult`，所以只改了结构体。
- **map 顺序标记是 12 处不是 16 处**：另外 10 处形状相似但说的是新文档表达不了的事实（`encoding/json` 的键序、CanonicalJSON 的内容相等、确实不排序的遍历），保留。
- **所有权段落不止 5 处**：`backend/internal/graph` 的 `runtime_pig_session.go` 与 `runtime_pig_node_host.go` 也各有一段，第 6 步一并改成指针。
- **models.dev 不能改成静态导入**：计划写的是静态导入。落地时实测发现该模块在导入期就读快照（一个没有保护的顶层 `await fetch`），静态导入会把这次读取挪到 Settings chunk 的模块求值期——真实浏览器里挡住快照资源后，基线的 chunk 仍能求值，静态导入版本不能。改成保留动态导入、只把手写的 `ModelsDevModule`（`(...args: any[])`）换成 `typeof import()`，`@ts-ignore` 随之消失。

### 后续可做，但不属于本计划

- **main 上 `tests/e2e/harness-probe.test.ts` 是坏的，与本计划无关。** main 的 `255b3d25` 把决策记录的 `chosen` 从候选字母改成节点 id（`harnessResolveChosen`），但没同步更新这个测试，于是 `expect(decision.chosen).toBe('A')` 失败。`vitest.config.ts` 里有 `bail: 1`，所以这一个失败会让整轮套件在第 11 项测试就停下。**干净的 main 同样失败**（同一个文件、同一个断言）。本分支的完整套件结果是：**排除这个文件后，293 个文件、1554 项测试、0 失败**；它自己单独跑也是 1 失败 1 通过，与 main 相同。修它属于 harness 那一摊，不属于本计划。
- `backend/internal/graph/runtime_tool_call_spool.go:77` 的 `SpoolToolCall` 同样没有调用方，其注释还声称有一个从未存在的调用方。
- Go 守护进程返回的 `/api/skill-stats` 是 `{"report":{"skills":…}}`，前端读的是扁平结构，`src/web/ToolStats.tsx:179` 因此抛错、页面渲染不出来。这是 Go 移植的 API 契约错配，与注释无关，但会让 `node --run e2e:console` 跑不起来。
- `src/web/Settings.tsx` 仍有 1300 多行，是 500 行上限的 2.6 倍；拆分是另一个根因。
- `scripts/check-floating-promises.mjs` 的输出仍写「No unawaited expect()…」，虽然守卫现在也管组合方法。

### 审计是怎么做的

6 个节点并行，各管一片，互不重叠：

| 节点 | 范围 | 读法 |
| --- | --- | --- |
| 1 | `src/core` | 65 个文件全部逐行读 |
| 2 | `src/runtime` | 70 个 `.ts` 文件全部逐行读（5 个 `.mjs`/`.cjs` 不在分片内） |
| 3 | `src/web` + `src/server` | 79 个文件全部列出注释，19 + 9 个逐行读 |
| 4 | `src/catalog` + `src/git` | 17 个文件全部逐行读 |
| 5 | `scripts` + `desktop` + `examples` | 40 个文件全部逐行读 |
| 6 | `backend/internal/graph` | 178 个非测试 `.go` 全文机械解析 3223 个注释块，其中约 180 个在代码上下文里逐个判断 |
| 7 | `backend/internal/pigkernel` + `backend/cmd` + `tests` | Go 侧 9 个文件全读；`tests/**` 326 个文件全量模式扫描，5 个注释密集文件逐行读 |

每个节点报的每条结论都带 `file:line`。主会话对高影响项逐条复核：把注释删掉后剩下的代码是否真的自解释、重复文档的「另一处」是否真的存在、声称的外部依赖是否真的是外部依赖。复核中否掉了一类结论——「注释解释了紧邻代码的意图」不成立为删除理由，除非紧邻代码确实已经说明。

## 验证方式

- 每个单元独立成一次提交，提交前跑 `node --run check`（后端构建 + vet、typecheck、lint、测试、基线、证据）。
- Go 侧改动额外看 `go -C backend vet ./...` 和 `node --run check:backend`。
- 注释删除本身不改变行为，测试套件必须全绿；`tests/console/schema-version.test.ts` 直接读 `src/core/store.ts` 源码文本，是注释删除最容易踩到的门禁。

### 本单元的行为等价证明

注释删除不改变行为，但「删了注释所以行为没变」这句话本身需要证据，不能只靠断言。三条独立证据：

1. **TypeScript / JavaScript**：用仓库自带的 esbuild 把 31 个改动文件在改前与改后各转译一次并最小化，两份产物**逐字节相同**。转译器会丢弃注释，产物相同即语义相同。
2. **Go**：用 `go build -trimpath` 编译 main 与本分支两个二进制，`go tool objdump` 逐个函数比对反汇编：**40193 个函数里有 40192 个机器码逐字节相同**。唯一不同的是 `_go:buildid`——它不是代码，而是链接器嵌进二进制的构建 ID 字符串，内容是源码的哈希。源码字节变了（注释被删），哈希就变，所以这个函数必然不同；同一份分支源码编译两次，它又完全一致。
3. **前端产物**：`vite build` 产出的 `dist/web` 全部 js 与 css 的聚合哈希，改前改后**一致**。

关于 buildid 的对照实验：不加 `-trimpath` 时，同一份源码编译两次就有 21787 个函数因构建路径而不同，噪声大到无法判断。`-trimpath` 消掉路径噪声后，同一份源码两次编译的差异收敛到 `_go:buildid` 这一个函数——这个「噪声地板」说明比对方法本身是敏感的：真正由注释删除带来的差异也只有这一个函数，而它是源码哈希，不是可执行代码。

测试套件方面，本机的并发压力让失败数在几轮之间大幅波动，而且**失败的文件集合每轮都不同**——这本身就是环境噪声而非代码问题的特征。同一台机器上，干净 main 的完整 `node --run check` 失败 11 个文件，本分支失败 4 个；把 main 失败的那 11 个文件拿到本分支重跑，11 个里 9 个直接通过，剩下的 `tests/m1/recovery.test.ts` 单独连跑 5 次也是 5 次全过。

机器空闲下来之后，本分支的完整套件一次跑通。**在第 1 步（只有注释改动）落地时是 291 个文件 / 1553 项测试、0 失败，套件规模与基线一致，验收证据未变。**第 2 到第 7 步落地后重新测：排除 main 上那个已经坏了的 `tests/e2e/harness-probe.test.ts` 之后，**293 个文件、1554 项测试、1550 通过、4 跳过、0 失败**。那个文件在本分支与干净的 main 上失败方式完全相同（见下面的「后续可做」一节）。

另外两类失败是外部原因，与本改动无关：`tests/e2e/pig-kernel-update.test.ts` 要从网络拉 Go module，本分支连跑 3 次全过，main 上也全过；`tests/e2e/package-preflight.test.ts` 断言的是磁盘剩余空间，取决于当时机器上还有多少 GiB。

失败来自机器同时跑着另外 4 个工作树的测试套件，以及依赖网络的用例，不是本次改动。

## 覆盖与缺口

- `tests/**` 全部 326 个文件做了模式扫描，其中 5 个注释密集的文件逐行读了上下文；其余 190 个低密度文件只扫描模式、读了文件头，未逐行判断。`tests/fixtures/**`（20 个文件）只扫未读。
- `src/web` 有 30 多个文件只做了清单扫描和抽样，未逐行判断；其注释风格以导出符号的契约 JSDoc 为主，抽样未发现 meat。
- 注释密度本身不构成问题（删除后）：`src/core` 2130 行注释 / 65 文件，`src/runtime` 1839 / 74，`backend` 5673 / 191。大部分是有价值的契约与外部约束说明。
