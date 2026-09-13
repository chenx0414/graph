# R13 收尾独立验收

日期：2026-09-13。**本轮通过，R13 关闭，未发现新的阻断问题。** 按此前已认可的验收范围，监听与本地网络检查这一轮返工收尾通过；R6、S4、R8–R12 及此前 A13 认可继续有效。

目标 Graph `e8e63355b718c9063c0e62c15d5b4dc3786f0eb0`；固定比较 `git diff 8f0e1b2...e8e6335`，区间仅提交 `e8e6335`。规格依据为 [上一轮验收](ipc-listening-release-acceptance-2026-09-13.md)、本次返工声明和 [architecture.md:135](/Users/macmini/workspace/13-Graph/docs/architecture.md:135)。两轴子审查均完成，主线程独立复跑了原反例及相关回归。

## Standards

**通过，0 项确认违反。** callback 在 `listen()` 调用时进入原生事件监听序列，删除两个手动调用点，没有引入额外的顺序状态。取消、失败与宿主 OS 权限边界保持原有结构。注释和新增顺序断言与实现一致；没有需阻塞的指定 smell。

读取本机 Node 内建 net 源码确认：原生 `listen()` 在调用时以 `once('listening', callback)` 注册，`close()` 不删除该 pending 监听器。因此取消或失败后保留 callback、在下一次成功监听时触发，不属于新泄漏。

## Spec

**通过，0 项发现；R13 关闭。** [restricted-process.ts:115](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:115) 在拦截调用的同一时刻注册 callback，ready 后只释放原生事件，callback 保留其原注册位置。

| 同一顺序探针 | 输出 | 退出码 |
| --- | --- | --- |
| 当前 `e8e6335` | `before → callback → after`，`ready:true` | 0 |
| 缺陷版本 `5fb3f66` | `before → after`，`ready:false`，初始化断言失败 | 1 |
| 基线 `283ffbb` | `before → callback → after`，`ready:true` | 0 |

当前与基线的业务 stdout 逐字节一致；缺陷版本仍失败，证明探针能够区分修复前后。各版本运行结束及 executor.close 后均无宿主监听残留。见 [原 R13 探针输出](acceptance-evidence/ipc-callback-final-order.output.txt)。

另检查了两个相邻生命周期：立即 close 后用同一 Server 再次 listen，以及 EADDRINUSE 后释放占用端口再 listen。当前与基线输出逐字节一致；原 pending callback、重试 callback、前后观察者按原注册位置各触发一次，`this` 均为原 Server，最终 `listening:false, address:null`，宿主监听归零。子审查与主线程分别复验。见 [探针](acceptance-evidence/ipc-callback-lifecycle.mts) 与 [输出](acceptance-evidence/ipc-callback-final-lifecycle.output.txt)。

## 独立验证结果

| 项目 | 本轮结果 |
| --- | --- |
| R11 事件驱动的外部客户端 | HTTP 返回 `ok`，CALLBACK 正常，无交接超时 |
| R12 重复 IPC ID | 检查退出及 executor.close 后宿主监听均为 0 |
| R9 并发监听 | 三个真实端口各返回对应正文 |
| R10 立即取消 | 无迟到 listening 回调，监听状态为 false，进程自然退出 |
| S4 暂停拒绝 | 调用数 0，宿主监听为 0，关闭后仍为 0 |
| R8 固定端口与反复启停 | 请求端口等于实际端口，五次 HTTP 启停成功 |
| R6 OS 权限边界 | 清环境 Node 子进程与 CLT Python 对四种 IPv4/IPv6 地址新 bind 全部 EPERM；宿主提供的 IPv4/IPv6 HTTP 正常 |
| Graph 全量 | 38 文件 / 179 项通过，12.90 秒 |
| 交付真实 Chromium E2E | 3/3 通过，约 1.4 秒 |
| 交付全量 | 40/40 通过，约 1.9 秒 |
| 静态与构建 | 双 tsc、Vite build、git diff --check 通过 |

证据：[R11](acceptance-evidence/ipc-callback-final-event.output.txt)、[R12](acceptance-evidence/ipc-callback-final-duplicate.output.txt)、[R9/R10](acceptance-evidence/ipc-callback-final-original.output.txt)、[边界及构建](acceptance-evidence/ipc-callback-final-verification.output.txt)、[Graph 全量](acceptance-evidence/ipc-callback-final-full.output.txt)、[浏览器及交付](acceptance-evidence/ipc-callback-final-browser.output.txt)。

本轮独立执行一次 Graph 全量，没有重复 agent 报告的三次全量或六路压力；双方运行次数不混记。原 host-listener-contract 探针内层当前版本标签仍硬编码为 `7476f1c`，实际动态导入当前工作区，外层证据已记录完整 HEAD。

## 验收边界与工作区

此前记录的返工问题在既有范围内均已有关闭结论；本次补上 R13 的最终独立证据。此前 A13 交付认可保留，交付目标仍是隔离副本 `graph-m7-acceptance-9/project` 的 `001f288a5a9fc797893497764d73bfe000bb198d`。原仓库合入、配置 remote 和发布不属于本轮动作。

历史未知用量、费用 unknown、已明确确认的超额，以及先前接受的脚本化提案/历史投影修复边界继续保留。本次没有重跑真实模型任务，也没有重新核算或修改历史任务数据。其他平台、官方 Pi 扩展 API 完整语义和其他 MCP transport 的既有未验证范围不因本轮通过而扩大。

本轮仅新增报告、合成探针和输出，未修改产品代码、数据库或交付仓库，未提交、合入或发布。交付源码与测试从上述固定提交导出到临时目录，完成后已清理。Graph 原有 `.gitignore` 修改和未跟踪 `docs/planning/m2-handoff.md` 保留；交付副本与原 `/Users/macmini/workspace/12-MediaBookmarks` 工作区干净，原仓库 HEAD 仍为 `1bed8f499b22e200e5a106330cd0890530b189f6`。

全量测试设置外部 40 秒上限，合成受限进程 2–5 秒，浏览器检查 15 秒；本轮均有界完成。结束检查未观察到本轮遗留的受限测试进程或探针监听器。

两轴计数：Standards 0 项；Spec 0 项。R13 关闭，本轮验收通过。
