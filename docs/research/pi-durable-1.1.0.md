# Graph 迁移至 pi-durable 1.1.0：版本与运行语义核对

调研日期：2026-10-12。目标是 main 与节点统一替换为 durable 的 Agent 执行与持久任务基础，而保留接口投递、模块、共享产物和预算的产品契约。用户允许清理旧 graph 执行历史，main 会话与配置必须保留。本文未调用真实模型或迁移用户数据库；执行了下述独立 SQLite/Harness 最小 spike，其他迁移闸门仍是待验证项。

## 权威来源与版本

- [npm 1.1.0 metadata](https://registry.npmjs.org/@earendil-works/pi-durable/1.1.0) 和 [tarball](https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.1.0.tgz)：包名 `@earendil-works/pi-durable`，Node `>=22.19.0`，直接依赖 `@earendil-works/pi-ai ^1.1.0`、`@earendil-works/chord ^1.1.0`、`diff 8.0.4`、`typebox 1.3.27`，没有依赖 coding-agent 或 agent-core。
- 实际下载包按 registry 的 `sha512-NtuB3RY24vQ+0/rWYpeHupyFWBfXuKq17to3VMYUYqfD/uuGnz6F6UTPBEm51VSxxA6LZwRcDwLX2LtRehnIgQ==` 校验通过。metadata 未提供 `gitHead`；本次 provenance endpoint 访问因 TLS EOF 失败，不能声称已经验证签名或构建来源证明。
- [`v1.1.0`](https://github.com/earendil-works/pi/tree/v1.1.0) 解引用 commit 为 [`abe508e1b89912adde45528136c3221eb69acdd7`](https://github.com/earendil-works/pi/tree/abe508e1b89912adde45528136c3221eb69acdd7)。发布包 67 个 JavaScript source map 中对应的 `sourcesContent` 与该 tag 的 durable 源码逐字比较，67/67 一致，0 差异。这是包 API 与 tag 一致的直接证据，不能替代 provenance 验证。
- 用户提供的 [pi-durable-book](https://github.com/robotbird/pi-durable-book) 是中文导航与翻译线索。以下 API 判断只使用锁定 commit 的第一方代码，不把该书引用的上游 main 当作 1.1.0 API。

下载与只读检视材料置于 `/tmp/graph-pi-durable-upstream`，未安装进 Graph 仓库。Graph 当前直接依赖的 pi-ai、pi-agent-core、pi-coding-agent 为 `0.86.1`（`package.json`）；durable 并非旧 SDK 的另一个 SessionManager 后端。

## 可以直接调用的接口

| 用途 | 1.1.0 接口 | 对 Graph 的意义 |
| --- | --- | --- |
| 宿主 | `Harness.open(storage, { models, registry, ... }, context)` | Harness 拥有一个 Session 的变更串行线与任务调度器。 |
| Node SQLite | `/storage/sqlite/node` 的 `openNodeSqliteStorage(path)`、`openNodeSqliteDatabase(path)` | 使用 Node 内置 SQLite；不是 Graph 现有 TaskStore 的即插即用后端。 |
| 可移植 SQLite | `/storage/sqlite` 的 `SqliteStorage.open(database)`；`SqliteDatabase` | 自定义异步 facade，可用于命名空间和同连接事务适配。 |
| 会话 | `root(context, options)`、`createConversation({ ownership, agent, init }, context)`、`conversation(id, context)` | 节点与 main 可以各保留稳定会话；domain ID 与 durable 数字 ID 需要明确映射。 |
| 执行 | `conversation.submit({ type: "input", content, requestId, whenBusy }, context)`，`Submission.wait(context)` | `whenBusy` 为 `steer`、`followUp` 或 `reject`；相同会话 requestId 可找回原 submission。Graph 的 submission 是具名输出发送，不能与这个输入受理记录混名。 |
| 任务 | `defineTask`、`tx.createTask`、`runtime.commit`、`waitForTask` | durable 任务是 checkpoint 状态机，终态结果与等待子任务可持久化。 |
| 文档 | `defineDoc` / `defineDocFamily`、`tx.doc`、`snapshot`、`watchDoc` | typed JSON 可与 entry、task 在一笔 Session commit 中更新。 |
| 恢复 | `resume()`、`inspect()`、`submission(id, context)` | open 不等于启动；submit/wait 等请求进展的调用也会开启调度。只读 inspect 不执行任务。 |
| 扩展 | `defineExtension`、`defineTool`、`section`、`hook`、`wrapTool`、`createRegistry` | Graph 工具、提示词与权限 gate 需要转换为 durable 扩展，不能直接传旧 coding-agent InlineExtension。 |
| 事件 | `conversation.stream` / `watch`、`watchEvents`、`subscribeCommits` | 发布的是已提交状态。UI/SSE 应消费事实投影，不把 stream chunk 先当正式事实。 |

接口依据：[package exports](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/package.json)、[root exports](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/index.ts)、[Harness/Conversation types](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/types.ts)、[Node SQLite](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/storage/sqlite/node.ts)。

## 原子提交与数据库边界

Session commit 原子覆盖 entries、完整 task records、Chord documents；外部副作用不在这笔变更事务内执行。commit 被存储接受后才发布，未知存储提交失败会使当前 Session 致命失效，必须重新打开。`subscribeCommits` 是提交采用后的同步观察，不能阻塞、抛错或调用 Session API；它不是提交前的应用 SQL hook。[规范不变量](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/docs/spec.md)、[Session API](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/types.ts)。

官方 SQLite schema 使用裸 `tasks`、`conversations`、`entries`、`submissions`、`documents`、`record_ids` 等表名；schema 版本位于 `durable_schema`，不使用 Graph 的 `PRAGMA user_version`。Graph 已有 `tasks`、`conversations`，因此直接 `openNodeSqliteStorage(Graph 原 DB)` 会碰撞，绝不可在用户 DB 上试。官方 durable `Tx` 不暴露 raw SQL executor；另开 `SqliteDatabase.transaction` 也不会自动加入 Session 事务。[迁移 SQL](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/storage/sqlite/migrations.ts)、[commit 实现](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/storage/sqlite/storage.ts)。

**Inference / 迁移建议**：若继续遵守 ADR 0030 的同 SQLite 正式存储决策，应提供明确命名空间的 Storage 或 SqliteDatabase adapter，并证明 durable records 与所需 Graph domain writes 使用同一连接、同一 transaction。不能只给 SQL 做任意字符串替换而未经 conformance 验证。另一选择是把 domain state 放入 durable documents、现有表变成幂等可重建投影；但必须明确哪边是事实权威以及发布/投影崩溃窗口。单独 session.sqlite 并以工具回调写 TaskStore 会形成双写窗口，不满足原子 claim；若采用，应显式调整 ADR 与恢复契约。

官方 SqliteStorage 不提供 tablePrefix 参数，constructor 也不是 public；数据库 facade 只接 SQL 文本与 bindings，无法要求其传入结构化 table name。**Inference / 实现取舍**：复用 SqliteStorage 的命名空间 facade 必须词法识别 SQL identifier，只对已知表/索引名进行替换，完整保留字面量、注释和参数；显式禁止未识别 SQL，比任意正则 replace 可审查，但仍需覆盖全部迁移/查询与上游 conformance。原生自定义 Storage 避免 SQL rewriting，但必须实现 numeric mintId、全局记录 ID 不重用、fork 可见性、分页、document incarnation/历史等完整契约，不能只做一个 Map 的 JSON 落盘。将已存在 TaskStore.db delegate 进 facade 时还需定义连接所有权和 close：SqliteStorage.open 失败会调用 facade.close，不能意外关闭应用 DB。共享连接的异步 durable 事务必须阻止普通 TaskStore 代码在 await 期间穿插写入。

**Inference / 原子业务命令**：可把待应用 Graph command 的 durable outbox document 与 tool/task receipt 在同一 Session commit 中保存，然后由同 DB 的 domain transaction 使用稳定 requestId 幂等受理并标记 command 应用状态；明确 outbox 是命令，Graph domain rows 是业务事实，避免两个独立运行状态真源。仍须验证 domain 已提交但 outbox acknowledgement 未提交时的恢复，以及 SSE 只发布 domain 已受理事实。这是设计候选，不是官方 API 自带事务桥。

Node adapter 将异步事务串行化，执行 `BEGIN IMMEDIATE`；事务 callback 必须使用收到的 transaction handle，在 callback 中调用外层 database 会等待自己而死锁。默认 WAL、`synchronous=NORMAL`、busy timeout 5000 ms；进程崩溃与断电持久性不同。一个 Storage 只由一个进程拥有，无跨进程 ownership lock。**Inference**：不能让每个现有 Pi child 同时打开同一 durable Storage；需要单独存储拥有者或设计验证过的 IPC 提交服务，WAL 锁不能替代 Session 单一 mutation line。[Node adapter](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/storage/sqlite/node.ts)、[Storage contract](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/types.ts)。

## 恢复、副作用与停止

工具 intent 在执行前保存；`replay` 默认 `unsafe`。崩溃恢复至 execute phase 时，只有存储 intent 和重新解析出的工具都为 `safe` 才重跑；否则记下 `interrupted` 错误结果，并说明可能已经部分执行。safe 不提供外部 exactly-once；仍需要幂等键、可查询 receipt 或 reconciliation。`api.taskId`、`callId` 和 `api.memo` 可以承载身份，但先写 memo 再执行副作用也可能丢失副作用，不能把上游 tick 示例解释成支付/写文件 exactly-once。[ToolTask](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/tool.ts)、[recovery example](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/test/examples/13-recovery.ts)。

`close` 保留尚未完成工作供 reopen；取消 context 中的 wait 只取消等待，不终止工作。`conversation.abort` 撤回排队输入、停止当前 ordinary ownership scope 并等空闲；默认不跨 background 边界。Graph 的暂停、停止、完成请求和 main 停驻需要分别映射，不能都叫 close/abort。[Harness types](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/types.ts)。

子会话由 task ownership 创建，父 abort / 失败会下传；background anchor 可让常驻子会话独立于一次工具调用。task 等子任务可用 `allSettled` 或 `failFast`，尚有 owned work 时进入 completing。**Inference**：Graph 节点要长期接受返工，应绑定稳定节点 identity 与会话，而非每次 send 工具都创建一个会在工具结束时被收拢的短命子代理。[后台子代理示例](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/test/examples/23-subagent-background.ts)、[子任务示例](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/test/examples/24-child-tasks.ts)。

## 动态图与配置冻结

durable `taskGraph()` 是当前 live tasks 的 ownership/wait 状态观察，不是 Graph 的节点、具名接口、边、协议、模块和图修订定义；terminal task 会离开该视图。它不能直接替换用户 task graph。**Inference**：domain 图定义、投递受理、模块触发和修订仍由 Graph domain 层验证；durable 承接执行轮次、checkpoint、会话和恢复，必要时以自定义 tasks/docs 包住正式 domain transition。[task graph 定义](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/task-graph.ts)、[任务规范](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/docs/spec.md)。

registry 持久化的是名字引用而非代码。同名 install 立即替换；task phase 取得一个 registry snapshot，已执行的工具继续旧实现，下一 phase/工具可取新实现。模型 request 的 model、prompt 和 tools 在准备时固定，但 `configure` 改 cwd/extensions 仍可能作用到模型已经提出、尚未执行的工具。重启后需要重新安装定义，缺失 task 会被 inspect 报告而不是凭空继续。[registry](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/registry.ts)、[reload 示例](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/test/examples/31-reload-and-restart.ts)、[Agent configuration](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/types.ts)。

**Inference**：Graph 的能力 digest、执行时 instructions/skills/cwd 与重绑审计不能缩减为 durable extension name。可用版本化 extension names 与持久执行配置，或者在节点 execution 空闲边界才应用变更；需要测试工具已经被模型提出时修改图不会改变该次执行的权限与工作副本。

## 模型、用量、tools 与 0.86.1 兼容

1.1.0 使用 `createModels()`、`setProvider()`，第一方 provider factory 或 `createProvider({ id, auth, models, api })`；custom provider 的 stream/streamSimple 是正式适配入口。durable 接受 Models，不接受 Graph 当前 agent-core StreamFn 作为同形参数。Pi message 体系增加 positional system transcript 等契约，旧 JSONL SessionManager 不能假定直接解析为 durable entries。[Models](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/models.ts)、[generation](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/generation.ts)。

`pi.usage` 按 provider/model、tool 累加数字与成本，失败/中止尝试也计入；其 Usage 类型没有 Graph 的 authoritative/account_delta/estimated/unknown 证据等级。**Inference**：保留 Graph 的发送前预算预留、调用证据、未知用量处理和幂等结算；用 provider adapter 或 Hooks 接入，不能把 durable 数值 0 认定为已知零，也不能把 cache 或 reasoning 重复相加。[UsageDoc](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/usage.ts)、[Usage type](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/types.ts)。

官方 CodingTools 是 `read/write/edit/bash` 的显式安装扩展，没有自动加载。Node ExecutionEnv 是工具环境抽象，不自动等于 Graph 沙箱、网络策略、技能发现或 MCP 配置。需将 Graph 的已授权能力转换成工具与 section，并用 `beforeTool`/`afterTool`、`beforeRequest`/`afterResponse` 等 Hooks 或 custom provider gate 保持控制。[tools exports](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/tools/index.ts)、[hook types](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/harness/types.ts)。

## 已执行的最小 SQLite/Harness spike

在 `/tmp/graph-pi-durable-spike` 创建独立 npm 项目，精确安装并锁定 `pi-durable`、`pi-ai`、`chord`、`pi-codemode` 全部 1.1.0；`npm ls --depth=1` 显示 durable 的 chord/pi-ai 引用 dedupe 至相同 1.1.0。使用 Graph 提供的 Node v24.20.0 执行 `/tmp/graph-pi-durable-spike/spike.mjs`，退出码 0，未调用真实模型或打开用户 DB。

- `createConversation` 生成 ID 2，保留节点 instructions；一笔 `conversation.commit` 保存 doc `visits=7` 与 pending task ID 9。
- close 后重新打开同一临时 SQLite，assert 会话 ID、instructions、doc 7、pending task 均保留，尚未启动 scheduler。
- `waitForTask` 启动真实 Harness 调度，定义的 durable task 在 commit 内将 doc 加至 8 并进入 terminal completed，result 为 `resumed`。
- 第三次 reopen 验证 terminal receipt 和 doc 8 保留。
- 另一个临时 DB 预建 Graph 形状的 `tasks(id TEXT)` 与 `conversations(id TEXT)`；官方 `openNodeSqliteStorage` 实际失败 `Error: table conversations already exists`。断言 migration transaction 回滚，原 tasks 结构仍为 TEXT，`durable_schema` 表不存在。

该实测证明发布包接口、SQLite 持久性与 pending task reopen 基础可用，以及表碰撞是实际失败；没有证明 kill 中途恢复、真实 provider 调用或 Graph 迁移已完成。

## 迁移闸门

以下为建议，尚非完成证据：

1. 在独立临时项目精确锁定 durable/pi-ai/chord 1.1.0，使用实际 npm package imports 与 SQLite；将 0.86.1 同名类型彻底隔离，确认 Node 运行时导出可用。
2. main 与 planner/worker/reviewer 使用稳定 conversation 映射；真实工具写临时 git 工作副本并投递结果，审查后原 worker 收返工，验证 transcript、累计预算与节点 identity 保留。
3. 对提交前、外部副作用后、tool-result commit 前注入进程终止；unsafe 产生 interrupted 并交 main reconciliation，safe 幂等操作重放无重复投递，不能仅 graceful close 冒充 crash。
4. 同一存储事务中同时更新 Graph 投递与 durable task/doc；注入存储失败，验证 rollback、未发布事件、重新 open 后事实一致。custom Storage 运行上游 `registerStorageConformance`；真实进程独占恢复另测。
5. 执行中改变 instructions/skills/cwd/model/图边，验证当前 execution 配置冻结、下一轮生效、已受理投递不被撤回；修改同名 registry extension 的上游 phase 行为作为对照。
6. 预算耗尽、provider 缺少 usage、失败后恢复和 compaction 均走 Graph ledger；核对实际鉴权/headers/sessionId 不丢失，没有升级成无 gate 的第二请求通道。
7. 迁移前备份并显式定义 main 会话转换 reader 与恢复规则。用户允许清理旧 graph 执行历史，但不可误删 main anchor/conversation、配置、能力定义与快照、已发布产物或用户工作副本；旧图历史的清理范围需按精确 identity/table 分类执行。正式切换前跑完整 `node --run check`、应用构建和真实节点恢复。

相关上游可运行示例：[recovery](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/test/examples/13-recovery.ts)、[真实模型](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/test/examples/16-real-model.ts)、[coding agent](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/test/examples/26-coding-agent.ts)、[自定义 Storage conformance API](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/durable/src/testing/index.ts)。
