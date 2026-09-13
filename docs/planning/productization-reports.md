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
