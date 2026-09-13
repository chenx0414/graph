# Graph

为已有项目的功能开发编排 Agent：先与主管讨论并确认需求，再自主拆解、并行执行、交接上下文、审查返工和合并。

当前状态：M0–M7 已落地。机制矩阵与 MediaBookmarks 克隆交付见各里程碑报告；独立验收反例的修复见 [验收复验](docs/planning/acceptance-rework.md)。A13 使用克隆、受控本地模型与 `GRAPH_FIXTURE` 合成数据，不是真实 B站登录或收费模型。Graph 为当前工作名称。

## 从这里开始

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

首版采用 Pi Agent、TypeScript、本机 Web 和独立后台，支持全部已确认图模式与验证器。完成标准包括执行机制测试，以及由 Graph 交付 MediaBookmarks 的 B站 Web 应用任务。

任务平台使用 GitHub Issues；目前仅有本地 Git，尚未指定 GitHub 仓库，工作包保存在实施计划中。

## 启动 Graph 控制台

```sh
pnpm build:web      # 首次启动或前端改动后；无 pnpm 时用 node --run build:web
pnpm start          # 仅查看：浏览项目、任务与图，不派发模型请求
pnpm start:execute  # 执行模式：需要 graph.config.json 中可解析的凭据
```

- 默认配置为当前目录的 `graph.config.json`；可用 `--config`、`--state-dir`、`--port`、`--web-dir` 覆盖，或设置 `GRAPH_CONFIG`、`GRAPH_STATE_DIR`、`GRAPH_WEB_DIR`、`GRAPH_PORT`。无 pnpm 时直接运行 `node src/server/cli.ts`。
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

## 运行验证

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo:m1
```

pnpm 使用项目声明的 Node 24.20.0，不修改系统 Node。完整 M0 测试要求 macOS 的系统 sandbox-exec 和可用的 npm CLI；其他平台会明确失败。测试使用临时目录、本地响应服务与虚构凭据，不调用收费模型。
