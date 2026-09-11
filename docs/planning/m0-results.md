# M0 兼容性与执行限制验证

日期：2026-09-11（2026-09-10 开始实施）。范围为实施计划 G01–G03；这是可运行的接入验证，不是完整 Graph 应用。

## 结论与复现

真实 Pi SDK 可以在 macOS 受限 worker 内运行，模型请求由宿主持有凭据并通过逐调用 broker 派发。普通模型请求、同批工具、压缩、分支摘要和嵌套请求均有暂停证据。用量未知会保留预留并阻塞实例。无需修改 Pi 私有字段或上游源码。

```sh
pnpm install --frozen-lockfile
pnpm check
```

验证宿主：macOS 26.3、arm64。4 个测试文件、27 个测试；类型检查与完整测试通过。全部模型服务监听临时本地端口；不读取项目 `.env`，不使用真实供应商凭据或 MediaBookmarks 数据。

| 依赖 | 验证版本 |
| --- | --- |
| Node.js / pnpm | 24.20.0 / 11.19.0 |
| TypeScript / Vitest | 7.0.2 / 5.0.0 |
| pi-agent-core / pi-ai / pi-coding-agent | @earendil-works，均为 0.85.1 |
| sandbox-runtime | @anthropic-ai，0.0.75 |
| SQLite | Node 24.20.0 的 node:sqlite / SQLite 3.53.4；真实磁盘、WAL、FULL |
| 安装验证使用的 npm CLI | 11.16.0，经项目 Node 24 执行 |

准确传递依赖由根目录 pnpm-lock.yaml 固定。项目通过 pnpm 的本地运行时声明使用 Node 24；系统 Node 未改变。

## G01：实例和会话

证据：[pi-instance.test.ts](../../tests/m0/pi-instance.test.ts)、[Pi adapter](../../src/runtime/pi-instance.ts)。

- 新进程按持久 manifest 打开精确 session 文件；正常进程退出、首个助手响应前突然退出均恢复同一 session ID 和原消息。
- 两个实例上下文隔离；不匹配的实例/节点/定义绑定拒绝恢复。
- manifest 保存并校验精确 session ID；空会话文件不会被静默当成新会话。
- 模型切换保留实例、session 和消息；调用测试进一步验证切换后累计用量仍在原账户。
- Pi 默认延迟到第一条助手消息才创建 JSONL。适配层只初始化公开 header，再通过 `SessionManager.setSessionFile()` 重新打开；后续追加完全交给 Pi，避免与 SDK 的独占建文件逻辑冲突。

使用公开接口：`ModelRuntime.create/registerProvider`、`createAgentSession`、`SessionManager.create/open/setSessionFile`、`AgentSession.prompt/setModel/compact/navigateTree/subscribe`、`Agent.streamFunction`。此发布版本的 `ModelRuntime` 替代旧研究示例中的注册表/认证参数；未依赖临时 compat 导出。

## G02：逐调用控制和用量

证据：[pi-calls.test.ts](../../tests/m0/pi-calls.test.ts)、[call-broker.test.ts](../../tests/m0/call-broker.test.ts)。实现为 [CallBroker](../../src/runtime/call-broker.ts) 和 [受控 OpenAI adapter](../../src/runtime/controlled-openai.ts)。

| 路径 | 运行证据 |
| --- | --- |
| 普通模型 HTTP | 实际 fetch 前检查暂停和预算；暂停后服务端计数不增加。 |
| 已发送模型 | 暂停后可完成并结算，随后工具与模型均被拦截。 |
| 同批多个工具 | 第一个工具内暂停，第二个工具不执行。检查放在 execute 派发边缘。 |
| 手动压缩 / 分支摘要 | 暂停时不发送，恢复后发送并计量。一次压缩可能产生两个摘要请求，两次均计量。 |
| 自动阈值 / 溢出压缩 | 在真实 `compaction_start` 事件暂停，后续摘要与溢出续跑不发送。 |
| provider 内部重试 | 原生 OpenAI HTTP 503 返回只产生一次请求；强制 `maxRetries=0`，禁止 SDK 隐藏重试。重试须新建受控 invocation。 |
| HTTP 重定向 | 强制 `redirect=error`；服务端在 307 响应前触发暂停时，不发出重定向请求。 |
| 工具内部 LLM / 扩展模型提案 | 通过同一受控请求入口；暂停时不产生新请求。原始网络直连另由 G03 阻止。 |
| 缺失 usage | 成功、服务异常、上下文异常均验证；缺失原始证据会阻塞，resume 不解除该阻塞。 |
| 去重 / 重启 | 同一 invocation 重送相同结果不再次扣费；冲突结果拒绝；中断调用保留预留，重开数据库后阻塞重试。 |

OpenAI 原始 `prompt_tokens` 已包含缓存输入，`completion_tokens` 已包含推理输出。示例输入 40（其中缓存 15）、输出 10（其中推理 3），累计为 **50**，而非 68。SDK 自动填充的错误零值不作为用量证据。

当前为经过验证的 **OpenAI chat-completions SSE** lower-level adapter；每次 HTTP 使用唯一 invocation，保守预留模型 contextWindow + maxTokens，输出上限被适配层限制。上下文上限来自宿主确认的模型元数据；超出预留的实际用量会阻塞后续调用。其他 API、缓存写入格式及 WebSocket 尚无兼容声明，不能直接接入绕过准入。

SQLite broker 是 M0 的单所有者用量证明，尚非 M1 的完整任务数据库。它不解决双后台抢占、跨进程命令竞争、外部副作用核对或人工追加额度；不明用量目前持续阻塞，核对/解除流程由 G05 实现。

## G03：实际受限进程

证据：[restricted-process.test.ts](../../tests/m0/restricted-process.test.ts)、[执行 adapter](../../src/runtime/restricted-process.ts)、[worker 请求 broker](../../src/runtime/worker-requests.ts)。

- 使用真实 macOS OS sandbox；授权工作目录可读写，正式状态文件和合成凭据所在目录不可读取/修改。符号链接和子进程越界失败。
- worker 环境从最小白名单构建，不继承宿主环境凭据。测试只注入合成父进程 secret；worker 无法读取它。
- 默认拒绝全部网络域名及直接本地连接。访问真实监听的本地服务被阻止，服务端未收到请求。
- 读取工具只接收宿主登记的 resource ID；宿主选定地址、GET 和凭据，不跟随重定向。同一读取能力不能变成 publish 操作；域名可达性不代表发布授权。
- 扩展进程通过继承管道提出模型/读取请求；宿主持有模型配置、调用账户和真实请求凭据。扩展自报地址、密钥或操作名不能扩权。
- 真实 Pi SDK 在该限制下运行，并通过宿主 broker 完成一次模型请求、会话追加和计费。worker 不加载宿主的第三方扩展。
- 真实 npm 离线安装本地 tarball，包括 lifecycle script；安装成功，脚本在授权外写入失败。
- scripted MCP server 经真实 stdio 接收 initialize/tools-call，授权内文件写入成功，越界失败。这验证 MCP 进程的 OS 执行边界；完整 MCP client、连接管理和工具目录在 G10 接入。
- OS 进程派发也在准入门内。异步准备 sandbox 期间暂停，实际 spawn 被拦截。
- 跨进程修改授权路径也被验证：第一个 worker 把授权子目录换成指向正式状态目录的符号链接后，下一次使用原授权路径会被拒绝，不能重新解析成更大的权限。
- worker 临时目录在 OS 限制生效后创建，不通过可变 cwd 执行宿主文件写入。只读工作目录配合独立、已获写入权限的 scratchDir 可正常读取代码；工作目录本身保持不变。

SRT 自带若干可写日志/临时目录；适配层显式撤销与本任务无关的默认可写目录。读写路径和资源登记表均来自可信宿主，不接受 worker 自报授权。初始化失败或未验证平台直接报错，不降级为普通子进程。

授权路径须由宿主在发放权限时选定为准确 canonical 路径；执行器拒绝发生符号链接重定向或包含 glob 字符的路径。适配层对 SRT 0.0.75 公开返回的 shell wrapper 做严格格式解码，提取 profile 后追加固定路径的读取/写入上限，再直接启动 sandbox-exec；不执行 wrapper 文本，不继承其中的宿主环境扩展。追加规则防止 SRT 在构造 profile 时再次解析路径而扩大范围。该 wrapper 格式是固定版本维护点，未知格式直接失败，升级 SRT 必须重跑 OS 契约测试。

## 后续实施约束

1. G04/G05 建立任务状态、单后台所有权、操作意图/结果/不明日志及恢复核对；沿用已验证的派发门和保守结算规则。
2. G09 对用户配置的具体供应商补充原始 usage 和实际请求契约测试；不能把 SSE 单适配器的通过推及所有 Pi transport。
3. G10 把正式能力库、安装登记及 MCP client 接入受限 worker。任意扩展只能在受限进程运行，不能传入宿主的受信任函数接口。
4. 当前 RPC/进程封装用于 M0 实测；生产接入还需 worker 生命周期管理、日志持久化和请求背压。任务内核、图调度、Web、自动合并和 M6/M7 验收尚未实现。

产品首版范围保持原定义。此里程碑只确认接入路线，不替代完整机制与真实任务验收。

## Standards

独立审查及修复后的复审均未发现需处理的规范问题。实例、调用与进程三个测试入口符合既定测试约定，固定 SRT wrapper 格式的适配细节保留在进程模块内。

## Spec

独立审查确认的四处问题均已修复，并增加对应回归证据：

- **P1：HTTP 自动重定向绕过暂停。** 禁止自动跟随重定向；307 响应前暂停的场景只发送一次请求。
- **P1：重新解析符号链接扩大授权。** 拒绝被重定向的 canonical 授权路径，并在最终 OS profile 追加固定路径上限；跨进程替换授权子目录无法改写正式状态。
- **P2：空会话文件静默创建新身份。** manifest 保存 session ID，打开前验证 header；空文件明确拒绝恢复。
- **P2：宿主准备临时目录时可越权写入。** 目录准备移入受限执行，只写入已授权的 scratchDir；只读 cwd 不产生额外目录。

Standards：0 项；Spec：4 项已修复，最高原始等级为 P1。复审无待处理问题。
