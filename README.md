# Graph

为已有项目的功能开发编排 Agent：先与主管讨论并确认需求，再自主拆解、并行执行、交接上下文、审查返工和合并。

界面只有原生窗口：一个 Go + MyGo 的可执行文件，带 `daemon` 参数时作为守护进程运行。后端、构建、门禁与
工具链都是 Go；内核是 PiG（`v0.7.0`）。没有 Electron、Chromium、TypeScript 或前端打包链。
唯一保留的 JavaScript 是 PiG 在 Node 里跑扩展与模块的执行面（`src/runtime/`）和第三方技能脚本。

## 从这里开始

- [工程规范](CODING_STANDARDS.md)：探索、实施、审查与交付的读取规则。
- [Agent 文档入口](docs/agent/README.md)：Agent 角色、执行模型、能力、恢复、Git 与自配置。
- [原生图指南](docs/agent/graph-v2.md)：图形状、节点指令、控制与观察。
- [重构规格](docs/specs/graph-rebuild-v2.md)：v2 的产品契约。
- [领域术语](CONTEXT.md)：Agent 定义、实例、节点、任务与额度的准确含义。
- [决策记录](docs/adr/)：已作选择的理由与权衡（含工具链 Go 化与内核 0.7 的边界）。
- [检查操作](docs/guides/checks.md)、[harness 维护](docs/guides/harness.md)。
- [运行示例](examples/graphs/)：可直接照抄的图定义形状。

## 启动

```sh
go -C backend run ./cmd/graphbuild app       # 打包 dist/app/mac-arm64/Graph.app
go -C backend run ./cmd/graphbuild install   # 装到 /Applications，退出重开才生效
```

- 守护进程由 launchd（`dev.graph.daemon`）托管，跑的是 App 包内那份二进制
  （`/Applications/Graph.app/Contents/MacOS/Graph daemon …`）：macOS 按「二进制所在的 bundle」记账，
  只有从包里运行，辅助功能授权才会认到 Graph 上。
- 状态目录 `~/Library/Application Support/Graph/state`，配置默认
  `~/Library/Application Support/Graph/graph.config.json`；可用 `--config`、`--state-dir`、`--port`
  覆盖，或设置 `GRAPH_CONFIG`、`GRAPH_STATE_DIR`、`GRAPH_PORT`。源码 checkout 来自 `~/.graph/app-root`
  或 `GRAPH_RSI_ROOT`。
- 只想在终端里跑无窗口守护进程：`go -C backend run ./cmd/graphbuild backend && dist/graphd --application-root "$PWD" --execute`。
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

## 窗口

窗口由 `app/` 绘制，通过守护进程的 HTTP/SSE 接口读写数据；关闭窗口不停止守护进程，退出 App 有界停止它。
托盘菜单提供「打开 Graph」与「退出 Graph」，新增待处理问题或任务完成/失败时发系统通知。首次运行没有
`graph.config.json` 也能打开：窗口显示首次运行提示，只读浏览历史，不派发模型请求。

数据与密钥全部位于 `~/Library/Application Support/Graph/`（`graph.config.json`、`state/`、600 权限的本地
密钥文件）。卸载应用不会删除该目录，彻底清理时手动删除。

## 运行验证

```sh
python3 scripts/check-queue.py                          # 激活门禁：构建、vet、两套 go test、静态检查、行为门禁
go -C backend run ./cmd/graphcheck all                  # 全量确认（重载后会自动跑一次）
go -C backend run ./cmd/graphcheck harness              # 只跑 harness 行为门禁
go -C backend run ./cmd/graphcheck eval --config graph.config.json --case parser   # 真模型评测
```

门禁的每一步都用 Go；细目见 [检查操作指南](docs/guides/checks.md)。

## 计算机使用能力（agent-desktop）

Agent 通过一个 `desktop` 工具操作本机 GUI，背后是 [agent-desktop](https://github.com/vercel-labs/agent-desktop)
CLI（1.1.0，协议 2.6，Apache-2.0）：`command` + `args`，返回 CLI 自己的 JSON 信封。默认 headless；只有显式
`headed: true` 才会抢焦点、动物理光标。成功输出默认只回一张回执（`bytes`/`sha256`），要读内容必须显式
`include: "output"`；宿主不自动重试。

装在哪里、怎么授权、重装后为什么要重新确认：见 [能力说明](.agents/skills/agent-desktop/README.md)。
**授权不是永久状态**——TCC 按路径 + cdhash 认定 adhoc 二进制，重装、升级或换安装路径都会改变 cdhash 使
授权失效；动过安装之后要重新跑一次 `agent-desktop permissions` 看答案，而不是假设它还有效。
