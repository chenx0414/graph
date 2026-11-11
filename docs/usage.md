# Graph 使用文档

面向使用者：如何启动、配置、观察与排障本机 Graph。产品范围见 [首版设计](graph-mvp.md)，模块与恢复机制见 [架构](architecture.md)，逐项交付报告见 [产品化交付报告](planning/productization-reports.md)。

Graph 是任务编排控制台；它交付过的 MediaBookmarks B站 Web 应用是另一个被编排的项目，不属于 Graph 本体。

## 最短启动流程

要求：macOS、Go 1.27.1 + 项目 Node 24.20.0（`node -v` 应输出 `v24.20.0`）；`pnpm` 可选，没有时用 `node --run` 或直接调用 `node_modules/.bin`。

```sh
cd "$REPO"            # 仓库根目录
node --run app:build  # 打包壳与守护进程（同一个二进制）
node --run start      # 只启守护进程（仅查看模式）；有 pnpm 时 pnpm start
```

界面是原生 macOS 窗口（Go + MyGo），不是浏览器页面：用 `node scripts/install-desktop-app.mjs` 装好包后退出并重新打开 Graph.app 才会跑新代码。首次运行没有 `graph.config.json` 也能启动：窗口显示首次运行提示，只读浏览历史，不派发模型请求。守护进程启动输出包含配置文件、状态目录与访问地址：

```
Graph console
  mode:      view-only (history, settings and graph; no model dispatch)
  config:    none — first run; add graph.config.json to enable projects and models
  state:     /…/.local/state/graph
  address:   http://127.0.0.1:4173
```

守护进程只提供 HTTP/SSE 接口，没有要打开的页面；界面由 Graph.app 自己绘制并通过同一个地址访问这些接口。关闭窗口不会停止守护进程；重开窗口会重新连接并从事件游标续传。

执行模式（会实际请求模型）：

```sh
node --run start:execute    # 或 node --run build:backend && node backend/internal/graph/server_cli.go --execute
```

执行模式要求配置中至少一个模型且其凭据引用的环境变量已设置；否则启动失败并明确报错。

## 与主 Agent 对话（推荐入口）

打开页面后先在首页的「与主 Agent 对话」输入一句话即可开始，不要求先选择项目或创建功能任务。主 Agent 会先交流与调查，你可以：

- 只说模糊目标，或先留空项目；需要读代码时在对话页选择项目并绑定（未绑定时主 Agent 不会读取任何真实项目）。
- 在讨论阶段继续追问、比较方案、推翻旧草稿；主 Agent 提出的**策略草稿**会显示在对话页的「策略与图」。
- 点「确认草稿并开始执行」后才会创建功能任务并派发工人；确认绑定当时的草稿版本、目标分支与验收项，旧草稿立即失效。
- 执行期间继续在同一对话里问进度、解释与偏差；主 Agent 忙时输入会进入输入框上方的右侧队列，当前回复结束后按顺序每次发送一条，形成一问一答，不会丢消息。
- 输入 `@` 可引用项目文件与文件夹；输入 `/` 可浏览当前主 Agent 实际可用的工具、已绑定能力，以及模型、思考强度和上下文压缩等系统命令。工具或能力选中后会作为 `/tool` 或 `/capability:id@version` 直接插入正文，并随消息形成明确的使用指令；`/skill:<名字>` 则不同：它由后端把该技能 `SKILL.md` 去掉 front matter 后整段注入本轮 prompt（单技能 ≤40000 字符、单回合合计 ≤120000），名字取斜杠菜单里 skill 条目的名字（不是能力 id，也不是 `pstack` 这类上层 id），未绑定到本 Agent 的名字会被拒绝并在 `skill.invoked` 事件里写明原因；token 必须位于行首或空白之后，紧贴中文标点（如 `，/skill:x`）不会生效。模型与思考强度直接作用于下一轮，`/compact` 由同一 Pi session 执行真实上下文压缩。
- 完全访问是唯一模式：Agent 可使用宿主文件系统、任意命令与网络、已绑定 MCP/扩展，并可修改工作区；会话暂停、额度、未知用量和未核对的副作用仍按各自规则控制执行；访问权限不证明失败操作可以重放。
- 忙时输入 `Enter` 会入队，输入框为空且已有队列消息时再按 `Enter` 会把队列作为打断引导送入当前回复。
- 暂停只作用于对话主 Agent；功能任务的暂停/继续仍在对应任务页。重启守护进程后，对话、未处理消息与执行状态都会恢复。
- main 与每个节点拥有独立、稳定的 durable 会话。返工、重试、配置重绑和重启保留节点身份、历史与累计预算；节点之间通过具名接口和不可变产物协作。
- 节点详情显示实际运行配置、prompt、工具、用量与预算作用域。独立审查沿用自己的会话和模型独立性约束，读取明确发布的成果及审查目标。

确认后若要新增功能，主 Agent 会把它作为新的功能任务讨论与确认，原任务的验收范围不被静默修改。讨论阶段运行在完全访问模式，主 Agent 可以按用户要求直接读写工作区和调用能力。

## Agent 上下文与 Prompt

聊天窗口顶部的「Agent 上下文」预览下一轮的 system prompt、可编辑来源以及工具与能力。组装顺序固定为 `identity → tools → rules → docs → project_context → capabilities → cwd`；Main Agent 的 `rules` 只保留证据与方案命名两条规则，不再注入臃肿的 runtime workflow。预览与实际运行使用同一套装配规则，并标出「可编辑」「动态生成」和「Pi 自动追加」。尚未在下一轮发现的能力工具标为待运行确认；查看预览不会启动这些能力，也不会把上一轮可用状态当成下一轮的保证。已有会话继续使用它绑定的 Agent 定义版本。

完全访问开启时，Main Agent 的 `identity` section 会动态追加一条宿主生成的访问策略说明，明确当前文件系统、命令、网络、能力、暂停、预算、用量和恢复门均已放开；该说明不会覆盖或改写用户的 `agents/main.md`。

可编辑内容集中存放在 `~/.graph/prompts`，首次启动只播种缺失文件，不覆盖已有修改：

```text
agents/      身份，例如 main.md
tools/       工具使用指导；tools.json 保存 Main Agent 的 disabled list
rules/       通用规则与 main/worker/reviewer 角色规则
runtime/     仅特定运行阶段使用的动态 Prompt
defaults/    用户定义的“恢复默认”基线；允许空文件
```

Graph 自身的 Agent docs 不再复制到 `~/.graph/prompts/docs`。源码内的 `docs/agent/README.md` 是主入口，`docs/agent/` 保存只读主题文档，`examples/` 保存示例；system prompt 只注入这三个绝对路径、主题索引和阅读协议，正文由 Agent 在需要时读取。模型目录、订阅计划、配额、配方和系统健康等动态事实不常驻 system prompt；Agent 在需要时调用 `read_system_capabilities` 或 `inspect_graph_system`。每个 Agent operation 的 `<cwd>` 使用该实例实际 Git worktree，而不是项目根目录或其它 Agent 的目录。

所有 Agent 的 session 都开放适用的 Pi 原生 coding tools：`read`、`bash`、`edit`、`write`、`ls`、`find`、`grep`，以及 Windows 上的 `powershell`。它们在 Pi 子进程内执行，以宿主身份直接运行：没有 workspace sandbox，也没有命令白名单。旧的 `read`/`write_file`/`list_dir`/`run_command` 不再作为这些原生能力的替代出现在实际 session。

在「最终 Prompt」页可直接查看完整预览；在「可编辑来源」页修改并保存，改动从下一轮开始生效。「设为默认」会把当前内容（包括空内容）写入 `defaults/` 并同时作为当前内容生效；之后「恢复默认」回到这个用户默认基线。未设置用户默认时，恢复默认仍回到代码内置原版；存在自定义默认时，额外的「恢复内置」会清除用户默认并回到代码原版。工具页关闭某个工具后，它同时从 provider tool schema、session allowlist 和最终 Prompt 的工具清单中移除，但不会改变宿主权限、预算、审计或恢复规则。旧版 `tool-awareness.md` 会在首次升级时迁移为 `tools/main.md`，原文件仍保留作人工备份。

三个 runtime prompt 的注入时机不同：`runtime/worker.md` 会在每个非 Main Agent 的 system prompt `<rules>` 中作为 runtime rules 注入；`runtime/main-conversation.md` 与 `runtime/main-graph.md` 是早期 Main Agent 工作流文本，当前版本不再注入任何 system prompt，只保留可编辑与迁移用途。

## 桌面 APP

窗口与守护进程是同一个二进制：正常启动开窗口，带 `daemon` 参数时作为守护进程运行。壳只负责绘制与调用 HTTP/SSE 接口，没有内嵌浏览器。

密钥保存在 600 权限的本地密钥文件里（不进入配置文件）；没配置时窗口仍能打开，只读浏览历史，不派发模型请求。数据目录与配置在 `~/Library/Application Support/Graph`。

### 安装、卸载与打包

- 打包：`node --run app:build`，产物为 `dist/app/mac-arm64/Graph.app`；安装：`node scripts/install-desktop-app.mjs`（旧包存为 `Graph.app.previous`）。当前产物为本地构建、未签名；对外分发需要 Apple Developer ID 与公证。
- 守护进程：launchd 标签 `dev.graph.daemon`，跑 `~/Library/Application Support/Graph/bin/graphd`——App 二进制的一份稳定副本，内容相同就不重写。
- 数据与密钥：全部位于 `~/Library/Application Support/Graph/`（`graph.config.json`、`state/`、`secrets.json`）。卸载应用不会删除该目录；彻底清理时手动删除。
- 托盘：菜单栏图标提供“打开 Graph / 退出 Graph”；关闭窗口仅关闭窗口，守护进程继续运行。
- 运行不依赖系统 Node 或终端环境。

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

- 本机检查命令与 Agent 的 bash 一样直接在宿主上运行，没有 sandbox 边界。
- 检查需要真实无头 Chromium 时需系统可用的浏览器；自动化测试使用本地替身与合成凭据，不调用收费模型。
- 远程 MCP、检索与程序检查的读取路径、环境变量等由宿主按配置授予；未授予即拒绝。
- 平台兼容以 macOS + 项目声明的 Node 版本为准；其他平台会明确失败。

## 配置迁移

- 版本 1 新增 `revision`（由配置服务维护，缺失按 0）；旧文件无需改动即可读取。
- 旧的单 `apiKey` 编程入口仍可用（`openTaskRuntime({ models: { apiKey } })`）；产品化入口推荐模型级 `credentialId`。
- 历史任务的用量、费用 `unknown`、超额记录与平台结论保持原样，不为展示改写。
