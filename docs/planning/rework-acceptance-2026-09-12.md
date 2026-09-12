# 首版返工独立复验

日期：2026-09-12。**结论：旧六项发现可关闭，但整体仍未通过。** Graph `6004a2a` 新增的用量核对与本机联网路径存在回归；Web 已实际交付，另发现导出失败误报成功。

## 已确认的修复与运行事实

Graph 固定审查区间为 `git diff 2841c4d...6004a2a`，HEAD 为 `6004a2a0aeca074bf3d1357e8072a49ff8e03d37`；返工提交为 `8c17e26`、`135e353`、`fbbce07`、`edbf124`、`9efd856`，记录提交为 `ac735fc`、`6004a2a`。

| 原发现 | 独立复验结果 |
| --- | --- |
| S1 传输重试绕过暂停、遗漏未知用量 | 修复。服务收到完整 POST 后断线只收到 1 次请求；暂停后无新请求；未知调用保持 `unknown usage` 阻塞。可证明未发送的重试用新 invocation 重新过门。 |
| R1 MCP 无操作授权仍执行 | 修复。无授权效果计数 0，并产生精确 permission 问题；匹配授权效果计数 1；错误授权和回答续跑有回归覆盖。 |
| R2 MCP 握手后暂停仍发工具请求 | 修复。在已匹配授权的场景中，握手期间暂停后不再发送 initialized 或 tools/call，效果计数 0。 |
| R3 缺少本机 Web | 修复。交付含 `src/web/{server,page,main}.js`，真实浏览器可操作登录确认、采集、进度与失败、收藏和已有笔记、导出。 |
| R4 非零业务码被当作空结果 | 修复。独立探针的 `-352` 保留 code、原因及未完成范围，进入失败汇总。 |
| R5 采集异常不进入进度汇总 | 修复。独立探针中异常进入统一进度、日志及最终失败统计，已采集数据得以保留。 |

- Graph 使用项目 Node 24.20.0：双 TypeScript 检查、38 文件/173 项 Vitest、Vite build、`git diff --check` 均通过。
- 交付仓库 `/Users/macmini/workspace/graph-m7-acceptance-8/project` HEAD 与目标 main 均为 `b1754facb338fef460b70caa5982c570c0ffad6b`，工作区干净。相对 `725cb1be` 有错误修复、Web 实现和独立审查三次提交。
- 从精确交付提交导出源码和测试到临时目录，以 Node 26.3.0 独立运行交付测试，38/38 通过，包含真实无头 Chromium E2E；另用合成数据实际操作页面，确认已有笔记正文、部分采集成功、失败原因和导出产物。见 [测试输出](acceptance-evidence/a13-rework-38-tests.output.txt)、[浏览器观察](acceptance-evidence/a13-rework-browser.output.txt)。
- 任务 `0e3c3c4d-52ed-48fe-935c-7d568be9679d` 的四项当前有效证据均绑定 `b1754fac`，文件存在且 SHA-256 一致；实现与审查采用不同实例和模型；人工检查答复绑定同一提交。人工现场操作本轮未重跑。
- 487 次 invocation 中有 486 次已知用量，共 10,422,914 tokens，另 1 次保持 unknown；这只能称为**已知用量合计**。未知调用人工核对及审查超预留的答复记录均存在，费用仍 unknown。本轮发现节点累计账与 invocation 明细不一致，详见 S2。脱敏提取见 [运行审计](acceptance-evidence/real-run-rework-audit.json)。

本次接受已选定的 `reconcile_usage` 语义：供应商无法提供失败请求用量时，经使用者明确核对可保留 unknown 并继续。下列发现针对实现遗漏，不要求撤回这一产品决定。

## Standards

### S2 · P1 · 核对放行丢失同一 operation 内的已知用量

位置：[execution.ts:139](/Users/macmini/workspace/13-Graph/src/core/execution.ts:139)，关联 [task-gate.ts:10](/Users/macmini/workspace/13-Graph/src/runtime/task-gate.ts:10)。

`reconcile_usage` 直接将 operation 改为 `succeeded`，没有把已知调用累计到 `instances.used`；与此同时，`inFlightUsage()` 只统计 intent/dispatched/unknown 状态，该 operation 的已知用量也离开准入统计。

合成复现：同一次 operation 已消耗 19,999,950 个已知 token，另有一次 unknown。核对放行后 `used=0`，下一次预留 100 的请求仍实际发送，最终 `used` 仅为 100。未知部分可以保留缺口，已经确认的部分不能消失。

真实返工也已触发：`work-errors` 有 175 次调用，其中 174 次已知，共 **5,661,736 tokens**；核对后节点 `used=0`。因此报告的 invocation 明细合计正确，不等于 20M 节点额度正确执行。

违反 [graph-mvp.md:81](/Users/macmini/workspace/13-Graph/docs/graph-mvp.md:81) 的累计额度规则及第 83 行的新调用准入要求。修复出口：按 invocation 去重累计所有已知用量，独立保留未知缺口；验证核对、重复答复、重启、后续返工都不会漏计或重复计费。真实任务历史账也需核查并修复投影，保留原始未知记录。

### S3 · P2 · 核对放行跳过已确认结果的正常处理

同一位置 [execution.ts:139](/Users/macmini/workspace/13-Graph/src/core/execution.ts:139) 没有执行正常结算中的 output、route、outputVersion、等待问题及结果校验路径。

合成复现：已完成结果 `{answer:42}` 核对后节点显示 succeeded，但 `outputVersion=0`，后继收到 `{work:null}`；已提交的 waiting 结果核对后没有产生等待问题，而是变成 pending 并再次执行。真实 `work-errors` 同样 `outputVersion=0`，尽管保存的 operation.result 内有完整结构化交付输出。

违反 [architecture.md:121](/Users/macmini/workspace/13-Graph/docs/architecture.md:121) 的结果结算顺序，以及第 125 行“已确认的结果继续推进”。修复出口：抽出与 usage 是否齐全无关的结果验证和提交步骤，核对后保留原 outcome、输出、路由、问题和版本，保证幂等；不能只改 operation 状态。补计 token 不能单独修复此问题。

S2/S3 证据：[合成程序](acceptance-evidence/reconcile-usage-rework.mts)、[实际输出](acceptance-evidence/reconcile-usage-rework.output.txt)、[真实任务审计](acceptance-evidence/real-run-rework-audit.json)。

Standards：2 项硬违规，最高 P1。

## Spec

### R6 · P1 · 本机检查联网例外允许监听非 loopback 接口

位置：[restricted-process.ts:148](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:148)，调用方 [execution.ts:638](/Users/macmini/workspace/13-Graph/src/core/execution.ts:638)。

`localNetwork` 的 network-bind 和 network-inbound 实际允许 `*:*`，而 [architecture.md:135](/Users/macmini/workspace/13-Graph/docs/architecture.md:135) 将该例外限定为“绑定 loopback 并运行本机应用与无头浏览器测试”。

本机合成复现：关闭例外时，监听 `0.0.0.0` 被 EPERM 拒绝；开启后监听成功，客户端经本机非 loopback 网卡地址取得 HTTP 200 和模拟文本。该测试只访问本机，但证明沙箱允许服务器暴露在局域网接口，超出声明的回环边界；没有声称已由另一台设备访问，也没有发现外部主动连接已放开。

修复出口：将监听与入站都限定为 IPv4/IPv6 loopback，验证 `127.0.0.1`/`::1` 上的浏览器检查成功、全接口及非 loopback 监听被拒绝，Agent/MCP/扩展原禁网行为保持。

证据：[程序](acceptance-evidence/local-network-rework.mts)、[实际输出](acceptance-evidence/local-network-rework.output.txt)。

### R7 · P2 · Web 导出接口失败，页面仍显示成功

位置：[page.js:209](/Users/macmini/workspace/graph-m7-acceptance-8/project/src/web/page.js:209)，通用 API helper 没有检查 HTTP 状态，导出回调直接渲染“导出完成”。服务端 [server.js:263](/Users/macmini/workspace/graph-m7-acceptance-8/project/src/web/server.js:263) 则正确返回 HTTP 500 和错误原因。

独立无头 Chromium 复现：注入 `contextFactory` 抛出 `synthetic browser unavailable`，点击导出。实际响应为 HTTP 500、`{error:"synthetic browser unavailable"}`；页面显示“导出完成：索引导出 —；笔记 成功 0 / 失败 0”，没有失败原因。既有 E2E 的正常导出路径未覆盖此场景。

这不满足 [graph-mvp.md:116](/Users/macmini/workspace/13-Graph/docs/graph-mvp.md:116) 的失败反馈与 Markdown 导出闭环。修复出口：API helper 对非成功响应保留并传播服务端原因；导出页面显示失败并允许重试，不能用空成功汇总覆盖错误。增加真实页面的 HTTP 500 和网络拒绝回归。

证据：[浏览器程序](acceptance-evidence/web-export-error-rework.mjs)、[实际输出](acceptance-evidence/web-export-error-rework.output.txt)。主线程使用 Node 24.20.0 再次复现，服务、数据和浏览器均为本轮临时创建。

Spec：2 项发现，最高 P1。

## 后续复验范围

原 S1/R1–R5 的修复保留认可；A08 的原逐请求暂停缺陷已关闭。A06 仍受 S2 阻断，A10 仍受 R6 阻断；A13 的 Web 缺失已解决，但最终无缺陷通过结论仍需关闭 R7。S3 还影响后继获得结果和人工等待行为。

应针对上述四项补充回归并修复，再核对真实任务的累计用量和输出投影。无需为关闭这些本地机制缺陷重跑昂贵模型任务；交付改动需要重新绑定最终提交的测试、审查和受影响验收证据。

本轮未改产品代码、任务数据库或目标仓库；新增报告与合成证据，未提交或发布。原有 `.gitignore` 修改与 `docs/planning/m2-handoff.md` 保持原状。

两轴计数：Standards 2 项（最高 P1）；Spec 2 项（最高 P1）。
