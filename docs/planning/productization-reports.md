# Graph 产品化任务交付报告

按 [产品化待办](productization-todo-2026-09-13.md) 逐项实施，每个任务独立提交，交由独立验收复核。测试数量从 179 增至 187（新增 `tests/m8/startup.test.ts` 8 项），全量 38→39 文件。

## T01 · 统一启动与首次运行入口

- 起始提交：`48ac048`
- 完成提交：本次 T01 提交（见 git log）
- 修改范围：
  - 新增 `src/server/config.ts`：版本 1 配置 schema、字段校验、相对项目根解析、凭据 `secretRef` 解析、默认 stateDir。
  - 新增 `src/server/start.ts`：`startGraphDaemon()`，校验 Web 构建、加载配置、按 provider 注册模型 transport、仅在凭据齐全时启用模型、view/execute 模式与启动信息。
  - 新增 `src/server/cli.ts`：参数解析、首次运行、SIGINT/SIGTERM 有界停止（5 秒）、错误码与退出码。
  - `src/server/host.ts`：监听失败（含 `EADDRINUSE`）时关闭 runtime 并释放 owner；新增 `startup` 信息透传。
  - `src/server/app.ts`：新增 `GET /api/startup`。
  - `src/web/App.tsx`：首次运行/凭据缺失与仅查看模式横幅。
  - `package.json`：`start`、`start:execute`、`dev` 脚本；`vite.config.ts`：`/api` 代理到守护进程。
  - `tests/m8/startup.test.ts`、`README.md` 启动章节。
- 新增接口/配置：
  - `GET /api/startup` → `{ mode, configured, modelCount, enabledModelCount }`。
  - `graph.config.json` version 1；`--config/--state-dir/--web-dir/--port/--execute/--view-only`；环境变量 `GRAPH_CONFIG/GRAPH_STATE_DIR/GRAPH_WEB_DIR/GRAPH_PORT`。
  - 生效规则：启动时读取；配置变更需重启（热更新不在 T01 范围）。

### 验收清单

- [x] 干净临时配置下按文档命令打开真实 React 页面：`node src/server/cli.ts --config /tmp/t01-demo/graph.config.json --state-dir /tmp/t01-demo/state` → `http://127.0.0.1:4173`，浏览器加载真实 React 应用并显示首次运行横幅（模型 0 配置）。命令与输出：`docs` 无；复跑见下。
- [x] 重启及从不同 cwd 启动指向同一显式数据目录：stateDir 显式传入，配置相对路径按配置文件目录解析；`tests/m8` "restart keeps the same explicit state directory and its tasks"。`daemon.stateDir` 输出规范化 `realpath`。
- [x] 第二后台被 owner 锁阻止：`tests/m8` "a second daemon on the same state directory is rejected"（`owner_busy`），复用既有 `acquireOwner` 机制。
- [x] 端口占用/配置不存在/Web 构建缺失分别明确报错：`tests/m8` "missing web build, missing config, busy port and execution gaps"（`web_build_missing`、`invalid_config`、`port_in_use`、`models_missing`、`credentials_missing`），均非零退出（CLI 退出码 1，用法错误 2）。
- [x] 关闭浏览器不停止任务；仅查看模式零派发：浏览器关闭后 `/api/health` 仍 `{"ok":true}`；view 模式 `autoDrive:false`，模型 dispatch 不启动（`GET /api/startup` 显示 `mode:"view"`）。
- [x] SIGINT/SIGTERM 有界停止：`tests/m8` CLI 端到端测试 spawn 真实进程，SIGTERM 后 10 秒内退出码 0；5 秒超时则退出码 1 并提示在途调用重启后核查。
- [x] 只绑定 loopback：`openGraphServer` 固定 `host:'127.0.0.1'`；自动化测试不依赖真实供应商凭据（view 模式）。

### 测试与运行

- `tests/m8/startup.test.ts`：8/8 通过（1 次；提交前全量复跑时仍为 8/8）。
- 全量：`vitest run` 39 文件 / 187 项通过（T01 提交时 1 次）。
- 双 tsc 通过。真实浏览器手动检查 1 次（构建 `dist/web`，浏览器关闭后守护进程存活，SIGTERM 干净退出）。

### 边界与已知限制

- execute 模式真实派发依赖 T02 的凭据绑定与 T04 的并发控制；T01 仅验证拒绝路径与 view 模式。
- `pnpm dev` 为前端开发服务器，需另开守护进程；不提供 launchd/安装包（按待办范围）。
- 未运行真实供应商调用，无新增用量。

## T02 · 持久配置与模型/凭据绑定

- 起始提交：`3edf24a`
- 完成提交：本次提交
- 修改范围：
  - `src/runtime/pi-adapter.ts`：新增 `apiKeyFor(entry)`，实际发送前按模型解析凭据；无凭据即 `model_unavailable`，不发请求。
  - `src/core/task-runtime.ts`：`models` 选项新增 `credentialFor`（凭据 ID + 密钥）与可选 `apiKey`（旧单 key 兼容）；新增 `config.revision()`，任务创建的 `task.created` 事件记录 `configRevision`。
  - 新增 `src/server/config-service.ts`：`openConfigStore()` 原子保存（临时文件 + rename，0o600）、跨进程编辑锁、revision 检查（`config_conflict`）、`sanitizeConfig()` 脱敏 DTO。
  - `src/server/app.ts`：`GET /api/config`（脱敏 + revision）、`POST /api/config`（校验后保存，返回 `restartRequired`）。
  - `src/server/host.ts`、`src/server/start.ts`：配置服务注入；按模型 id 建立凭据映射；启动时解析环境变量，密钥不进入快照/日志/DB。
  - `tests/fixtures/openai-server.ts`：记录每次请求的 Authorization 头。
  - 新增 `tests/m8/credentials.test.ts`。
- 新增接口/配置：`GET/POST /api/config`；配置新增 `revision` 字段（由服务维护）；`task.created` 事件新增 `configRevision`。
- 生效/迁移规则：配置保存后第一版**需重启守护进程生效**（响应 `restartRequired: true`）；执行中任务保持原绑定，历史事件记录当时的 revision。旧 `apiKey` 编程入口保持可用；配置文件与 T01 相同 schema，旧文件缺少 `revision` 按 0 处理。

### 验收清单

- [x] 两个本地端点各收到自己的凭据、模型切换不串 key：`tests/m8/credentials.test.ts` 用两个合成 provider 各自断言 `Authorization: Bearer key-alpha` / `key-beta`，交叉数为 0。
- [x] 重启后项目/模型/凭据引用/偏好保持；空凭据在派发前拒绝：配置服务 round-trip + T01 重启测试；无凭据模型的任务 provider 请求数为 0 且错误含 `No credential bound`（进入节点记录）。
- [x] 非法写入不损坏旧配置、并发编辑有冲突提示：`config_conflict`、`invalid_config` 后文件字节不变；保存使用锁 + 原子 rename。
- [x] 执行中修改受生效规则约束、历史指向原版本：第一版要求重启生效；`task.created` 记录 `configRevision`（测试断言 revision=7）。
- [x] 设置/任务详情/SSE/错误/导出均无秘密原文：DTO 只含 `secretRef` 与 `configured`；`/api/config` 文本断言不含合成密钥；密钥仅存在于 adapter 发送路径。
- [x] 旧单 key 用例与 A13 harness 兼容：全量 40 文件 / 192 项通过，未修改既有 `apiKey` 调用。

### 测试与运行

- `tests/m8/credentials.test.ts`：5/5；全量 40 文件 / 192 项通过（1 次）；双 tsc 通过。无真实供应商调用。

### 已知限制

- `restartRequired` 的界面提示与热重载不在 T02（T05 呈现）；`credentialId` 目前仅用于绑定与展示，并发限制在 T04 使用。

## T03 · 任务列表、对话与可视化主流程

- 起始提交：`387f259`
- 完成提交：本次提交
- 修改范围：
  - `src/core/task-runtime.ts`：任务列表新增 `projectId/request/status/updatedAt/acceptedProposalVersion`；任务视图新增 `updatedAt`（均为追加字段）。
  - `src/web/App.tsx`：重写主流程——项目选择与真实提交、任务列表（标题/项目/状态/更新时间/入口）、确认页展示准确提案版本、验收项、节点与目标分支，确认请求绑定页面显示的版本与分支；节点详情含实例、模型、定义、用量、证据；新增加载/空/错误/重试/断线重连状态。
  - `src/web/GraphCanvas.tsx`：状态图例、选中高亮、子图折叠、回边渲染为橙色虚线；为节点提供布局已知的 `measured` 尺寸，消除哈希切换时 ResizeObserver 测量竞态。
  - 新增 `src/web/event-cursor.ts`：SSE 游标去重（乱序/重复帧返回 null）。
  - 新增 `tests/m8/ui-flow.test.ts`。
- 生效规则：UI 与 API 通过公开任务接口交互，前端不建调度器；图仅反映正式状态。

### 验收清单

- [x] 真实浏览器完成可控任务全部主流程：`tests/m8/ui-flow.test.ts` 从概览选择项目、提交需求、查看提案、确认、等待完成、进入图页；确认请求体断言 `proposalVersion=1`、`targetBranch=feature-a` 与页面显示一致。
- [x] A/B 两项目两任务无串用；刷新/直达图地址恢复：同测试切换项目 A/B 后请求标题互斥；`page.reload()` 后图页恢复节点。切换任务时清空旧数据，避免显示上一个任务的残留。
- [x] 并行分支、子图与返工回边正确呈现、节点点击显示实例：同文件第二个测试断言 4 个节点、`data-testid` 含 `loop:` 的边、子图折叠/展开，节点详情含实例与有效验收证据。
- [x] SSE 断线重连追平与去重：流按 `after=<最后游标>` 重连，重复/乱序帧由 `nextEventCursor` 丢弃（单测覆盖重复、乱序、非法帧）；任务重启后的游标语义沿用既有 M6 主机测试。
- [x] 慢请求/500/不存在任务明确错误：不存在任务与合成 HTTP 500 均显示 `error` 及服务端消息，不无限加载。
- [x] 既有 listening 顺序、本地网络、暂停等回归：全量 41 文件 / 195 项通过，未改动这些路径。

### 测试与运行

- `tests/m8/ui-flow.test.ts`：3/3；`tests/m5/ui.test.ts`：2/2；全量 41 文件 / 195 项（1 次）；双 tsc 通过；真实 Chromium 无头浏览器。

### 已知限制

- 未做浏览器级别的强制断线演练（依赖游标重连实现与单测）；T04 的“等待名额”状态在 T06 呈现在本页框架内。

## T04 · 按凭据及共享组限制 API 并发

- 起始提交：`baef41d`
- 完成提交：本次提交
- 修改范围：
  - 新增 `src/runtime/model-scheduler.ts`：宿主级名额调度器，按 `credentialId` 与共享组计数；FIFO 扫描式发放避免队头阻塞；支持 `AbortSignal`、动态更低上限（在途不受影响）与可观测的 `active()/queued()`。
  - `src/runtime/controlled-openai.ts`：发送路径新增可选 `StreamSlot`，在 `gatedProviderFetch` 之前申请名额，在响应体结束、使用量证据完成、错误或取消后释放；名额覆盖完整响应生命周期（响应头不释放）。
  - `src/runtime/pi-adapter.ts`：`bindingFor` 返回模型对应的凭据与上限，仅在有上限时接入调度器；无凭据仍为 `model_unavailable`。
  - `src/core/task-runtime.ts`：`credentialFor` 增加 `limit/sharedGroupId/groupLimit`；新增可选 `modelScheduler`，缺省每个 runtime 创建一个。
  - `src/server/start.ts`：从配置把凭据上限、共享组与组上限绑定到模型；启动日志打印生效上限。
  - 新增 `tests/m8/concurrency.test.ts`。
- 接口/schema：配置 `limits.credentials.<id>`、`limits.sharedGroups.<groupId>` 与 `credentials.<id>.sharedLimitGroupId` 生效（T02 已定义）；无新 HTTP 接口。
- 生效规则：上限在守护进程启动时绑定；运行中修改配置仍按 T02 的“重启生效”规则（不热改、不强杀在途请求）。调度器是内存态，进程重启从零开始；旧请求的在途核查沿用 CallBroker/unknown usage 机制。

### 验收清单

- [x] 同 key 多模型、多实例、上限 2 时始终 ≤2：`concurrency.test.ts` 用 5 个不同密钥别名（同一 `credentialId`）并发，服务端记录的最大并发 ≤2，全部完成。
- [x] 不同 key 独立；同共享组合计受限；别名不能绕过：共享组上限 2 时两组请求最大并发 ≤2；无组时两凭据各限 1 可并行（服务端观察到并发 2）；同一凭据的多个别名共用同一计数器。
- [x] 响应头到达后阻塞响应体，名额不提前释放：300ms 响应体延迟下，活动数保持 1、第二个申请保持排队。
- [x] 成功、传输失败、用户取消正确释放；未知 usage 规则不变：成功、HTTP 500、门拒绝（暂停）与 `AbortSignal` 取消后 `active=0`；未知 usage 仍由既有 CallBroker 阻塞，不与名额混账（未改动该路径）。
- [x] 排队后暂停不得绕过门发送；恢复不重复计费：runtime 级测试在持有一个名额时暂停任务并释放名额，provider 收到 0 个请求，`invocations` 为 0，worker 不再活动。
- [x] 排队不持有长写事务、不阻塞查询：排队期间 `view()` 正常返回；独立凭据分支在另一测试中并行通过。
- [x] 重试重新申请名额并重过门：不可达端点触发 3 次 dispatch（每次重新过门），结束后名额释放。所有 Agent 调用（主管、工人、审查、压缩摘要）共用 `controlledOpenAIStream` 这一实际发送路径。
- [x] 运行中降低上限不强杀在途、新请求等待：调度器按最新请求上限判定，已在途名额不受影响（测试 3 覆盖等待语义）；通过配置修改的路径按 T02 明确要求重启。
- [x] 后台重启后无永久占用、无恢复瞬间超限：新调度器从空计数开始（测试），在途核查沿用既有机制。

### 测试与运行

- `tests/m8/concurrency.test.ts`：7/7；全量 42 文件 / 202 项（1 次）；双 tsc 通过。无真实供应商调用。

### 已知限制

- 本版仅并发；RPM/TPM、429 与冷却为 T09。等待名额目前不产生独立 UI 事件，T06 负责呈现。

## T05 · 可编辑设置与配置检查

- 起始提交：`bc8c52f`
- 完成提交：本次提交
- 修改范围：
  - 新增 `src/web/Settings.tsx`：`#/settings` 可编辑项目、模型、凭据引用、共享组与并发上限、价格与等级偏好；显示 revision、已配置/缺失、待生效；保存走 T02 版本检查与原子写入。
  - `src/web/App.tsx`：新增设置入口；`src/web/api.ts`：错误携带 `code/field`。
  - `src/server/app.ts`：配置保存前拒绝删除未完成任务在用的模型（`config_in_use`）；错误响应带 `field`；新增显式 `POST /api/config/test`。
  - `src/server/start.ts`：连通性测试实现（5s 超时、只发一次最小请求、不记录用量、不回显密钥；凭据缺失时不联网）。
  - `src/server/config.ts`：同一 provider 标签必须共享端点与凭据的校验（保存即报字段错误）；错误附带字段路径。
  - `src/core/task-runtime.ts`：`modelsInUse()` 供删除守卫使用。
  - `src/server/host.ts`：`close()` 幂等。
  - `tests/m5/ui.test.ts`、`tests/m8/ui-flow.test.ts`：各浏览器套件构建到独立临时目录，消除并发重建 `dist/web` 的资源竞态。
  - 新增 `tests/m8/settings-ui.test.ts`。
- 新增接口：`POST /api/config/test` → `{ ok, model, credentialId, status?, latencyMs, message? }`（仅显式调用；可能产生供应商用量）。
- 生效规则：保存后 `restartRequired`，运行中的绑定与历史不变；删除未完成任务在用的模型被 `config_in_use` 拒绝。

### 验收清单

- [x] 浏览器创建/编辑项目与两个模型、绑定不同凭据引用、设置共享组与并发，刷新及重启后保持：`settings-ui.test.ts` 完整覆盖，重启后 API 读回同一 revision 与值。
- [x] 空值/重复 ID/无效引用/上限有字段错误，失败不覆盖有效配置：重复模型 ID 保存返回 `config-error` 且文件字节不变；校验错误包含 `field` 路径，页面对应输入高亮；provider/凭据不一致同样拒绝。
- [x] 前端无法读取秘密；表单、响应、错误与页面文本均无合成 key：页面与 `/api/config` 文本断言不含密钥，DTO 只含 `secretRef` 与 `configured`。
- [x] 测试连接仅由明确点击触发、命中正确模型与凭据；普通设置操作零模型请求：点击前本地替身 0 请求，点击后恰好 1 次且 `Bearer` 密钥与 `model: "local"` 正确。
- [x] 价格未配置显示 unknown、不默认为免费；价格变更不重写历史用量：页面显示“价格未知（未配置，不会按 0 计算）”，用量估算沿用既有 `estimateCost` 未知语义，配置保存不触碰历史记录。

### 测试与运行

- `tests/m8/settings-ui.test.ts`：2/2；`tests/m5/ui.test.ts` 与 `tests/m8/ui-flow.test.ts` 改为独立构建目录后各 2/2、3/3；全量 43 文件 / 204 项，连续 3 次全绿；双 tsc 通过。无真实供应商调用。

### 已知限制

- 设置页第一版直接编辑配置文件文档，未做逐字段内联校验提示（以字段路径高亮 + 后端消息呈现）；偏好输入为逗号分隔文本。

## T06 · 节点记录、问题处理与用量展示

- 起始提交：`6766a1f`
- 完成提交：本次提交
- 修改范围：
  - `src/runtime/model-scheduler.ts`：新增 `snapshot()`（各凭据在途与等待数）。
  - `src/core/task-runtime.ts`：新增 `modelLimits()`；修正调度器变量作用域（声明移出 `try`，否则运行时报不可用）。
  - `src/server/app.ts`：新增 `GET /api/limits`（后端事实，不伪装供应商状态）。
  - `src/catalog/models.ts`：`ModelEntry` 增加可选 `credentialId`，供界面映射等待状态。
  - `src/web/App.tsx`：
    - 任务页新增节点状态列表（实例、用量未知显示、等待 API 名额、等待人工）；
    - 新增交付面板（目标分支、集成提交、交付目录、验收项与有效/无效证据）；
    - 未知用量问题区分“补记用量”和“无法核对（保留未知，需说明）”，引用准确 questionId；
    - 失败类问题按钮改为“重试”以匹配后台 answer 类型；问题数据以文本 `<pre>` 展示（外部输出不作为 HTML 执行）；
    - 节点详情：用量未知语义（不再 `?? 0`）、操作记录与“加载更多”分页、`durationMs` 与预留、验收证据有效/过期区分。
  - 新增 `tests/m8/records-ui.test.ts`。
- 生效规则：不涉及配置；界面只展示后端事实，等待状态来自 `/api/limits` 轮询。

### 验收清单

- [x] 成功/失败/等待/返工逐项定位：同任务中 `execution_failed`、`waiting`、`rework` 三类问题与 `ok` 成功节点、`gate` 阻塞节点均由浏览器测试逐项断言，状态文案为“执行失败/等待外部条件/需要返工”。
- [x] 回答一个问题不消除其他问题；过期/重复答复明确失败：等待问题答复后余 2 条，重试失败节点后余 1 条；非法/过期答复由后台拒绝并在页面显示错误（沿用既有 answer 校验）。
- [x] 未知用量可解释、仅授权答复路径核对、历史未知保留：Pi 供应商返回 `usage: null` 触发 `unknown_usage`，选择“无法核对”并填写说明后放行；调用记录仍为 `cost.unknown`。
- [x] 等待名额显示为等待而非执行：名额被占用时节点显示“等待 API 名额”，`/api/limits` 为 0 请求，释放后徽标消失。
- [x] 大记录分页、切换不串记录、工具输出仅为文本：操作记录按需加载（20 条步进）；节点/任务切换清空旧数据；`<script>` 输出仅作为文本，`window.__pwned` 未被设置。
- [x] 交付面板提交与证据绑定、无效证据不计入：面板显示目标分支、集成提交（无则明确“尚无集成提交”）与交付目录；验收项只统计 `valid` 证据，过期/无效另列。

### 测试与运行

- `tests/m8/records-ui.test.ts`：3/3；全量 44 文件 / 207 项，连续 2 次全绿；双 tsc 通过。无真实供应商调用。

### 已知限制

- 操作记录分页为“增加加载条数”而非游标分页；等待名额的刷新为 1.5s 轮询。T09 增加速率限制后复用同一等待展示。

## T07 · 使用文档与发布前整理

- 起始提交：`0d4effc`
- 完成提交：本次提交
- 修改范围：
  - 新增 `docs/usage.md`：最短启动流程、配置参考表、数据目录/端口/停止、排障表、权限与平台边界、Graph 控制台与 MediaBookmarks 的区别、配置迁移。
  - `README.md`：当前状态改为监听返工轮已关闭 + 产品化 T01–T06 已交付、T08 待独立验收；加入使用文档与产品化报告入口；删除对历史 A13 运行性质的复述，历史结论链接保留。
  - `docs/planning/handoff.md`：快照更新到 2026-09-13，工作区应为干净、当前测试数 44 文件 / 207 项、入口与边界；机器专属路径改为 `$REPO` / `$HOME` 说明。
  - `docs/graph-mvp.md`：状态改为 R13 关闭、产品化阶段指向报告与使用文档；示例路径去机器化。
  - `docs/implementation-plan.md`：新增产品化阶段指引；过期状态（“尚未运行真实收费模型请求”）改为引用证据。
  - `docs/planning/acceptance-evidence/usage-readme-start.output.txt`：按 README 从全新临时配置复跑。
- 生效/迁移规则：文档描述的默认值、字段与错误码与 T01–T06 实现一致；历史报告不覆写，仅追加链接。

### 验收清单

- [x] 按 README 从新的临时配置启动成功、不依赖 /tmp 脚本或隐藏状态：证据 `usage-readme-start.output.txt`（`node --run build:web` → `start --config /tmp/t07-readme/graph.config.json --state-dir … --port 0` → `/api/health` ok、`GET /` HTTP 200、SIGTERM 干净退出）。
- [x] 当前状态段不再误写“仅合成 A13/未运行真实模型/等待 R13 复验”，历史上下文保留：README、graph-mvp、handoff、implementation-plan 均已更新并链接历史报告。
- [x] 示例不含真实密钥、个人 Cookie 或机器专属绝对路径：新增与更新的示例只含合成值；当前文档中的工作区路径改为 `$REPO`/`$HOME` 说明，历史证据文件保持原样。
- [x] 文档命令、字段、默认路径与实现一致且声明链接证据：启动命令、`GRAPH_*` 环境变量、`/api` 错误码与设置页行为逐项对照实现；完成声明链接到 `productization-reports.md` 与 `r13-final-acceptance-2026-09-13.md`。

### 测试与运行

- 文档复跑 1 次；全量测试沿用 T06 提交的 44 文件 / 207 项（本次未改代码）；`git diff --check` 通过。

### 已知限制

- 文档未覆盖 Windows/Linux 的具体沙箱差异（平台边界以 architecture.md 与 M0 报告为准）。

## T08 · 新阶段整体验收与交接包

- 起始提交：`ed9677d`
- 完成提交：本次提交
- 提交范围：
  - 新增 `tests/m8/integration.test.ts`：从正式 CLI 入口（`node src/server/cli.ts --execute`）启动守护进程，全新临时 Git 项目 + 临时 stateDir，真实 Chromium 浏览器完成“配置 → 提需求 → 主管提案 → 确认（分支 main）→ 并发等待（凭据上限 1）→ 等待期间保存配置 → 两次未知用量答复 → 暂停/恢复 → 命令检查产物 → 交付面板”，SIGTERM 退出码 0，页面无 JS 错误。
  - 集成过程中发现并修复的缺口：
    - `src/runtime/task-gate.ts`：未知用量问题此前只插入 `questions` 表、不写事件，SSE 流因此永远收不到该状态（真实浏览器表现为界面停在“执行中”）。现同时记录 `question.opened`。
    - `src/core/store.ts` / `src/core/task-runtime.ts`：事件写入即唤醒监听者，并为流增加 250ms 兜底轮询，避免任何未通知写入导致实时状态缺失。
    - `src/web/App.tsx`：等待名额的 `/api/limits` 轮询收紧到 500ms，保证短暂的排队窗口可见。
  - 证据：`acceptance-evidence/t08-{integration,graph-full,verification,probes}.output.txt`、四张关键页面截图 `t08-{overview,confirm,waiting,delivery}.png`；README 启动流程在原 Node 下复跑 `usage-readme-start.output.txt`。
- 生效/迁移规则：不涉及新配置；修复只影响事件通知与展示。

### 验收清单

- [x] T01–T07 逐项证据或未完成项见 `productization-reports.md` 各节，未使用“基本完成”表述；T09/T10 为 P2 可选、未启动并在本节列为边界。
- [x] 项目 Node 24.20.0 下：全量 **45 文件 / 208 项**连续 2 次、双 tsc、`vite build`、`git diff --check` 全部通过（`t08-graph-full.output.txt`、`t08-verification.output.txt`）。
- [x] 原 R6、S4/R8、R9–R13 探针保持正确：8 个探针全部 `rc=0`（`t08-probes.output.txt`）。发送路径（T04）有改动，浏览器套件在本次均真实运行 Chromium；A13 交付副本未改动，沿用历史证据，未重跑昂贵真实供应商任务。
- [x] 真实浏览器完整流程通过：集成测试断言行为而非仅截图，并附四张关键页面截图；原始输出见 `t08-integration.output.txt`。
- [x] 失败/重启测试有界：所有探针与测试均使用硬超时；清理包含 5–8s 上限；运行后无孤儿进程（`ps` 计数 0）。
- [x] 报告含准确提交、变更范围、测试命令/次数/结果、未知与未验证边界、工作区残差：见本节与各任务报告。
- [ ] 独立验收：由使用者交独立验收 agent 按 Standards / Spec 复核；实现 agent 不代其宣布通过。

### 测试与运行

- `tests/m8/integration.test.ts`：项目 Node 下 1/1 通过（另在两次全量中各 1 次）；全量 208 项连续 2 次；探针 8/8。

### 未知与未验证边界

- 未运行新的真实供应商任务；A13 真实运行结论引用历史证据。
- 平台仅 macOS + 项目 Node；未验证 Windows/Linux。
- T09（RPM/TPM 与 429 冷却）与 T10（开源项目定向借鉴）为 P2，未实施；不影响本阶段通过范围。
- 工作区仅本提交涉及的文件；`M .gitignore`、`docs/planning/m2-handoff.md` 已按使用者要求入库，无其他残差。

## 返工轮 PA01–PA04（2026-09-13，响应 [独立验收](productization-acceptance-2026-09-13.md)）

基线：`23aeef1`。独立验收确认 T01–T08 不能关闭，列出四项缺陷；按 PA01/PA02 → PA03 → PA04 顺序修复。

### PA01 · 同一实际 key 的多个凭据别名绕开并发上限

- 宿主按解析后的实际密钥值归一：同一值（相同或不同 `secretRef`）的别名使用同一个调度身份，凭据上限取别名中的**最严格值**；别名指定多个不同共享组时以 `invalid_config` 拒绝（明确的冲突策略）。调度键仍是可读的规范别名，`/api/startup` 增加 `limitAliases`，界面按映射匹配等待状态，不暴露密钥。
- 发送层增加纵深防御：调度器接受可选 `apiKey` 并以内部指纹归一计数（产品路径由适配器传入实际密钥），即使宿主漏掉归一也不会超发；指纹不出现在快照与接口。
- 证据：`tests/m8/rework.test.ts` 两种别名场景（同 `secretRef`、不同 `secretRef` 同值）经正式 daemon 各跑两个模型，实际 key 在途始终为 1；`/api/startup` 文本不含密钥。
- 说明：验收方 `product-key-alias.mts` 直接构造调度请求（不含密钥材料、`credentialId` 互不相同），因此仍报告 2；该探针验证的原始接口不再对应产品路径，daemon 级验收标准由上一条测试覆盖。

### PA02 · 等待 key A 占满执行名额阻塞独立 key B

- `operations` 新增 `waiting_slot`（schema v10 迁移）：在凭据名额上排队的操作不再计入 Agent/程序执行名额；`run()` 与 `remainingSlots()` 共用同一 `occupiedSlots()` 判定。
- `drive()` 命中执行上限时按 20ms 重扫就绪节点，使独立凭据节点不被排队者挡住；恢复时仍重新申请名额并重过发送门（T04 语义不变）。
- 顺带修复：确认图中的主管（discussion）节点不属于已确认图计划，`readyNodes` 现在过滤计划外节点，避免 `readiness` 崩溃。
- 证据：`tests/m8/rework.test.ts` 十个 A 等待者 + 独立 B：`queuedA=10` 时 B 实际发送并成功；验收方 `product-independent-key.mts` 复跑 `providerRequests:1`（修复前 0）、A 仍为 running、暂停/释放后无超发。

### PA03 · 未重启的新任务记录尚未生效的配置版本

- 运行时在启动时冻结生效 revision（`effectiveRevision`），`task.created` 只记录该值；保存返回的 revision 只代表持久化版本。`/api/startup` 暴露 `effectiveRevision`，设置页同时显示“已保存 revision / 当前运行版本”，并说明连通性测试使用运行版本。
- 附加检查：配置移除的旧项目保留历史任务但不能再创建新任务——`begin` 按当前配置校验项目，`/api/settings` 只列出当前配置项目。
- 证据：`tests/m8/rework.test.ts` 保存 revision 1 未重启的任务记录 0、重启后记录 1；被移除项目返回 `invalid_input` 且历史任务仍可读；验收方 `product-config-revision.mts` 复跑 `configRevision: 0`（修复前 1）。

### PA04 · 图节点完成后记录与证据不刷新

- `GraphPanel` 的同一任务事件现在合并刷新 graph、task view 与 operations（150ms 去抖），不需要离开页面或点击“加载更多”。
- `useAsync` 增加请求代次：切换任务后，旧任务的迟到响应不能覆盖当前页面。
- 证据：`tests/m8/rework-ui.test.ts` 页面停留即看到操作记录与有效证据出现；A→B 快速切换并延迟 A 响应后页面始终只显示 B；验收方 `product-live-records.mts` 复跑 `afterCounts.view=3、operations=3`（修复前各为 1）。

### T08 测试健壮性

- `tests/m8/integration.test.ts` 的 SIGTERM 退出码断言移出被吞异常的清理段，改为在测试体内断言退出码 0、`exitCode` 0 且进程不存在；截图写入临时运行目录，全量测试不再改写仓库内证据文件。

### 复验

- 项目 Node 24.20.0：全量 **47 文件 / 215 项**连续 2 次通过；双 tsc、`vite build`、`git diff --check` 通过；八个历史探针全部 `rc=0`；验收方四个探针复跑结果见 `acceptance-evidence/rework-probes.output.txt`。
- 未运行新的真实供应商任务；A13 历史结论不变。是否关闭 T01–T08 由独立复验决定。

## 返工轮 2 · PA02-R1 与 PA05（2026-09-13，响应 [第二次独立验收](productization-rework-acceptance-2026-09-13.md)）

基线：`071e21b`。PA01/PA03/PA04 关闭；本轮修复恢复时的执行名额与保存期凭据组冲突。

### PA02-R1 · 等待恢复时重新获取全局 Agent 名额

- 新增 `src/runtime/execution-slots.ts`：统一的 Agent（10）/程序（4）执行名额判断与 `waitForAgentExecutionSlot()`——在事务内原子地检查名额并把 `waiting_slot` 置 0；名额满时每 20ms 重试，支持取消。
- `execution.ts` 的 `remainingSlots()` 与 `run()` 准入共用该模块，避免两处计数分叉。
- `pi-adapter` 的发送前衔接改为：等待凭据时置 `waiting_slot=1`（不占执行名额）→ 取得凭据名额 → **重新取得执行名额** → 才调用发送门；取消/失败时归还凭据名额并保持等待释放状态。
- 效果：20 个同 key 等待者同时恢复时，实际在途模型调用始终 ≤10，其余仍处于等待（`waiting_slot=1`），最终能全部完成且不死锁；key 自身上限不受影响，不通过提高全局上限规避。
- 证据：`tests/m8/rework.test.ts` 的 20 等待者恢复测试（20 个请求、`maxInFlight ≤ 10`、全部完成）；验收方 `product-resume-execution-cap.mts` 复跑 `providerRequests:10、maxProviderInFlight:10`（修复前 20）。

### PA05 · 冲突的凭据共享组在保存前校验

- `src/server/config.ts` 新增 `assertCredentialGroups()`：解析宿主可用的凭据身份后，同一实际 key 的别名若声明多个不同共享组即抛 `invalid_config`，并带字段路径。
- `openConfigStore.save(document, revision, env)` 在**原子替换前**执行该校验；`POST /api/config` 传入 daemon 环境。冲突保存返回 400、文件字节与 revision 不变，用户可在页面上继续修复。
- `startGraphDaemon` 改用同一校验：执行模式拒绝冲突；查看模式记日志并禁用模型派发而不是整体启动失败，手改的冲突文件仍可打开控制台。
- 证据：`tests/m8/rework.test.ts` 覆盖同 `secretRef` 与不同 `secretRef` 同值两种冲突（保存 400、字段错误、文件/revision 不变、修复后可保存重启、view 模式可启动、execute 模式拒绝）；验收方 `product-config-alias-conflict.mts` 复跑 `saveStatus:400、restart.started:true`。

### 复验

- 项目 Node 24.20.0：全量 **47 文件 / 217 项**连续 2 次通过；双 tsc、构建、`git diff --check` 通过；八个历史探针 `rc=0`；独立探针输出见 `acceptance-evidence/rework2-independent.output.txt`、`t08-probes.output.txt`。未调用付费供应商；是否关闭由独立复验决定。

## 返工轮 3 · PA02-R2（暂停拒绝的工作不再误报成功）

基线：`35118a5`。第三次独立验收确认 PA05 关闭、并发上限修复通过，保留 PA02-R2：暂停后发送门拒绝的工作被适配器当成正常回合结束，节点记 succeeded 且零请求，恢复后后继节点被直接推进。

### 修复

- **发送前拒绝可见**：`pi-adapter` 用 `observedGate` 包装发送门，只有在自己未调用 `send()` 时捕获拒绝（暂停/预算/未知用量），在 `session.prompt()` 返回后重新抛出，不再被受控流的 error 事件吞掉。
- **未发送的工作回到可恢复状态**：`execution` 的异常路径识别这三种门拒绝，且仅当该操作**没有任何 invocation** 时，把操作置为 `not_sent`、节点回到 `pending`；暂停不产生问题，预算/未知用量分别打开对应问题。已有部分发送或已知用量的情况仍走原有 unknown/recovery 规则，不丢用量、不虚增。
- **模型/传输错误不再当成成功**：适配器检查末次 assistant 的 `stopReason === 'error'`，返回 `failed`（由既有 `execution_failed`/unknown usage 规则结算），不再返回 `completed`。
- **等待标记写入不再吞错**：`waiting_slot` 影响正式调度，写入失败现在会进入可处理的失败路径，而不是被注释成 telemetry 后忽略。

### 复验

- 新增回归 `tests/m8/rework.test.ts`：20 个节点在凭据队列中暂停 → 释放占位并收敛后，0 次请求、0 个成功节点、后继检查保持 pending、名额归零；恢复后 20 次请求、全部成功、最大并发 ≤10；另有正常恢复与名额上限回归保持通过。
- 验收方探针 `product-pause-false-completion.mts --pause` 阶段输出：暂停后 `providerRequests:0、succeeded:0`，恢复后 `providerRequests:20` 且全部节点 succeeded；`product-resume-complete` 20/20、最大并发 10；`product-resume-execution-cap` 在途 ≤10；PA05 相关探针保持通过。探针末尾断言（期望恢复后仍为 0 请求）与其报告的第 2 条关闭标准冲突，按报告“以阶段结果为准”判定，说明见 `rework3-independent.output.txt`。
- 项目 Node 24.20.0：全量 **47 文件 / 218 项**连续 2 次通过；双 tsc、构建、`git diff --check` 通过；八个历史探针全部 `rc=0`。未调用付费供应商；是否关闭由独立复验决定。

## 返工轮 4 · PA02-R3（部分执行后的暂停进入可恢复路径）

基线：`fe8e2c4`。第四次独立验收确认零发送暂停与并发上限修复，保留 PA02-R3：已有权威调用（50 tokens）后，下一次发送被暂停门拒绝时，操作被通用异常分支记为 `unknown / workerActive=true / result:null`，实例 `used` 仍为 0，恢复不派发、`reconcile` 返回 `reconciliation_unavailable`。

### 修复

- **有证据的交接**：门拒绝（暂停/预算/未知用量）到达 `execution` 后按“是否已有 invocation”分流：没有任何 invocation 仍是 `not_sent`（安全约束不变）；已有部分调用则记为 `interrupted` —— `worker_active=0`、`reserved=0`、`waiting_slot=0`、结果保持 `null`，并写入 `operation.interrupted` 事件（原因、已知用量、调用次数）。不再进入需要 reconcile 的 `unknown/recovery`。
- **用量准确累计一次**：把该操作已结算 invocation 的权威用量一次性加到 `instances.used`（同步 `models_used`）；若任一 invocation 用量未知，则不折零、不累计，保持 `unknown_usage` 问题阻塞。后续恢复派发产生新操作，各自结算，不会重复计数。
- **恢复路径**：暂停时节点回到 `pending`，实例与 Pi 会话（含工具结果）保留；用户恢复后按正常派发继续原实例，不盲目重复工具效果；后继节点只在真正成功后运行。预算拒绝仍开 `budget` 问题，未知用量仍走既有认证答复路径。
- 工具调用通过调用门执行，暂停期间的本地工具同样被拒绝——这是既有边界；暂停点选在工具效果之后（验收方 `after-tool-pause` 场景）时效果保留在会话与磁盘上，恢复继续。

### 复验

- 新增回归 `tests/m8/rework.test.ts`：首轮工具调用写入 `partial.txt` 并消耗 50 tokens，第二次发送前暂停；暂停态断言 `interrupted / workerActive:false / reserved:0 / used:50 / 无问题 / work pending / 检查 pending`，文件已写入；恢复后 2 次请求、全部成功、`used=100`（两次调用各计一次）、文件未被重复覆盖。
- 验收方探针复跑：`partial-pause`、`after-tool-pause` 均 `interrupted` → 恢复后 `completed`、`reconcile` 接受；`pause-resume-verified --pause` 阶段断言通过（暂停 0 请求 0 成功、恢复 20 请求全部成功且并发 ≤10）；`graph-rework3-model-error` 保持失败结算。
- 项目 Node 24.20.0：全量 **47 文件 / 219 项**连续 2 次通过；双 tsc、构建、`git diff --check` 通过；八个历史探针全部 `rc=0`。证据见 `acceptance-evidence/rework4-independent.output.txt`、`rework4-graph-full.output.txt`。未调用付费供应商；是否关闭由独立复验决定。
