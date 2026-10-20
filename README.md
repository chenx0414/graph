# Graph

为已有项目的功能开发编排 Agent：先与主管讨论并确认需求，再自主拆解、并行执行、交接上下文、审查返工和合并。

当前状态：M0–M7 已落地；监听与本地网络返工轮（R6、S4/R8、R9–R13）已由独立验收关闭（见 [R13 最终验收](docs/planning/r13-final-acceptance-2026-09-13.md)）。产品化阶段 T01–T06 已实施并本地复验（[产品化交付报告](docs/planning/productization-reports.md)）；独立验收提出的 PA01–PA05 已修复（同一密钥别名归一限流、等待不占执行名额且恢复时重取、暂停拒绝不误报成功、部分执行后暂停可恢复且未知用量可核对、返工轮次不复用历史成功记录、任务记录生效版本、图页记录与证据实时刷新、冲突共享组保存前拒绝），等待独立复验；本仓库不自行宣布整体完成。历史上 A13 使用克隆、受控本地模型与合成数据，结论保持原记录。Graph 为当前工作名称。

## 从这里开始

- [工程规范](CODING_STANDARDS.md)：探索、实施、审查与交付的读取规则。
- [Matt harness 维护](docs/agents/harness.md)：项目技能、工作流与本地适配的维护入口。

- [Agent 文档入口](docs/agent/README.md)：源码内只读文档，覆盖 Graph 角色、执行模型、能力、恢复、Git 与自配置；运行时 Prompt 只注入入口、索引和阅读协议。
- [使用文档](docs/usage.md)：启动、配置、数据目录、停止与排障。
- [产品化交付报告](docs/planning/productization-reports.md)：T01–T06 的逐项验收与证据。
- [主 Agent 入口方案](docs/planning/master-agent-entry-plan-2026-09-14.md)与[第四轮返工报告](docs/planning/master-agent-entry-rework4-report-2026-09-14.md)：对话式讨论、草稿确认与执行。
- [合并报告](docs/planning/merge-report-2026-09-14.md)：`feat/master-agent-entry` 与 `feat/app-console` 合并到 `feat/unified-console` 的冲突解决与验证。
- [首版产品设计](docs/graph-mvp.md)：范围、执行规则与首个真实任务。
- [实现架构](docs/architecture.md)：模块 interface、持久化、Pi 接入与恢复方式。
- [实施计划](docs/implementation-plan.md)：M0–M7、18 个工作包和验收矩阵。首版两组验收均已完成。
- [M0 验证报告](docs/planning/m0-results.md)：准确依赖、可运行证据、适配方式与生产接入边界。
- [M1 验证报告](docs/planning/m1-results.md)：任务入口、所有权、调用恢复、名额额度和跨进程示例。
- [M2 验证报告](docs/planning/m2-results.md)：全部图模式、容器、回环、图修订、三类验证器与八种模板。
- [M3 验证报告](docs/planning/m3-results.md)：生产 Pi adapter、模型目录、Agent 库、受限能力安装与主管规划。
- [M4 验证报告](docs/planning/m4-results.md)：实例工作副本、任务集成分支、验收证据与自动合入。
- [M5 验证报告](docs/planning/m5-results.md)：本机 HTTP/SSE、React 任务图、问题列表与人才库。
- [M6 验证报告](docs/planning/m6-results.md)：故障注入与 A01–A12 机制验收矩阵。
- [M7 验证报告](docs/planning/m7-results.md)：Graph 交付 MediaBookmarks B站本机 Web 并合入克隆目标分支。
- [接手说明](docs/planning/handoff.md)：M0–M7 完成后的工作区状态、边界与后续入口。
- [领域术语](CONTEXT.md)：Agent 定义、实例、节点、任务与额度的准确含义。
- [决策记录](docs/adr/)：已作选择的理由与权衡。
- [运行示例](examples/README.md)：持久任务、验收 fixture 与 runtime contract 示例。

当前采用 Go 后端、pi-durable 1.1.0 共享 Agent 宿主、React 本机 Web 和 Electron 桌面壳，支持已确认的接口投递图模型。完成标准包括执行机制测试，以及由 Graph 交付 MediaBookmarks 的 B站 Web 应用任务。

任务平台使用 GitHub Issues；目前仅有本地 Git，尚未指定 GitHub 仓库，工作包保存在实施计划中。

## 启动 Graph 控制台

```sh
pnpm build:backend  # Go 1.27.1；生成 dist/graphd
pnpm build:web      # 首次启动或前端改动后；无 pnpm 时用 node --run build:web
pnpm start          # 仅查看：浏览项目、任务与图，不派发模型请求
pnpm start:execute  # 执行模式：需要 graph.config.json 中可解析的凭据
```

- 默认配置为当前目录的 `graph.config.json`；可用 `--config`、`--state-dir`、`--port`、`--web-dir` 覆盖，或设置 `GRAPH_CONFIG`、`GRAPH_STATE_DIR`、`GRAPH_WEB_DIR`、`GRAPH_PORT`。`node --run start` 会自动构建 Go 后端；直接运行 `node backend/internal/graph/server_cli.go` 前先运行 `node --run build:backend`。
- 数据目录默认 `$XDG_STATE_HOME/graph` 或 `~/.local/state/graph`，与启动目录解耦；配置中的相对项目根路径按配置文件所在目录解析。同一数据目录只允许一个守护进程，第二次启动会被 owner 锁拒绝。
- 只绑定 `127.0.0.1`。浏览器只是客户端：关闭浏览器不停止守护进程；`Ctrl-C`/SIGTERM 有界停止（5 秒），在途调用不会被记作成功。
- 缺少 Web 构建时启动失败并给出 `pnpm build:web` 指令；端口占用、显式配置不存在、执行模式缺少模型或凭据分别以明确错误退出。
- `pnpm dev` 启动 Vite 前端（默认 5173），将 `/api` 代理到守护进程；`GRAPH_DEV_API` 可改代理目标。

最小 `graph.config.json`：

```json
{
  "version": 1,
  "projects": [{ "id": "demo", "root": "./project" }]
}
```

模型与凭据引用（凭据只保存环境变量名，不保存密钥）：

```json
{
  "version": 1,
  "projects": [{ "id": "demo", "root": "./project" }],
  "models": {
    "entries": [{
      "id": "local-model", "provider": "local", "grade": "medium",
      "api": "openai-completions", "baseUrl": "http://127.0.0.1:8080/v1",
      "contextWindow": 32768, "maxTokens": 4096, "credentialId": "local"
    }]
  },
  "credentials": { "local": { "secretRef": "GRAPH_LOCAL_KEY" } },
  "limits": { "credentials": { "local": 2 } }
}
```

## 桌面 APP（开发预览）

桌面 APP 以子进程方式托管 Go 守护进程、加载同一个控制台，窗口关闭不停止守护进程，退出时有界停止。方案见 [APP 版本方案](docs/planning/app-version-plan-2026-09-13.md)，阶段报告见 [APP 交付报告](docs/planning/app-reports.md)。

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
npx --yes electron@44.3.0 .        # 或安装 devDependencies 后：node --run app:dev
node --run app:build               # 打包：dist/app/mac-arm64/Graph.app 与 Graph-<版本>-arm64.dmg
```

桌面功能包含向导、可视化、打包和界面重塑：控制台采用设计系统与明暗主题，可产出本机 `.app`/`.dmg`，托盘常驻；对外分发所需的签名与公证待 Apple Developer ID（A6 提供操作手册）。

## 运行验证

```sh
pnpm install --frozen-lockfile
# 需要 Go 1.27.1 和 Node 24.20.0
pnpm check
pnpm demo:m1
```

`demo:m1` 使用原生 Graph v2：第一个宿主通过真实 Pi 和本地脚本响应写入标题搜索、提交公开结果；第二个宿主重开同一状态，执行独立检查并显式完成。`delivery.json` 保存验收和结果；复跑已完成的示例不再请求模型。响应不含真实 token 证据，用量明确记为估算；不调用收费模型、不执行 Git 合并。旧演示目录需换成新目录。

`check` 包含 Go 构建与 vet、TypeScript 检查、现有测试和证据门禁。Go 进程的持久化、重启、用量与桌面验收在 `tests/e2e/go-*.test.ts`、`provider-usage-completeness.test.ts` 和 `desktop-shell.test.ts`。

pnpm 使用项目声明的 Node 24.20.0，不修改系统 Node。完整 M0 测试要求 macOS 的系统 sandbox-exec 和可用的 npm CLI；其他平台会明确失败。测试使用临时目录、本地响应服务与虚构凭据，不调用收费模型。
