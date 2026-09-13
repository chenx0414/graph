# R6 收尾独立验收

日期：2026-09-13。**原 R6 的 P1 可关闭；本次改动仍有两项 P2 回归，收尾暂未全通过。** 宿主预绑定加 OS 禁止 bind 已堵住原权限绕过，剩余问题在资源生命周期和正常监听行为。

## 范围与通过项

Graph 目标提交 `7476f1c3739967487979ec93eb9acd72c9e7d6ef`；固定审查 diff 为 `git diff 283ffbb...7476f1c`。沿用 [上一轮报告](third-round-acceptance-2026-09-12.md) 已关闭项，本轮集中验证宿主监听、沙箱边界、相关浏览器检查和清理。

- 项目 Node 24.20.0：双 tsc、38 文件/177 项 Vitest、Vite build、`git diff --check` 均独立通过。
- 原 `listen-guard-child-rework.mts`、`local-network-rework.mts` 独立复跑：直接通配监听被拒绝，移除预载的子进程也无法新建监听。
- 独立 Node 和 CLT Python 非 Node 子进程对 `0.0.0.0`、`127.0.0.1`、`::`、`::1` 的新 bind 全部 `EPERM`。通过宿主 fd 的 IPv4/IPv6 loopback HTTP 均成功返回合成正文。因此权限边界已由 OS 承担，**R6 原 P1 关闭**。见 [边界与兼容探针](acceptance-evidence/host-listener-contract.mts) 和 [实际输出](acceptance-evidence/host-listener-contract.output.txt)。
- 从既有交付 `001f288` 导出源码和测试到临时目录，在本次受限 executor 内运行两个浏览器 E2E 文件，3/3 通过；同一环境内全部交付测试 40/40 通过。检查进程每次设置 15 秒超时，实际均约 1.2 秒完成。见 [沙箱浏览器输出](acceptance-evidence/host-listener-browser.output.txt)。
- 本轮正常运行结束后，未观察到本轮创建的残留测试进程；所有合成探针清理了自己的临时资源。下文的暂停拒绝路径仍存在明确泄漏，不能用正常路径的清理结果覆盖。

## Standards

### S4 · P2 · 暂停拒绝派发后遗留宿主监听 socket

位置：[restricted-process.ts:239](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:239)。程序在 `broker.dispatch` 之前创建 8 个宿主监听器，释放只发生在成功进入派发回调后（第 256 行）。gate 拒绝后这段释放代码不执行；`executor.close()` 也没有持有和释放它们。

真实 CallBroker 合成复现：先 `pause()`，再 `executor.run({localNetwork:true})`，结果拒绝 `Instance paused`；broker 显示 paused、调用数 0，但留下 4 个 IPv4 和 4 个 IPv6 loopback 监听器。执行 `executor.close()` 后仍为 8。重复拒绝将累积端口和 fd，这些监听器也会保持宿主进程存活。

违反 [architecture.md:120](/Users/macmini/workspace/13-Graph/docs/architecture.md:120) 的派发与暂停门顺序及第 127 行的停稳规则。修复出口：给准备、派发、失败和关闭建立统一资源所有权；gate 拒绝、同步 spawn 失败、异步启动失败等出口均释放预绑定 socket。回归应验证拒绝前后活跃监听器数量不增加，关闭后归零。

证据：[程序](acceptance-evidence/host-listener-paused-gate.mts)、[实际输出](acceptance-evidence/host-listener-paused-gate.output.txt)。主线程再次复现；探针在 finally 手动关闭自身新增监听器，未遗留这些资源。

Standards：1 项硬问题，最高 P2。

## Spec

### R8 · P2 · fd 路由改变请求端口，并在四次监听后耗尽

位置：[restricted-process.ts:42](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:42) 无条件取预分配 fd，忽略 `listen()` 的请求端口；第 239 行每族固定创建四个，关闭后不会补充。

同一合成探针对比 `283ffbb` 与 `7476f1c`：

| 场景 | 283ffbb | 7476f1c |
| --- | --- | --- |
| `listen(62905, '127.0.0.1')` | 实际端口 62905，HTTP 正文正确 | 回调成功但实际端口 62925；请求配置端口得到 ECONNREFUSED |
| 同进程依次启停五个 `127.0.0.1:0` HTTP 服务 | 五次均成功 | 前四次成功，第五次 EPERM |

端口为本次探针临时选择，重跑会不同。这会使使用固定端口或多次创建服务的正常测试失败，不符合 [architecture.md:135](/Users/macmini/workspace/13-Graph/docs/architecture.md:135) 对已确认本机应用检查的支持。

修复出口：保留 OS 禁止不可信代码新增 bind，由可信宿主按请求端口和生命周期提供监听能力；端口占用等失败必须正确返回，不得静默替换端口。验证固定端口、自选端口、关闭再开及超过四次的服务生命周期。不能靠增加固定 fd 数量解决语义问题。

证据：[程序](acceptance-evidence/host-listener-contract.mts)、[实际输出](acceptance-evidence/host-listener-contract.output.txt)。探针对新旧版本运行相同逻辑，每条受限命令超时为 5 秒，实际整组不到 1 秒。

交付 40 项通过仍有明确验证范围：[test/web-app.test.js](/Users/macmini/workspace/graph-m7-acceptance-9/project/test/web-app.test.js:46) 会在 EPERM 时回退进程内 handler，所以全部绿灯不能证明任意数量的 HTTP 服务都在新沙箱正常启动。独立第五次监听反例直接验证真实 socket。

Spec：1 项发现，最高 P2；原 R6 P1 已关闭。

## 验收决定

A10 的原 R6 权限绕过已关闭，之前通过的 A13 交付与其他修复保留认可。本次仍需修复 S4、R8 后完成收尾；不要求重跑收费模型任务。保留新的宿主权限边界，针对两项生命周期问题补回归即可。

本轮只增加报告、合成探针和测试输出，未改产品代码、任务数据库或交付仓库，未提交、合入或发布。原有 `.gitignore` 与 `docs/planning/m2-handoff.md` 保持原状。

两轴计数：Standards 1 项（P2）；Spec 1 项（P2）。
