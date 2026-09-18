# MCP 按能力清单声明联网范围

状态：2026-09-17 已实施。

## 背景

原有生产链路只给远程 HTTP MCP 提供域名白名单，而且 APP 启动链路没有配置该白名单；本地 stdio MCP 的受限进程始终使用空域名表。结果是两类 MCP 都无法联网。与此同时，网络域名放行不能等同于外部写操作授权。

## 决策

### 1. 普通 MCP 在 `capability.json` 声明域名

本地 MCP 可用 `networkDomains` 声明所需主机或 `*.` 子域：

```json
{
  "networkDomains": ["api.github.com", "*.example.com", "${JIRA_URL}"]
}
```

- 静态值只允许主机模式；URL、路径、端口和裸 `*` 在能力扫描阶段拒绝。
- `${ENV}` 或 `$ENV` 在运行时解析；解析结果可以是主机模式，也可以是 HTTP(S) 基址，后者只取 hostname。
- 未声明域名时，本地 MCP 仍保持无网络。
- 远程 MCP 的 `url` host 属于能力自身端点，自动加入该能力的 allowlist；其他相关域名仍可用 `networkDomains` 声明。

### 2. 任意站点访问必须显式选择

浏览器类 MCP 如果需要访问用户临时指定的任意站点，必须在清单声明：

```json
{
  "networkAccess": "unrestricted"
}
```

`networkAccess` 与 `networkDomains` 互斥。该模式只解除 outbound 目标限制，进程仍不能 bind 监听端口或使用 Unix socket；它也不能绕过暂停、预算、沙箱和计量门。

### 3. 域名放行与工具授权

初始版本要求只要 MCP 具有网络能力，所有工具调用都要求任务预授予：

```text
mcp:<capabilityId>:<toolName>
```

2026-09-19 起，该逐工具确认由 [ADR 0021](0021-capability-binding-default-authorization.md)
取代。导入或连接能力本身仍不等于授权；把能力绑定到版本化 Agent 定义后，该 Agent 可以直接
调用已发现工具。域名、沙箱、预算、暂停与计量仍独立生效。见
[ADR 0021](0021-capability-binding-default-authorization.md)。

### 4. 网络声明进入能力 digest

最终解析出的 `networkDomains` 或 `networkAccess` 进入能力加载事实和 capability digest。清单内容变化不能在不改变实例绑定的情况下静默复用。

### 5. stdio 进程按协议保持 stdin

真实 MCP stdio 服务器是长生命周期 JSON-RPC 进程。宿主持有 stdin，收到目标响应后再结束该次 exchange；不能以立即发送 EOF 的方式依赖服务器先 flush。

## 实施边界

- SRT 的每次运行配置只影响 Seatbelt profile；其 live proxy 读取 manager 配置。运行时更新代理 allowlist，并串行化不同网络声明的受限进程，避免并发进程借用彼此域名。
- 网络进程仍使用与命令相同的文件边界、Git 元数据保护、暂停门和结算路径。
- 本地回环、unix socket 与监听端口不放宽。需要这些能力的程序检查继续走既有 `localNetwork` 专用例外。

## 后果

- 已导入的 MCP 可以按自身服务域名联网，不必在 APP 全局维护一份模糊白名单。
- 能力作者必须准确声明实际依赖；漏声明时请求 fail closed 并返回具体失败，而不是自动回退到无限制网络。
- Playwright 一类浏览器 MCP 的任意站点访问是明确的单能力选择，不会把其他 MCP 一起变成无限制网络。
