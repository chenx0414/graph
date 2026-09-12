# 首版工作报告独立验收

日期：2026-09-12。结论：**未通过，不能接受“首版完成”。** 真实模型运行、代码提交和测试结果有记录支持，但交付缺少规定的本机 Web 应用；新增的传输重试和远程 MCP 也存在可复现的执行边界缺陷。

## 验收范围与已确认结果

- Graph 被验收提交：`2841c4d7f1421eeaee95877c2fc378754fc7575a`。以上轮复验结束点 `9529605` 为基线，审查 `git diff 9529605...2841c4d`，另核对最终实现与真实运行记录。
- 报告来源：[work-report-2026-09-12.md](work-report-2026-09-12.md)。产品范围以 [graph-mvp.md](../graph-mvp.md) 为准，执行约束以 [architecture.md](../architecture.md)、[implementation-plan.md](../implementation-plan.md) 和 [ADR 0008](../adr/0008-definition-bound-capability-loading.md) 为准。
- 真实任务：`346cd2af-94e0-438d-aad6-4b2a9df925b2`。交付仓库为 `/Users/macmini/workspace/graph-m7-acceptance-7/project`，目标 `main` 和当前 HEAD 均为 `725cb1be6e005f45fdbe7000f6e0210fb47300bf`，工作区干净。
- 实现与审查使用不同实例、不同模型；记录中有 179 次 invocation、2,193,329 tokens，五项当前有效证据均绑定交付提交，文件存在且摘要一致。最终任务复用已确认提案这一边界已在原报告披露。
- 原仓库 `/Users/macmini/workspace/12-MediaBookmarks` HEAD 仍为 `1bed8f499…`，工作区干净。本轮未改动原仓库或交付仓库。

| 独立验证 | 结果 | 能证明的范围 |
| --- | --- | --- |
| 项目 Node 24.20.0；主程序与 Web TypeScript 检查 | 通过 | 类型检查 |
| Graph Vitest | 37 文件、162 项通过 | 已有测试覆盖的行为 |
| Vite build、`git diff --check` | 通过 | 构建与 diff 格式 |
| 命令改写 Git 元数据诊断 | `protected: true` | 上轮该阻塞点已修复 |
| 已确认检查 input 修订诊断 | 修订被拒，原失败检查保持阻塞、无通过证据 | 上轮该阻塞点已修复 |
| 精确交付提交中的四个离线测试文件 | 22/22 通过 | 已交付的 CLI/函数测试；不包含 Web 应用端到端测试 |
| 本轮新增反例 | 下文六项发现 | 现有通过结论没有覆盖的缺陷 |

真实运行记录位于 [acceptance-report.json](/Users/macmini/workspace/graph-m7-acceptance-7/acceptance-report.json)、[run-summary.json](/Users/macmini/workspace/graph-m7-acceptance-7/run-summary.json)。本轮核查了任务、用量、提交及证据绑定；“真实采集 60 条”的现场操作未重跑。诊断只使用本地服务和合成数据，不读取真实登录信息或收藏内容，不产生真实模型费用。

## Standards

### S1 · P1 · 传输重试绕过暂停门，丢失首个请求的未知用量

位置：[controlled-openai.ts:68](/Users/macmini/workspace/13-Graph/src/runtime/controlled-openai.ts:68)，外层派发在同文件第 96 行。

`fetchWithTransportRetry` 在一次 `broker.dispatch` 内最多重发三次 POST。服务端未返回响应头，不能证明请求没有被处理或计费；后一次成功后，程序仅用最后一次 usage 结算这个 invocation。

本地服务收到完整首个 POST 后断开 socket，并同步暂停 broker，随后仍收到相同的第二个 POST。输出为 `acceptedRequests=2, afterPause=1, invocationCount=1, used=50, hold=null`。不主动暂停的对照组同样有两个 POST、一个 invocation，最终保持 `ready`，没有为首请求建立未知用量阻塞。

这是硬性规则违反：[architecture.md:99](/Users/macmini/workspace/13-Graph/docs/architecture.md:99) 要求“重试用新 ID”，第 117 行要求 provider 重试经过实际派发入口，第 125 行要求用量未知时优先待核对并暂停；[graph-mvp.md:90](/Users/macmini/workspace/13-Graph/docs/graph-mvp.md:90) 要求暂停后不再发起下一个调用。

修复出口：保存不明请求的未知状态并阻塞；有证据允许重新发送后，用新 invocation 重新经过暂停和额度门，累计所有实际请求。应分别验证断线前服务端已接收请求、退避期间暂停，以及能够证明请求未发生的情形。

证据：[程序](acceptance-evidence/provider-transport-retry.mts)、[实际输出](acceptance-evidence/provider-transport-retry.output.txt)。两个表现属于同一根因，计一项。

Standards：1 项硬违规，最高 P1。

## Spec

### R1 · P1 · 远程 MCP 域名白名单直接放行外部写工具

位置：[capabilities.ts:124](/Users/macmini/workspace/13-Graph/src/runtime/capabilities.ts:124) 将服务返回的所有工具暴露并直接执行；同文件第 73 行仅检查域名，加载接口不接收任务操作授权。

生产 Runtime 复现：项目及任务 grants 均为空，仅允许 localhost MCP 域名。服务提供模拟 `delete_records` 工具，声明 `readOnlyHint:false, destructiveHint:true`；模型仍成功调用，模拟效果计数 `effects=1`，`questions=[]`，任务 `completed`。

规格：[architecture.md:133](/Users/macmini/workspace/13-Graph/docs/architecture.md:133) 要求“外部写操作经带范围授权的工具”；[ADR 0008](../adr/0008-definition-bound-capability-loading.md) 明确“域名放行不授权外部写操作”。

修复出口：每次远程工具执行前验证任务预授予的服务、工具和操作范围；未授权时拒绝并产生可处理问题。工具名称、描述或 MCP 自报的只读提示不能代替可信授权。回归同时覆盖无授权拒绝、范围不匹配拒绝与匹配授权成功。

### R2 · P1 · MCP 握手期间暂停，仍发送实际工具请求

位置：[mcp-client.ts:115](/Users/macmini/workspace/13-Graph/src/runtime/mcp-client.ts:115)。一次 `usageSettled`/gate 包住第 121 行的整个 HTTP 循环，后续 `fetch` 没有再次检查暂停。

生产 Runtime 复现：服务收到工具执行阶段的 `initialize` 后，等待 `task.pause()` 返回，再结束握手响应。之后仍收到 `notifications/initialized` 和 `tools/call`，两条记录均为 `paused:true`，模拟工具效果增加到 1。

规格：[implementation-plan.md:49](/Users/macmini/workspace/13-Graph/docs/implementation-plan.md:49) G02 的出口要求“在任一实际发送前关闭门后都不产生新请求”。暂停时尚未发送的 `tools/call` 不能按已发调用放行。

修复出口：将暂停检查落实到每次实际 HTTP 派发；在握手、工具列表、工具执行各发送间隙暂停，均不得再发送下一条请求，已经发出的请求可以结束。

R1、R2 证据：[程序](acceptance-evidence/remote-mcp-boundary.mts)、[实际输出](acceptance-evidence/remote-mcp-boundary.output.txt)。二者分别是操作授权缺失与派发时序错误。

### R3 · P1 · A13 缺少规定的本机 Web 应用

规格：[graph-mvp.md:114](/Users/macmini/workspace/13-Graph/docs/graph-mvp.md:114) 要求“增加本机 Web 应用，复用已有 CLI 能力”，第 116 行列出登录、采集、进度与失败原因、收藏和笔记浏览、Markdown 导出闭环；第 128 行将该 Web 应用交付列为首版完成条件。

交付提交只有 CLI 分发入口 [cli.js:79](/Users/macmini/workspace/graph-m7-acceptance-7/project/src/cli.js:79)；[bili-web.js:105](/Users/macmini/workspace/graph-m7-acceptance-7/project/src/commands/bili-web.js:105) 的收藏和笔记浏览用 `console.log` 输出文本。完整提交树没有提供本机 Web 服务或交互界面，唯一 HTML 是静态实施笔记。通过 Playwright 浏览 B站取得 cookie/采集数据，也不构成本机 Web 应用。

因此，[交付独立审查报告](/Users/macmini/workspace/graph-m7-acceptance-7/project/docs/review-bilibili-web-v1.md) 和五项有效证据能证明一组检查运行过，不能证明规定的界面已经交付。Graph 仓库自身的 Web 界面及以前的 scripted 案例，也不能替代本次目标提交中的实际产品。

修复出口：由 Graph 在验收副本交付可启动的本机 Web 应用，从该页面完成规定的五步闭环；浏览器端到端检查需覆盖真实页面操作、异步进度、失败原因、笔记正文及 Markdown 导出，确认导出产物可取得。重新取得绑定最终提交的独立审查和验收证据，并纠正“首版完成”记录。不得仅将 CLI 命令命名为 `bili-web` 后继续判通过。

### R4 · P2 · 收藏 API 业务错误被当作空结果成功

位置：[bilibili-web.js:133](/Users/macmini/workspace/graph-m7-acceptance-7/project/src/platforms/bilibili-web.js:133)。`listMedia` 只处理 `code === -101`，其他非零业务码继续返回空 `medias`。

离线模拟返回 `{code:-352,message:'synthetic rate limit'}`，最终 `items=0, failures={}, summary.fail=0`，打印“成功 0 条，失败 0 条”。规格 [graph-mvp.md:116](/Users/macmini/workspace/13-Graph/docs/graph-mvp.md:116) 要求查看失败原因；此处错误与空收藏无法区分。

修复出口：所有非零业务码均保留错误码与原因，统一进入失败处理，覆盖首屏及后续分页失败。

### R5 · P2 · 已捕获采集异常不进入进度与失败汇总

位置：[bilibili-web.js:206](/Users/macmini/workspace/graph-m7-acceptance-7/project/src/platforms/bilibili-web.js:206)，以及第 250 行的汇总；[命令第 80 行](/Users/macmini/workspace/graph-m7-acceptance-7/project/src/commands/bili-web.js:80) 也没有显示返回的失败原因。

注入 `listMedia` 抛出 `synthetic network failure`：局部返回对象记录了该错误，但 tracker 未收到失败事件，`summary.fail=0`、`summary.failures={}`，日志没有具体原因。即使 R4 改为抛错，这条显示路径仍会误报。

同样违反 [graph-mvp.md:116](/Users/macmini/workspace/13-Graph/docs/graph-mvp.md:116) 的进度与失败原因要求。修复出口：让采集异常进入统一进度和最终汇总；保留已采集结果，同时明确展示未完成范围、失败次数和原因。

R4、R5 证据：[程序](acceptance-evidence/a13-delivery-errors.mjs)、[实际输出](acceptance-evidence/a13-delivery-errors.output.txt)。交付现有 [22 项测试输出](acceptance-evidence/a13-delivery-tests.output.txt) 全绿，但没有覆盖这两个反例。

Spec：5 项发现，最高 P1（R1、R2、R3）；R4、R5 为 P2。

## 复验条件

当前应将 A06（缺失用量/重试）、A08（逐调用暂停）、A10（授权边界）和 A13（实际 Web 交付）列为未通过，其他已有证据保留。返工后先运行上述有针对性的反例与回归，再通过 Graph 完成 Web 任务，重新检查最终提交及其独立审查证据；仅重复运行目前的 162 项测试不能关闭这些发现。

本轮只增加验收报告与合成诊断证据，没有修改产品代码、原工作报告的结论或目标仓库，也没有创建提交或发布内容。新增文件以外，已有的 `.gitignore` 修改与 `docs/planning/m2-handoff.md` 保持原状。

两轴计数：Standards 1 项，最高 P1；Spec 5 项，最高 P1。
