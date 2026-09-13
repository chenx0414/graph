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
