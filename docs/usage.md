# Graph 使用文档

面向使用者：如何启动、配置、观察与排障本机 Graph 控制台。产品范围见 [首版设计](graph-mvp.md)，模块与恢复机制见 [架构](architecture.md)，逐项交付报告见 [产品化交付报告](planning/productization-reports.md)。

Graph 是任务编排控制台；它交付过的 MediaBookmarks B站 Web 应用是另一个被编排的项目，不属于 Graph 本体。

## 最短启动流程

要求：macOS + 项目 Node 24.20.0（`node -v` 应输出 `v24.20.0`）；`pnpm` 可选，没有时用 `node --run` 或直接调用 `node_modules/.bin`。

```sh
cd "$REPO"            # 仓库根目录
node --run build:web  # 首次或前端改动后；有 pnpm 时 pnpm build:web
node --run start      # 仅查看模式；有 pnpm 时 pnpm start
```

首次运行没有 `graph.config.json` 也能启动：页面显示首次运行横幅，只读浏览历史，不派发模型请求。启动输出包含配置文件、状态目录与访问地址：

```
Graph console
  mode:      view-only (history, settings and graph; no model dispatch)
  config:    none — first run; add graph.config.json to enable projects and models
  state:     /…/.local/state/graph
  web:       /…/dist/web
  address:   http://127.0.0.1:4173
```

在浏览器打开该地址。浏览器只是客户端：关闭页面不会停止守护进程；重开页面会重新连接并从事件游标续传。

执行模式（会实际请求模型）：

```sh
node --run build:web
node --run start:execute    # 或 node src/server/cli.ts --execute
```

执行模式要求配置中至少一个模型且其凭据引用的环境变量已设置；否则启动失败并明确报错。前端开发模式使用 `node --run dev`（Vite，默认 5173，`/api` 代理到 `GRAPH_DEV_API` 或 `http://127.0.0.1:4173`）。


## 与主 Agent 对话（推荐入口）

打开页面后先在首页的「与主 Agent 对话」输入一句话即可开始，不要求先选择项目或创建功能任务。主 Agent 会先交流与调查，你可以：

- 只说模糊目标，或先留空项目；需要读代码时在对话页选择项目并绑定（未绑定时主 Agent 不会读取任何真实项目）。
- 在讨论阶段继续追问、比较方案、推翻旧草稿；主 Agent 提出的**策略草稿**会显示在对话页的「策略与图」。
- 点「确认草稿并开始执行」后才会创建功能任务并派发工人；确认绑定当时的草稿版本、目标分支与验收项，旧草稿立即失效。
- 执行期间继续在同一对话里问进度、解释与偏差；主 Agent 忙时输入会进入输入框上方的右侧队列，当前回复结束后按顺序每次发送一条，形成一问一答，不会丢消息。
- 主 Agent 完成回答时可留下灰色候选 prompt：`Tab` 填入输入框，`Enter` 直接发送；忙时输入 `Enter` 会入队，输入框为空且已有队列消息时再按 `Enter` 会把队列作为打断引导送入当前回复。
- 暂停只作用于对话主 Agent；功能任务的暂停/继续仍在对应任务页。重启守护进程后，对话、未处理消息与执行状态都会恢复。
- 工人默认使用 Fresh 上下文；只有主 Agent 明确要求精确 transcript/tool-call 状态时，Graph 才会从已成功源节点创建 Fork 新会话。返工和主 Agent 连续对话使用 Continue。Fork 不会共享可变 session，也不会重置预算。
- 节点详情会显示实际上下文模式、来源节点、source/child digest、handoff 与共享预算作用域；独立审查始终使用 Fresh，且不能读取实现 Agent 的 transcript。

确认后若要新增功能，主 Agent 会把它作为新的功能任务讨论与确认，原任务的验收范围不被静默修改。讨论阶段的主 Agent 只有读取类工具，不会修改项目文件或派发实现工作。

## Agent 上下文与 Prompt

聊天窗口顶部的「Agent 上下文」显示下一轮实际组装的 system prompt、可编辑来源以及工具与能力。组装顺序固定为 `identity → tools → rules → docs → project_context → capabilities → cwd`；Main Agent 的 `rules` 只保留证据与方案命名两条规则，不再注入臃肿的 runtime workflow。预览同时标出「可编辑」「动态生成」和「Pi 自动追加」，所以看到的是最终拼接结果，而不是分散片段的猜测。

可编辑内容集中存放在 `~/.graph/prompts`，首次启动只播种缺失文件，不覆盖已有修改：

```text
agents/      身份，例如 main.md
tools/       工具使用指导；tools.json 保存 Main Agent 的 disabled list
rules/       通用规则与 main/worker/reviewer 角色规则
runtime/     仅特定运行阶段使用的动态 Prompt
```

Graph 自身的 Agent docs 不再复制到 `~/.graph/prompts/docs`。源码内的 `docs/agent/README.md` 是主入口，`docs/agent/` 保存只读主题文档，`examples/` 保存示例；system prompt 只注入这三个绝对路径、主题索引和阅读协议，正文由 Agent 在需要时读取。模型目录、订阅计划、配额、配方和系统健康等动态事实不常驻 system prompt；Agent 在需要时调用 `read_system_capabilities` 或 `inspect_graph_system`。每个 Agent operation 的 `<cwd>` 使用该实例实际 Git worktree，而不是项目根目录或其它 Agent 的目录。

所有 Agent 的 session 都开放适用的 Pi 原生 coding tools：`read`、`bash`、`edit`、`write`、`ls`、`find`、`grep`，以及 Windows 上的 `powershell`。它们在受限 Pi 子进程内执行，并通过 Graph gate、workspace sandbox 和 access policy；旧的 `read`/`write_file`/`list_dir`/`run_command` 不再作为这些原生能力的替代出现在实际 session。

在「最终 Prompt」页可直接查看完整预览；在「可编辑来源」页修改并保存，改动从下一轮开始生效；「恢复默认」只覆盖选中的可编辑文件，Graph 始终保留代码内置原版。工具页关闭某个工具后，它同时从 provider tool schema、session allowlist 和最终 Prompt 的工具清单中移除，但不会改变宿主权限、预算、审计或恢复规则。旧版 `tool-awareness.md` 会在首次升级时迁移为 `tools/main.md`，原文件仍保留作人工备份。

## 桌面 APP（开发预览）

A1–A2 提供 Electron 桌面壳与首次运行向导：APP 负责启动守护进程（`--port 0` 自动选端口、显式状态目录）并在窗口中加载控制台；关闭窗口不停止守护进程，再次启动 APP 会聚焦或重开窗口，退出 APP 触发与 CLI 相同的 5 秒有界停止。密钥边界不变：配置文件只保存 `secretRef`，APP 只把解密后的值放进子进程环境变量。

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
npx --yes electron@44.3.0 .        # 开发预览；已安装 devDependencies 时 node --run app:dev
```

A3 起控制台内置：任务页运行时间线与用量面板、图页 MiniMap 与状态色、`#/inbox` 问题收件箱（导航显示待处理数）；A5 起提供统一设计系统、明暗主题（默认跟随系统，可在侧边栏切换并记忆）、动效与更清晰的导航/统计/状态表达；桌面 APP 在新增待处理问题或任务完成/失败时发系统通知，Dock 角标显示开放问题总数，点击通知跳到对应任务。

首次打开且未配置时，从横幅或导航进入 `#/setup` 向导：选择项目目录（原生对话框）、选模型模板、填密钥。桌面 APP 会把密钥写入系统钥匙串（不进入配置文件），保存后自动重启守护进程；未填密钥则保持仅查看模式。数据目录与配置默认在系统用户数据目录下（macOS 为 `~/Library/Application Support/Graph`），与 CLI 版的状态目录相互独立。

### 安装、卸载与打包

- 打包：`export PATH="$PWD/node_modules/.bin:$PATH"; node --run app:build`。产物为 `dist/app/mac-arm64/Graph.app` 与 `dist/app/Graph-<版本>-arm64.dmg`；把 `.app` 拖入“应用程序”即可安装，删除应用即卸载。当前产物为本地构建、未签名；对外分发需要 Apple Developer ID 与公证，本机首次打开无需处理 Gatekeeper 提示。
- 数据与密钥：全部位于 `~/Library/Application Support/Graph/`（`graph.config.json`、`state/`、`secrets.json` 密文）。卸载应用不会删除该目录；彻底清理时手动删除。
- 托盘：菜单栏图标提供“打开控制台 / 待处理问题 N / 退出 Graph”；关闭窗口仅关闭窗口，守护进程继续运行，从托盘或 Dock 可重新打开。
- 打包版本用系统浏览器组件（Electron 44.3.0，内置 Node 24.20.0），运行不依赖系统 Node 或终端环境。

## 配置

配置文件为版本 1 JSON，默认 `./graph.config.json`，可用 `--config` / `GRAPH_CONFIG` 覆盖。相对项目根按配置文件所在目录解析。示例（无任何真实密钥）：

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
  "limits": { "credentials": { "local": 2 }, "sharedGroups": { "shared": 4 } }
}
```

| 字段 | 说明 |
| --- | --- |
| `projects[].root` | 被编排项目路径，相对路径按配置文件目录解析 |
| `models.entries[]` | 模型 ID、provider 标签、等级、OpenAI 兼容传输、端点与窗口；同一 provider 标签共享端点与凭据 |
| `models.entries[].credentialId` | 指向 `credentials` 的条目 |
| `models.preferences` | 各等级的首选模型 ID 列表 |
| `credentials.<id>.secretRef` | 保存密钥的环境变量名；密钥本身从不进入文件、接口、日志或页面 |
| `credentials.<id>.sharedLimitGroupId` | 可选共享并发组 |
| `limits.credentials` / `limits.sharedGroups` | 并发上限；上限在启动时绑定，修改后重启生效 |
| `models.entries[].cost` | 可选价格（每百万 token）；未配置时用量费用显示未知，不按 0 计 |

### 模型请求头与 OpenCode GO 示例

`models.entries[].headers` 可为每个模型附加请求头，用于需要路由提示的网关（如 OpenCode GO 要求每个会话发送 `x-opencode-session`）。示例：

```json
{
  "id": "deepseek-v4-flash",
  "provider": "opencode-go",
  "grade": "highest",
  "api": "openai-completions",
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "contextWindow": 131072,
  "maxTokens": 8192,
  "credentialId": "opencode-go",
  "headers": { "x-opencode-session": "graph-console" }
}
```

- 请求头合并到 provider 默认头之上，随每次模型调用与“测试连接”一起发送；设置页会显示每个模型已配置的请求头。
- 密钥仍只保存环境变量名：CLI 下设置 `OPENCODE_GO_API_KEY`；桌面 APP 在设置页对应凭据行填入密钥并点“保存到钥匙串”，重启守护进程后以执行模式生效。
- 本仓库的 `graph.config.json` 是本地用户配置（已加入 `.gitignore`），示例只引用环境变量名，不含密钥。

设置页（`#/settings`）可编辑同一文档：显示“已保存 revision”与“当前运行版本”、凭据“已配置/缺失”与“待生效”，保存走版本检查（冲突时拒绝覆盖）与原子写入。保存不会热改运行中的绑定；删除未完成任务正在使用的模型会被拒绝。新任务绑定当前**运行版本**，保存后未重启的任务不会记录尚未生效的版本；连通性测试同样使用运行版本。从配置移除的项目会保留历史任务，但不能再接收新任务。解析到同一实际密钥的多个凭据别名必须属于同一共享组并采用别名中最严格的并发上限；冲突配置在保存时被拒绝（字段错误），手改文件在查看模式下仍可打开控制台但不会派发模型。

## 数据目录、端口与停止

- 数据目录默认 `$XDG_STATE_HOME/graph` 或 `~/.local/state/graph`，可用 `--state-dir` / `GRAPH_STATE_DIR` 指定；与 cwd 解耦。同一数据目录只允许一个守护进程（owner 锁），第二次启动报 `owner_busy`。
- 端口默认 4173，可用 `--port` / `GRAPH_PORT`；只绑定 `127.0.0.1`，端口占用报 `port_in_use`。
- `Ctrl-C` / SIGTERM 触发有界停止（5 秒）。在途调用不会因强制终止被记作成功；重启后沿用核查与未知用量规则。终端前台或后台运行均可；当前不提供 launchd、安装包或开机自启。

## 排障

| 现象 | 原因与处理 |
| --- | --- |
| `web_build_missing` | 未构建前端：`node --run build:web` |
| `invalid_config` | 配置文件缺失或字段错误；消息带字段路径（如 `models.entries[0].grade`） |
| `models_missing` | 执行模式没有配置模型 |
| `credentials_missing` | 执行模式有模型但其 `secretRef` 环境变量未设置 |
| `owner_busy` | 同一数据目录已有守护进程 |
| `port_in_use` | 端口被占用；换 `--port` |
| `config_conflict` | 设置页保存时 revision 已变化；重新加载后重试 |
| `config_in_use` | 删除的模型被未完成任务使用；先处理任务或保留该模型 |
| 模型不可用 | 任务记录显示 `No credential bound for model …`；检查凭据引用与环境变量 |
| 等待 API 名额 | 同凭据并发已达上限，节点显示等待而非已发送；释放后自动继续 |
| 任务一直显示“讨论中” | 守护进程处于仅查看模式（没有可用凭据）时任务只入队不派发；补齐凭据并重启为执行模式后，运行时会自动为这些任务补建 master 并继续 |
| 网关返回 `MissingSessionID`（如 OpenCode GO） | 该网关要求请求头；确认模型条目带 `headers`（如 `x-opencode-session`）并使用包含该支持的版本保存配置 |

## 权限与兼容边界

- 本机检查命令在 macOS `sandbox-exec` 边界内运行：只允许显式 loopback 主机上的 `listen(port, host)`，由宿主按请求绑定并通过 IPC 交付句柄；沙箱 profile 显式 `(deny network-bind)`。仅使用可移除 Node 预载不能作为安全边界。
- 检查需要真实无头 Chromium 时需系统可用的浏览器；自动化测试使用本地替身与合成凭据，不调用收费模型。
- 远程 MCP、检索与程序检查的读取路径、环境变量等由宿主按配置授予；未授予即拒绝。
- 平台兼容以 macOS + 项目声明的 Node 版本为准；其他平台会明确失败。

## 配置迁移

- 版本 1 新增 `revision`（由配置服务维护，缺失按 0）；旧文件无需改动即可读取。
- 旧的单 `apiKey` 编程入口仍可用（`openTaskRuntime({ models: { apiKey } })`）；产品化入口推荐模型级 `credentialId`。
- 历史任务的用量、费用 `unknown`、超额记录与平台结论保持原样，不为展示改写。
