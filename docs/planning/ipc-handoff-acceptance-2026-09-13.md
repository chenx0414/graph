# adopted/ready 交接独立验收

日期：2026-09-13。目标 Graph `5fb3f66a2f7b8904ffa14bc0158cf0f41a32a9c3`，固定审查命令 `git diff 742bf98...5fb3f66`，区间仅提交 `5fb3f66`。

**R9、R10 原反例已修复，可以关闭；本轮新发现 R11、R12 两项 P2，收尾暂不整体通过。** 两轴子审查均完成，以下反例另由主线程独立复现。沿用 [上一轮验收](ipc-listener-acceptance-2026-09-13.md) 的范围与既有认可。

## 原问题与测试

| 检查 | 本轮独立结果 |
| --- | --- |
| R9 三路并发监听 | 3/3 真实端口正文分别为 `ok-1`、`ok-2`、`ok-3`，与旧基线一致 |
| R10 listen 后立即 close | 不触发 listening 回调，`listening:false, address:null`，约 0.25 秒自然退出；与旧基线一致 |
| S4 暂停拒绝 | 调用数 0、宿主监听列表为空；executor.close 后仍为 0 |
| R8 固定端口与顺序启停 | 请求端口等于实际端口；五次 HTTP 启停均成功；m4 中占用端口回归通过 |
| R6 OS 边界 | 清环境 Node 子进程与 CLT Python 对四种 IPv4/IPv6 地址新 bind 均 EPERM；宿主提供的 IPv4/IPv6 HTTP 正常 |
| Graph 全量 | 38 文件 / 178 项通过，12.20 秒 |
| m4 并行复跑 | 一批六路，每路 command-check 的 9 项全部通过；整批约 6.11 秒 |
| 交付源码与真实浏览器 | 当前 executor 内，真实 Chromium E2E 3/3；全交付 40/40；每次约 1.2 秒 |
| 静态与构建 | 双 tsc、Vite build、git diff --check 通过 |

证据：[R9/R10 原探针输出](acceptance-evidence/ipc-handoff-original-regressions.output.txt)、[Graph 全量](acceptance-evidence/ipc-handoff-graph-full.output.txt)、[边界与六路复跑](acceptance-evidence/ipc-handoff-verification.output.txt)、[浏览器与交付](acceptance-evidence/ipc-handoff-browser.output.txt)。

原 `host-listener-contract.mts` 的内层当前版本标签仍硬编码为 `7476f1c`，实际导入本轮工作区代码；本轮外层记录的完整 HEAD 为 `5fb3f66a2f7b8904ffa14bc0158cf0f41a32a9c3`。本轮没有独立重跑 agent 报告中的全部 30 组或三次全量，不把对方的运行次数记成本轮次数。

## Standards

0 项确认违反。本次注释解释了 IPC 队列和交接约束，领域用词与仓库约定一致；新增状态集合和清理分支有收敛空间，但不足以单独报告阻塞性 smell。

Standards 子审查另发现了下列 R12 生命周期反例；其依据属于受限检查的行为要求，计入 Spec，不在两轴重复计数。

## Spec

### R11 · P2 · 原生 listening 事件提前暴露，宿主仍可能接走连接

位置：[restricted-process.ts:128](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:128) 至原始 `listen.call`；第 111 行只延迟传给 `listen()` 的 callback。检查自身通过 `server.on/once('listening')` 注册的事件处理器仍在 adopted 通知之前运行，此时宿主副本仍能 accept。

真实受限程序注册 `once('listening', ...)`，在该事件中写入 ready 标志并进行 250ms 的同步初始化。另一个客户端观察到标志后向固定 loopback 端口发送 HTTP 请求。使用完全相同程序对比：

| 版本 | HTTP | listen callback |
| --- | --- | --- |
| `5fb3f66` | 约 604ms 超时 | 未触发 |
| `283ffbb` | 约 251ms 返回 `ok` | 正常触发 |

这不是只看事件顺序的推测，实际请求已经失败。检查的事件处理器执行时，宿主接走连接；随后宿主在 [第 385 行](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:385) 等待 `held.close()` 完成后才发 ready。仅延迟显式 callback 没有覆盖正常的事件订阅方式。

违反 [architecture.md:135](/Users/macmini/workspace/13-Graph/docs/architecture.md:135) 的“待检查确认 adopt 后再完全关闭宿主副本并放行其 listening 回调”及正常本机应用检查要求。现有 callback 回归与并行压力通过，不能证明事件路径的交接窗口已经消除。

修复出口：交接完成时点同时覆盖 callback 与原生 listening 事件，并保证宿主在交接期间不会接收业务连接。回归应包括事件驱动的外部客户端、启动阶段有同步初始化的情形及资源关闭。保持 OS deny network-bind。

证据：[可复跑探针](acceptance-evidence/ipc-handoff-listening-event.mts)、[主线程结果](acceptance-evidence/ipc-handoff-listening-event.output.txt)。子审查重复两次、主线程再次复现；每个受限进程上限 3 秒，实际约 0.95 秒。程序设置 900ms 关闭服务以保证采证结束，退出 0 不表示客户端 HTTP 成功。

### R12 · P2 · 重复 IPC 请求 ID 覆盖资源所有权，检查退出后宿主监听仍残留

位置：[restricted-process.ts:396](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:396)。宿主直接用检查提供的 ID 执行 `pendingListeners.set(requestId, listener)`，未处理重复 ID；第二个 listener 覆盖第一个。[第 338 行](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:338) 的终止清理只能枚举 Map 末值，无法关闭被覆盖的对象。

合成检查直接发送两条 `{type:'graph-check-listener', id:44, host:'127.0.0.1', port:0}`，250ms 后正常退出：

| 版本 | 检查退出后宿主监听 | executor.close 后 |
| --- | --- | --- |
| `5fb3f66` | 仍有 1 个 loopback 监听，本轮端口 53881 | 仍为 1 个 |
| `742bf98` | 0 | 0 |

检查进程可以直接调用 `process.send`，宿主不能把预载生成唯一 ID 当作可信前提。这是跨过检查进程寿命的宿主 socket 泄漏，可积累端口和文件描述符，违反原 S4 的结束/关闭释放要求，以及 [architecture.md:135](/Users/macmini/workspace/13-Graph/docs/architecture.md:135) 的可信宿主句柄所有权要求。它没有推翻 OS 对新 bind 的拒绝结论，属于另一条资源生命周期问题。

修复出口：在分配资源前校验请求状态与 ID 重复，保证每个已创建 listener 始终有宿主所有者和统一清理出口；异步回调也不能按复用 ID 删除其他对象。回归验证重复请求、正常退出和 executor.close 后监听数量归零。

证据：[可复跑探针](acceptance-evidence/ipc-handoff-duplicate-id.mts)、[主线程结果](acceptance-evidence/ipc-handoff-duplicate-id.output.txt)。两名审查者分别复现；每个检查上限 2 秒，整组约 0.9 秒。探针 finally 主动关闭了本次泄漏的监听器，没有把已证明的泄漏留在环境中。

Spec：2 项新增发现，R11、R12 均为 P2。

## 验收决定与边界

R9/R10 原反例关闭，R6 OS 权限边界和此前 A13 交付认可保留。**R11/R12 修复前，不宣布本轮收尾或 Graph 整体完成。** 本轮正常测试未复现上一轮的全量超时，但 R11 证明另一条正常监听入口仍有交接竞态，不能认可“所有挂起根因均消除”的泛化结论。

无需重跑收费模型任务。本轮只新增报告、探针及输出；没有修改产品代码、任务数据库或交付仓库，没有提交、合入或发布。交付测试来自 `001f288a5a9fc797893497764d73bfe000bb198d` 的临时导出，已清理。交付副本与原 `/Users/macmini/workspace/12-MediaBookmarks` 状态干净；Graph 原有 `.gitignore` 修改及未跟踪 `docs/planning/m2-handoff.md` 保留。

全量测试有外部 40 秒上限，六路测试整批有 35 秒上限，合成受限进程为 2–3 秒，浏览器检查为 15 秒。实际命令均在上限内完成；结束检查未观察到本轮遗留的受限测试进程。R12 宿主监听由探针手动释放，该清理不能作为产品行为已通过的证据。

两轴计数：Standards 0 项；Spec 2 项，最高 P2。
