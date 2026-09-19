# Pi 扩展运行时声明

日期：2026-09-19

## 状态

已接受。

## 背景

能力绑定后，Pi extension 已在独立受限 Pi 进程中加载，入口和同目录依赖也可读。
但依赖宿主命令、持久状态、loopback daemon 或 Unix socket 的扩展仍可能“已加载却不可调用”。
`agent-browser-native` 是直接案例：扩展入口可加载，随后因为无法访问
`agent-browser` 命令、`~/.agent-browser`、`/private/tmp/piab-<uid>` 和浏览器网络而失败。

把这些路径和命令写死在 Graph 中会让能力绑定失去可移植性，也会把用户的全局权限
错误地授予所有扩展。每个扩展应能声明自己的最小运行时依赖。

## 决策

`pi-extension` 能力清单可增加 `runtime`：

```json
{
  "runtime": {
    "commands": ["agent-browser"],
    "env": {
      "HOME": "${HOME}",
      "PI_AGENT_BROWSER_SOCKET_DIR": "/private/tmp/piab-${uid}"
    },
    "readPaths": ["${HOME}/.agent-browser"],
    "writePaths": ["${HOME}/.agent-browser"],
    "networkAccess": "unrestricted",
    "allowLocalBinding": true,
    "unixSockets": ["/private/tmp/piab-${uid}"]
  }
}
```

- `commands` 在宿主解析为实际可执行文件；其目录进入子进程只读路径和 `PATH`。
- `env` 支持 `${HOME}`、`${workspace}`、`${stateDir}`、`${scratchDir}`、`${uid}`、
  `${pid}` 与环境变量引用。
- `readPaths`、`writePaths` 和 `unixSockets` 会加入该 Agent operation 的 OS 权限。
- `unixSockets` 同时授权其目录的读写元数据，并仅放行该路径下的 AF_UNIX
  `bind`/`connect`；扩展可以检查自己的私有 socket 根，不能借此访问其他 Unix socket。
- `networkDomains` 与 `networkAccess` 复用 MCP 的出站声明；浏览器类扩展必须显式使用
  `unrestricted`。
- `allowLocalBinding` 允许扩展及浏览器子进程使用 loopback；它不扩大外网范围。
- 绑定能力仍是运行授权，但这些运行时声明不会扩大其他 Agent、其他能力或 Graph 后台的权限。

该声明适用于 Main Agent 和所有 subagent，并进入 operation 的运行策略摘要。

## macOS 浏览器边界

本地浏览器扩展比普通 MCP 多一类宿主运行时依赖。macOS 上 Chrome for Testing 会：

- 通过系统 Crashpad 目录保存崩溃数据，而不是只使用临时 profile；
- 用 `NSTemporaryDirectory()` 创建 ProcessSingleton socket，忽略普通 `TMPDIR`；
- 启动自己的嵌套 sandbox；在 Graph 的外层 Seatbelt 内必须用 `--no-sandbox` 避免二次 sandbox 初始化失败；
- 通过 mDNSResponder、SystemConfiguration 和 `/var`、`/etc` 解析 DNS；
- 创建 Unix domain socket 与 daemon、Chrome ProcessSingleton 通信。

因此 `agent-browser-native` 的 manifest 额外声明：

- `MAC_CHROMIUM_TMPDIR`、`AGENT_BROWSER_ARGS=--no-sandbox`；
- script 模式的隔离配置会过滤普通 `AGENT_BROWSER_*` 环境，但 Graph 必须在隔离模式中保留自己声明的
  `AGENT_BROWSER_ARGS`，否则 Chrome 会在外层 Seatbelt 内再次启用 sandbox 并丢失 CDP 通道；
- policy-lock 根使用 `/private/tmp/pi-agent-browser-policy-<uid>`，与实际授予的 canonical vnode 一致；
- `${HOME}/.agent-browser/tmp` 和 `${HOME}/Library/Application Support/Google/Chrome for Testing/Crashpad`
  的读写；
- agent-browser socket、Chrome ProcessSingleton socket 和 policy-lock 目录；
- `allowLocalBinding: true`、`networkAccess: "unrestricted"` 和浏览器所需 Unix socket 根。

Graph 在 `allowLocalBinding`/`localNetwork` 的运行时 profile 中补充浏览器启动所需的
sysctl、Chrome Mach service、DNS 服务与系统路径 metadata 读取；这些补充只在该
operation 生效，不会改变其他 Agent 或后台任务。

## 后果

扩展作者需要准确声明外部命令和本地资源。漏声明时调用会 fail closed，而不是静默借用宿主全局权限。
用户可以继续移除配方绑定来停用能力。

代价是 manifest 可以申请更宽的本地运行时资源；因此 `runtime` 只对 `pi-extension` 有效，
路径、环境变量名、网络模式和命令名在扫描阶段都需要校验。
