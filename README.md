# Graph

为已有项目的功能开发编排 Agent：先与主管讨论并确认需求，再自主拆解、并行执行、交接上下文、审查返工和合并。

当前状态：M0–M7 已落地；监听与本地网络返工轮（R6、S4/R8、R9–R13）已由独立验收关闭（见 [R13 最终验收](r13-final-acceptance-2026-09-13.md)）。产品化阶段 T01–T06 已实施并本地复验（[产品化交付报告](productization-reports.md)）；独立验收提出的 PA01–PA05 已修复（同一密钥别名归一限流、等待不占执行名额且恢复时重取、暂停拒绝不误报成功、部分执行后暂停可恢复且未知用量可核对、返工轮次不复用历史成功记录、任务记录生效版本、图页记录与证据实时刷新、冲突共享组保存前拒绝），等待独立复验；本仓库不自行宣布整体完成。历史上 A13 使用克隆、受控本地模型与合成数据，结论保持原记录。Graph 为当前工作名称。

## 从这里开始

- [工程规范](CODING_STANDARDS.md)：探索、实施、审查与交付的读取规则。
- [Matt harness 维护](docs/guides/harness.md)：项目技能、工作流与本地适配的维护入口。

- [Agent 文档入口](docs/agent/README.md)：源码内只读文档，覆盖 Graph 角色、执行模型、能力、恢复、Git 与自配置；运行时 Prompt 只注入入口、索引和阅读协议。
- [使用文档](docs/usage.md)：启动、配置、数据目录、停止与排障。
- [产品化交付报告](productization-reports.md)：T01–T06 的逐项验收与证据。
- [主 Agent 入口方案](master-agent-entry-plan-2026-09-14.md)与[第四轮返工报告](master-agent-entry-rework4-report-2026-09-14.md)：对话式讨论、草稿确认与执行。
- [合并报告](merge-report-2026-09-14.md)：`feat/master-agent-entry` 与 `feat/app-console` 合并到 `feat/unified-console` 的冲突解决与验证。
- [首版产品设计](docs/graph-mvp.md)：范围、执行规则与首个真实任务。
- [实现架构](docs/architecture.md)：模块 interface、持久化、Pi 接入与恢复方式。
- [实施计划](docs/implementation-plan.md)：M0–M7、18 个工作包和验收矩阵。首版两组验收均已完成。
- [M0 验证报告](m0-results.md)：准确依赖、可运行证据、适配方式与生产接入边界。
- [M1 验证报告](m1-results.md)：任务入口、所有权、调用恢复、名额额度和跨进程示例。
- [M2 验证报告](m2-results.md)：全部图模式、容器、回环、图修订、三类验证器与八种模板。
- [M3 验证报告](m3-results.md)：生产 Pi adapter、模型目录、Agent 库、受限能力安装与主管规划。
- [M4 验证报告](m4-results.md)：实例工作副本、任务集成分支、验收证据与自动合入。
- [M5 验证报告](m5-results.md)：本机 HTTP/SSE、React 任务图、问题列表与人才库。
- [M6 验证报告](m6-results.md)：故障注入与 A01–A12 机制验收矩阵。
- [M7 验证报告](m7-results.md)：Graph 交付 MediaBookmarks B站本机 Web 并合入克隆目标分支。
- [接手说明](handoff.md)：M0–M7 完成后的工作区状态、边界与后续入口。
- [领域术语](CONTEXT.md)：Agent 定义、实例、节点、任务与额度的准确含义。
- [决策记录](docs/adr/)：已作选择的理由与权衡。
- [运行示例](examples/README.md)：持久任务、验收 fixture 与 runtime contract 示例。

当前采用 Go 后端、pi-durable 1.1.0 共享 Agent 宿主、React 本机 Web 和 Electron 桌面壳，支持已确认的接口投递图模型。完成标准包括执行机制测试，以及由 Graph 交付 MediaBookmarks 的 B站 Web 应用任务。

任务平台使用 GitHub Issues；目前仅有本地 Git，尚未指定 GitHub 仓库，工作包保存在实施计划中。

## 启动 Graph

界面只有原生窗口（Go + MyGo）：一个可执行文件，平时开窗口，带 `daemon` 参数时作为守护进程运行。没有网页控制台，也不需要 Electron 或 Chromium。

```sh
node --run app:build                    # 打包 dist/app/mac-arm64/Graph.app
node scripts/install-desktop-app.mjs    # 装到 /Applications，退出重开才生效
```

- 守护进程由 launchd（`dev.graph.daemon`）托管，跑的是 App 自己那份二进制在 `~/Library/Application Support/Graph/bin/graphd` 的稳定副本：路径与内容都不随重装漂移，辅助功能授权才留得住。
- 状态目录 `~/Library/Application Support/Graph/state`，配置默认 `~/Library/Application Support/Graph/graph.config.json`；可用 `--config`、`--state-dir`、`--port` 覆盖，或设置 `GRAPH_CONFIG`、`GRAPH_STATE_DIR`、`GRAPH_PORT`。源码 checkout 位置来自 `~/.graph/app-root` 或 `GRAPH_RSI_ROOT`。
- 只想在终端里跑无窗口守护进程：`node --run build:backend && node --run start`（构建并运行 `dist/graphd`，与 App 里的守护进程是同一份 `backend/` 代码）。
- 只绑定 `127.0.0.1`。同一状态目录只允许一个守护进程；`Ctrl-C`/SIGTERM 有界停止（5 秒），在途调用不会被记作成功。

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

## 桌面 APP

窗口由 `app/` 绘制，通过守护进程的 HTTP/SSE 接口读写数据；关闭窗口不停止守护进程，退出 APP 有界停止它。托盘菜单提供「打开 Graph」与「退出 Graph」，新增待处理问题或任务完成/失败时发系统通知。首次运行没有 `graph.config.json` 也能打开：窗口显示首次运行提示，只读浏览历史，不派发模型请求。

- 打包 `node --run app:build`，安装 `node scripts/install-desktop-app.mjs`。产物未签名；对外分发需要 Apple Developer ID 与公证。
- 数据与密钥全部位于 `~/Library/Application Support/Graph/`（`graph.config.json`、`state/`、600 权限的本地密钥文件）。卸载应用不会删除该目录，彻底清理时手动删除。
- 方案与阶段报告：[APP 版本方案](app-version-plan-2026-09-13.md)、[APP 交付报告](app-reports.md)。

## 计算机使用能力（agent-desktop）

Agent 通过一个 `desktop` 工具操作本机 GUI，背后是 [agent-desktop](https://github.com/vercel-labs/agent-desktop) CLI（1.1.0，协议 2.6，Apache-2.0）：`command` + `args`，返回 CLI 自己的 JSON 信封。默认 headless；只有显式 `headed: true` 才会抢焦点、动物理光标。成功输出默认只回一张回执（`bytes`/`sha256`），要读内容必须显式 `include: "output"`；宿主不自动重试，是否重复只由读到 `disposition.retry` 的调用方决定。

装在哪里、怎么授权、真机验证过什么、重装后为什么要重新确认：见 [能力说明](.agents/skills/agent-desktop/README.md)。**授权不是永久状态**——TCC 按路径 + cdhash 认定 adhoc 二进制，重装、升级或换安装路径都会改变 cdhash 使授权失效；动过安装之后要重新跑一次 `agent-desktop permissions` 看答案，而不是假设它还有效。

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
