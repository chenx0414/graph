# Graph Capabilities

Graph 的“能力”是版本化、可绑定的外部工具或指令资源。能力安装不等于扩权；Agent definition 绑定能力后，其已发现工具默认可在现有沙箱和任务边界内调用。

## 能力类型

### Skill

Skill 是一组按需读取的指令和资源，通常包含 `SKILL.md`。System prompt 只应提供 skill 的名称、描述和绝对路径；模型需要时再读取正文。

### MCP

MCP server 可以是本地 stdio 进程，也可以是远程 HTTP 服务。Graph 负责连接、工具发现、调用门、网络域、错误和清理。远程 MCP 在只读讨论阶段可能不加载。

### Graph Extension

Graph extension 由受限 worker 加载，按最小 `register(api)` 接口暴露工具。它仍经过 Graph 调用 gate。

### Pi Extension

Pi extension 可以注册工具和生命周期 hook。Graph 只在定义的 capability bundle 中加载已绑定 extension，并把允许的 tool 名称加入 Agent session。

### Prompt

Prompt capability 可以充当 identity 或 tool guidance。用户可编辑版本位于 `.graph/prompts`；definition 中绑定的 prompt 仍是版本化能力。

## Tool surface

一个 Agent 的实际 tool surface 由以下来源合并：

1. Pi 原生 coding tools：`read`、`bash`、`edit`、`write`、`ls`、`find`、`grep`，以及 Windows 上的 `powershell`；
2. role 对应的 Graph host tools；
3. definition 绑定的 capability tools；
4. Pi extension 注册且允许的 tools；
5. 当前 operation 的 pause、access policy 和 disabled-tool policy。

模型可见的 `<tools>` 文本和 provider 的可执行 tool schema 必须来自同一个实际启用集合。关闭工具时，两者都应移除。

`<tools>` 先以简洁的 Pi 风格条目列出原生 coding tools，再以过渡段引出 Graph tools。参数、版本、权限摘要等详细元数据保留在 UI 工具详情和宿主运行时中，不重复注入 system prompt。

Main Agent 在完全访问模式下额外获得 `inspect_rsi_status` 与 `apply_rsi_change`，用于直接修改 Graph Harness——修缺陷、重构、新增功能、改进命令或文档都可以。它们只注册给 `master` 角色，不进入 worker 或 reviewer 的 tool surface。见 [self-configuration.md](self-configuration.md) 的“Harness 自我改进（RSI）”。

Pi 原生工具在 Pi 子进程内执行。默认 full 模式放开宿主文件系统、命令、网络和能力运行时；standard 模式才启用 Graph send gate 与 workspace sandbox。full 模式下 Agent 进程也不再套 seatbelt（`sandbox-exec`）profile，因此窗口服务、剪贴板（pasteboard）、Electron 与嵌套 `sandbox-exec` 都可用；standard 模式仍在 OS sandbox 内。Graph 的旧 `read`、`write_file`、`list_dir`、`run_command` 与原生工具同名或职责重复时，启用原生工具会让它们退出实际 session，避免 custom tool 覆盖 Pi 原生实现。

## Capability binding

Agent definition 引用精确 `id@version`。恢复 session 时核对 capability/bundle/runtime digest；不一致 fail closed，不能自动绑定“最新版”。

## 网络和运行边界

- 标准模式下，本地 MCP 的 provisioning 网络与 runtime 网络分离，runtime 网络由 capability manifest 声明，extension 没有自动网络权限，命令、MCP 和工具仍在 OS sandbox 内运行。
- 完全访问模式下，网络、MCP、extension 和宿主文件系统限制不阻止调用；能力清单仍用于发现、版本与审计。
- Native bash/powershell 在 standard 模式下不能越过 workspace、受保护路径和宿主访问策略。
- `networkDomains`、工具自报 annotation 或 MCP 描述都不是权限本身。

### 检查命令的运行边界

`graph.command` 程序节点在 OS sandbox 内执行：不能嵌套 `sandbox-exec`，也看不到窗口服务，所以 Electron、真实浏览器自动化、宿主剪贴板在这里跑不起来（`sandbox_apply: Operation not permitted` 是嵌套被拒）。通过 RSI 传的 `checks` 在 checkout 里不受沙箱限制运行，适合需要真实浏览器或宿主能力的诊断；正式验收仍应落在 `graph.command` 节点上，因为验收证据必须来自受控检查。

### 沙箱内的权限读数不可作宿主授权证据

`desktop` 工具在跑任何需要 accessibility 树的命令之前，先问一次 `agent-desktop permissions`，读数的含义是「**跑这次探测的那个进程**有没有 TCC 授权」，不是「这台机器有没有授权」。实测同一份二进制：宿主上下文（`access.mode: full`，命令不过 seatbelt）读到 `granted`；沙箱内的会话读到 `denied`。也就是说，把沙箱里的 `denied` 当成用户没开 Accessibility，会把「读数的环境」错报成「用户的配置」，然后送一个人去改一个可能已经正确的开关。

因此这条读数的落点是**执行上下文**，不是布尔值：

- 拒绝信封的 `error.details.executionContext` 带 `{sandbox, accessMode, role, policyDigest, probe, evidence}`：`evidence` 只有 `host` 与 `sandbox` 两种；`policyDigest` 是本次 session 冻结的访问策略摘要，两次读数是否来自同一上下文可以据此区分。
- 沙箱上下文（`evidence: "sandbox"`）额外带 `details.notice`，明写这次读数不构成宿主授权缺失的证据，`message` 说「读不到」而不是「没有授权」，`suggestion` 指向到宿主上重跑该命令。
- standard 模式的 `graph.command` 节点、以及任何在 seatbelt 里执行的会话，其读数一律是沙箱读数。

取舍写在这里：**保留探测并标注上下文**，而不是「探测只在宿主上下文执行」。理由是后者会让 standard 模式的会话彻底失去这条信号（连「读不到」都不再说明），而宿主上的真实拒绝又会被它藏起来——两种情形给出同一个答案，正是这次要修的病。真正的修复动作仍然是到宿主上重跑这条命令，而不是重新授权——沙箱里的读数不支持「该重新授权」这个结论。

## 浏览器验证与恢复

控制台地址随时可从 `<stateDir>/console.json` 读（含 `url`/`pid`/`mode`）：App 启动的 daemon 用 `--port 0`，地址不写日志也不写其他地方。**停下的 daemon 不删这份记录**（删了下次启动就不知道回哪个端口），所以它可能是一个已停进程的地址——`pid` 告诉你它是谁的。`--port 0` 会**优先复用本状态目录上次的端口**，所以重载通常不换地址、旧标签页仍指向同一个控制台；但过时标签页仍可能默默回答旧端口，用 `tab list` → `tab t<N>` 或直接 `open` 新地址纠正，并在点击前先断言 `location.href`。
控制台可见的改动要自己先验：用真浏览器读 DOM、把交互跑一遍、截一张图当证据，然后只把需要人判断的部分交给使用者，并说明是哪个窗口（桌面 App 窗口与浏览器页面不同，某些输入只在桌面桥存在时才渲染）。

### 对控制台做 HTTP 自验

`/api/*` 需要**会话 cookie**（先 `GET /` 拿）与**本地 `Origin`**，否则 403 `forbidden_origin`；而 App 启动的 daemon 用 `--port 0`，地址只在 `<stateDir>/console.json` 里（上一节）。所以配方是：先读地址，再带 cookie 与 origin 请求：

```sh
base=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["url"])' "<stateDir>/console.json")
curl -s -c /tmp/graph-cookie.txt "$base/" > /dev/null
curl -s -b /tmp/graph-cookie.txt -H "origin: $base" "$base/api/health"
```

**要写任何东西就另起一个 throwaway daemon**（`--execute|--state-dir <tmp> --graph-home <tmp> --web-dir <checkout>/dist/web --port 0 --config <tmp>/graph.config.json`），绝不把自验指向生产 state：生产库里有真实任务与凭据引用。只读的现场断言（页面、DOM）用浏览器即可。

**一个真实的坑**：运行中的 daemon 服务的是它**自己那个 checkout** 的 `dist/web`（桌面 App 启动时写死的 `--web-dir`）。所以在本仓库改完前端、跑 `app:build` 之后，**现场看到的仍是旧包**——浏览器里量到的旧样式或不存在的元素不是「没生效」，而是看错了目录（实测：应用线重建后服务端给的 CSS 里仍没有新规则；在运行中 checkout 里跑 `node --run build:web` 之后立刻生效）。要先确认 `ps -o command= -p $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "<stateDir>/console.json")` 里的 `--web-dir` 是哪个 checkout。

- `agent_browser click <selector>` 对 React 组件可能报 `Clicked: …` 却**不触发** onClick。对 React 一律用 `eval` + `document.querySelector(...).click()`（或用角色/文本定位的动作），并**另起一次** DOM 读回确认；`click` 返回的「Action dispatched; application change unverified」不是证据。
- `open` 之后先断言 `location.href` 再点（点击可能落在旧标签页上）；DOM 状态要在另一次 eval 里读，因为 React 异步 flush。带 hash 的同 URL `open` 不会重载，需要 `location.reload()`。
- 长连接页面（例如控制台的 SSE 流）上 `open` 可能超时：恢复手段是扩展自己的动作——`tab list` → `tab t<N>` → 重新断言；同标签页跳转 `location.href = ...` 是兜底。
- 剪贴板：automation 浏览器里剪贴板**写入实测不行**（2026-09-27，Chrome for Testing 153）：`writeText`、`readText`、`execCommand('copy')` 全部 `NotAllowedError`，而 `navigator.permissions.query({name:'clipboard-write'})` 同时报 `granted`、`document.hasFocus()` 为 `true`——**那个权限状态不是证据**。所以：`grant_clipboard_permission` + `focus_browser_window` 可以试，但必须用读回（`pbpaste` 或页面自己的 `readText`）证明；写不进去时从 DOM 读「它本要复制的东西」；报告里分清楚哪条腿机器验过、哪条腿等人验。

## 发现与诊断

- `search_resources`：搜索能力库，只用于发现。
- `get_resource`：读取一个能力 metadata；不等于绑定。
- `read_system_capabilities`：读取模型、订阅、配方和 definition 等配置事实。
- `inspect_graph_system`：只读取当前 conversation 的运行健康，包括无效能力、失败节点、开放问题和待处理系统变更。
- `get_graph_state`：读取当前 graph revision、phase、nodes、evidence、worktrees 和内部问题。
- `list_projects` / `bind_project`：列出配置项目并把当前 conversation 绑定到已准备项目。
- Node run：查看某实例实际加载的 capability facts 和 tools。

当用户问“为什么没有某个工具”时，先检查 definition 是否绑定、capability 是否有效、实际 session 是否加载，以及 host policy 是否禁用；不要根据历史对话推断。
