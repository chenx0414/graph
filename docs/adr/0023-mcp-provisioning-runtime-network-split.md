# ADR 0023：MCP 预置网络与运行时网络分离

日期：2026-09-19

## 状态

已接受。

## 背景

ADR 0013 让本地 MCP 只访问 `capability.json` 的 `networkDomains`。这能阻止 MCP
进程访问未声明服务，但也把包管理器自身的安装流量混入同一份清单。`uvx` 首次启动可能需要
从 GitHub、PyPI 和文件托管域下载 Python 与 wheel；`npx` 需要 npm registry。要求每个
能力作者把这些实现细节写进运行时域名，不仅脆弱，还让 MCP 获得安装阶段才需要的长期联网权限。

## 决策

- `networkDomains` 只表示 MCP 工具运行时需要访问的服务。
- 本地 MCP 可以声明可选的 `provisioning`：

```json
{
  "command": "uvx",
  "args": ["--from", "s2-mcp-server==1.7.4", "s2-mcp-server"],
  "provisioning": {
    "manager": "uv",
    "domains": ["downloads.example.test"]
  },
  "networkDomains": ["api.semanticscholar.org"]
}
```

- `manager` 由命令推导：`uvx` 使用 `uv`，`npx` 使用 `npm`。显式声明时必须与命令一致。
- Graph 为 uv 和 npm 提供内置预置域名，`provisioning.domains` 只补充非标准源。
- 每项 MCP 的依赖缓存存放在能力快照自己的 `.graph-provisioning/<digest>` 目录。预置阶段
  只在缓存不存在时运行一次，允许访问预置域名与运行时域名，并执行真实的 MCP 握手和工具发现。
- 运行时阶段使用同一命令，但强制 `uv` 或 npm 进入离线模式，只获得
  `networkDomains`。预置域名不会传给运行时进程。
- provisioning 缓存是 Graph 自管目录，可以包含包管理器自己的 VCS 元数据；工作副本中的
  `.git` 写入保护不变。

## 后果

MCP 作者不再需要把 uv/npm 的下载站点写进运行时权限，普通 API MCP 可以只声明自己的服务域名。
首次验证会承担安装成本，后续运行从持久缓存离线启动。包管理器无法在运行时悄悄更新依赖。

代价是能力快照目录包含 Graph 生成的缓存，验证需要区分预置和运行两个阶段；缓存损坏时删除
对应 `.graph-provisioning` 目录即可重新预置。非 uv/npm 的包管理器仍需使用绝对命令，不能借
`provisioning` 放宽网络。
