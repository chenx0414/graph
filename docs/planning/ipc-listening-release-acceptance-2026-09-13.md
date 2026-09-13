# listening 事件释放独立验收

日期：2026-09-13。审查目标 `8f0e1b2f9572e4e5dce5e69fa77b318146cda551`；固定比较 `git diff 5fb3f66...8f0e1b2`，区间仅一个修复提交。

**R11、R12 的原反例通过，可关闭；另有一项相关 P2 兼容性缺口未解决，暂不整体通过。** 该顺序问题在 `5fb3f66` 已存在，不归因为 `8f0e1b2` 首次引入。两轴子审查均完成，关键反例由主线程再次独立复现。沿用 [上一轮验收](ipc-handoff-acceptance-2026-09-13.md) 的范围与已通过结论。

## 原问题与验证

| 检查 | 本轮独立结果 |
| --- | --- |
| R11 事件过早暴露端口 | 外部客户端约 247ms 返回 `ok`，`CALLBACK` 正常；基线约 253ms 返回 `ok` |
| R12 重复请求 ID 泄漏 | 检查退出及 executor.close 后宿主监听均为 `[]` |
| R9 三路并发 | 3/3 真实端口返回对应正文 |
| R10 立即取消 | 无 listening 回调，`listening:false, address:null`，约 0.31 秒自然退出 |
| S4 暂停拒绝 | 调用数 0，无宿主监听；executor.close 后为 0 |
| R8 固定端口、顺序启停 | 请求端口等于实际端口；五次 HTTP 启停成功 |
| R6 OS 权限边界 | 清环境 Node 子进程与 CLT Python 对四种 IPv4/IPv6 地址新 bind 均 EPERM；正常宿主提供的 IPv4/IPv6 HTTP 成功 |
| Graph | 38 文件 / 179 项通过，12.57 秒 |
| 交付 | 当前 executor 内真实 Chromium E2E 3/3，全部交付 40/40，分别约 1.5 秒和 2.0 秒 |
| 静态与构建 | 双 tsc、Vite build、git diff --check 通过 |

证据：[R11](acceptance-evidence/ipc-listening-release-event.output.txt)、[R12](acceptance-evidence/ipc-listening-release-duplicate.output.txt)、[R9/R10](acceptance-evidence/ipc-listening-release-original.output.txt)、[边界与构建](acceptance-evidence/ipc-listening-release-verification.output.txt)、[Graph 全量](acceptance-evidence/ipc-listening-release-graph-full.output.txt)、[浏览器及交付](acceptance-evidence/ipc-listening-release-browser.output.txt)。

原 host-listener-contract 探针的内层版本标签仍硬编码为 `7476f1c`，实际动态导入本轮工作区代码；外层输出记录了完整被测 HEAD。本轮独立执行一次 Graph 全量，没有重跑 agent 报告中的三次全量及六路压力，不混用双方的执行次数。

## Standards

**通过，0 项确认违反。** 事件暂存与恢复集中在 `holdListening` / `releaseListening`；重复 ID 在资源分配前被拒绝；正常交接、取消和同步 adopt 异常均有恢复出口。没有达到阻塞程度的指定 smell。

子审查还验证了“提前 adopted 与 localhost 异步绑定可能脱离资源清理”的疑点：当前版本及旧版本在运行结束、executor.close 后均无监听残留，疑点未证实，不计发现。

## Spec

### R13 · P2 · listen callback 被移到事件序列末尾，注册顺序仍未恢复

位置：[restricted-process.ts:138](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:138)。ready 分支先 `releaseListening(server, true)`，发完所有原生 `listening` 事件处理器，再在第 142 行手动调用 `listen()` callback。这会把 callback 固定放到所有事件处理器后面。第 112 行只将 callback 存入 waiting，没有保留它在原生事件序列中的注册位置。

实际初始化反例：

```js
let ready = false;
server.once('listening', before);
server.listen(0, '127.0.0.1', () => { ready = true; });
server.once('listening', () => assert.equal(ready, true));
```

同一真实受限 executor 探针结果：

| 版本 | 执行顺序 | 初始化检查 |
| --- | --- | --- |
| `8f0e1b2` | before → after；断言发生在 callback 前 | ready=false，退出 1 |
| `5fb3f66` | before → after；断言发生在 callback 前 | ready=false，退出 1 |
| `283ffbb` | before → callback → after | ready=true，退出 0 |

本次返工声明“再按 Node 顺序放行”，而当前行为仍会使后注册的观察者在初始化 callback 之前执行，造成原本正常的初始化检查失败。此项属于 R11 交接语义的剩余兼容性问题，依据还包括 [architecture.md:135](/Users/macmini/workspace/13-Graph/docs/architecture.md:135) 对正常本机检查以及事件/回调一并释放的要求。**不是 `8f0e1b2` 新引入的回归，也不推翻原 R11 抢 accept 反例已经修复的结论。** 本轮给它独立编号 R13，避免重开已通过的具体反例。

修复出口：保留 callback 在原生 `listening` 事件序列中的注册位置，ready 后统一释放；不要把 callback 从该序列中拆出并固定最后调用。回归应覆盖 callback 前后注册的观察者、初始化依赖以及取消后的再次监听，继续保留宿主交接与 OS 权限边界。

证据：[可复跑探针](acceptance-evidence/ipc-listening-order.mts)、[主线程输出](acceptance-evidence/ipc-listening-order.output.txt)。两名审查者分别复现；每个受限进程上限 2 秒，主线程实际各约 61–67ms。运行结束及 executor.close 后宿主监听为空。探针退出 0 表示采证完成，其中当前版本的初始化检查退出码为 1。

Spec：1 项 P2 剩余兼容性问题；原 R11/R12 反例关闭。

## 验收决定与边界

R11/R12 原反例关闭，既有 R6 权限边界、S4/R8/R9/R10 以及 A13 交付认可保留。**R13 修复前不宣布本轮收尾或 Graph 整体完成。** 无需重跑收费模型任务；聚焦事件注册顺序补回归即可。

本轮只新增验收报告、合成探针及输出，没有修改产品代码、任务数据库或交付仓库，没有提交、合入或发布。交付测试来自 `001f288a5a9fc797893497764d73bfe000bb198d` 的临时导出，已清理；交付副本与原仓库 `/Users/macmini/workspace/12-MediaBookmarks` 均干净，原仓库 HEAD 仍为 `1bed8f499b22e200e5a106330cd0890530b189f6`。Graph 原有 `.gitignore` 修改和未跟踪 `docs/planning/m2-handoff.md` 保留。

全量测试设外部 40 秒上限，合成受限进程 2–5 秒，浏览器检查 15 秒；本轮均有界完成。结束检查未观察到本轮遗留的受限测试进程。

两轴计数：Standards 0 项；Spec 1 项，最高 P2。
