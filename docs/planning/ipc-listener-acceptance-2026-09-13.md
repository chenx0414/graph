# IPC 监听返工独立验收

日期：2026-09-13。**S4、R8 的原反例已修复，但新增两项可复现的 P2 监听回归，本轮暂不整体通过。** R6 的 OS 权限边界与此前 A13 交付认可保留。

## 范围

审查目标为 Graph `742bf982062ac373e7ceb54ee81a10695fdc6294`，固定比较为 `git diff 7476f1c...742bf98`，该区间仅一个修复提交。规格依据为上一轮 [R6 收尾验收](r6-acceptance-2026-09-13.md)、本轮返工报告，以及 [architecture.md:135](/Users/macmini/workspace/13-Graph/docs/architecture.md:135) 的已确认本机检查与宿主监听能力要求。

两轴子审查已并行启动，但分别因调用额度和认证错误未产出完整终审；本报告由主线程继续完成源码复核与真实受限 executor 复验，不将子审查的中间意见记作完整通过。

## 原问题复验

| 项目 | 独立结果 | 决定 |
| --- | --- | --- |
| S4 暂停拒绝遗留宿主监听 | 真实暂停 gate 拒绝，调用数 0，`listeners: []`；`executor.close()` 后仍为 0 | 原 S4 关闭 |
| R8 固定端口被替换 | 请求端口等于实际端口，向请求端口发 HTTP 得到预期正文 | 原反例通过 |
| R8 顺序监听耗尽 | 原五次启停探针全部成功；新增固定端口、六次启停、占用端口 `EADDRINUSE` 用例隔离运行通过 | 原 R8 两个反例关闭 |
| R6 权限边界 | 清除 `NODE_OPTIONS` 的 Node 子进程与 CLT Python 对 `0.0.0.0`、`127.0.0.1`、`::`、`::1` 的新 bind 全部 `EPERM`；正常宿主提供的 IPv4/IPv6 HTTP 均成功 | 保留 R6 原 P1 关闭 |

见 [本轮复验原始输出](acceptance-evidence/ipc-listener-verification.output.txt)。原 `host-listener-contract.mts` 内当前版本标签仍硬编码为 `7476f1c`；它实际动态导入工作区代码，本轮外层记录的完整 HEAD 为 `742bf982062ac373e7ceb54ee81a10695fdc6294`。不能把内层旧标签当作当前被测版本。

## Standards

未新增确认的硬性规范违反。按请求创建监听器移除了 dispatch 之前的预绑定，原 S4 的暂停拒绝泄漏已独立关闭。下列两项按本机检查行为的规格缺陷计入 Spec，不在两轴重复计数。

Standards：0 项新增发现。

## Spec

### R9 · P2 · 并发监听时，排队中的 socket 在 IPC 实际发送前被关闭

位置：[restricted-process.ts:329](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:329)，尤其是 `reply(..., listener)` 后立即执行的 `listener.close()`；发送实现见同文件第 314–318 行。

同时创建三个 `127.0.0.1:0` HTTP 服务，是每个请求都符合当前允许范围的正常使用方式。真实受限 executor 的对比结果：

| 相同程序 | 结果 |
| --- | --- |
| `283ffbb` 基线 | 3/3 监听成功，三个端口的 HTTP 正文分别为 `ok-1`、`ok-2`、`ok-3` |
| `742bf98` | 第一个成功，第二、第三个收到 `EPERM`；仅第一个端口可用 |

原因已与项目 Node 24.20.0 内置 `internal/child_process` 源码核对：存在尚未收到 ACK 的句柄时，`send()` 会把后续 Server 对象放入 `_handleQueue`，稍后才读取 `server._handle` 并实际发送。当前代码在排队时就关闭 Server，出队后没有可发送的句柄，最终仅发送成功消息正文。检查端收到 `ok: true` 却没有 handle，转而产生 `EPERM`。

因此“调用了 send”不能作为“句柄已交付”的依据。该行为不满足 [architecture.md:135](/Users/macmini/workspace/13-Graph/docs/architecture.md:135) 的逐次请求转交监听能力要求，会影响同时启动本机应用与测试辅助服务等检查。

修复出口：宿主在实际传输完成或明确失败前持有排队资源，随后统一释放；同时处理通道关闭、运行结束和失败出口，保留 OS `(deny network-bind)`。回归需同时启动多个服务，并逐个验证 HTTP 正文及关闭后的资源释放，不能仅依靠顺序启停。

### R10 · P2 · 等待监听期间调用 close，迟到回复仍重新启动服务

位置：[restricted-process.ts:90](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:90)。`close()` 只删除 `granted`，没有取消 `waiting` 中的监听请求；发出的 `graph-check-listener-close` 也被宿主按类型过滤忽略。第 108 行收到迟到回复后仍对同一个 Server 调用原始 `listen()`。

最小场景是 `server.listen(0, '127.0.0.1', callback); server.close(callback);`，200 毫秒后观察监听状态。使用同一合成程序和相同沙箱对比：

| 相同程序 | 结果 |
| --- | --- |
| `283ffbb` 基线 | close 回调后没有 listening 回调，`listening: false, address: null`，约 0.25 秒自然退出 |
| `742bf98` | close 回调之后又触发 listening 回调，`listening: true` 且端口有效；程序不能自然退出，2 秒后由探针超时机制 SIGKILL |

两版的 close 回调都可报告 `ERR_SERVER_NOT_RUNNING`；本发现针对取消后迟到的监听及进程无法退出，不针对这个错误码。异步启动期间触发测试清理或取消就会出现该行为，属于原监听生命周期要求内的回归。

修复出口：取消尚未完成的监听请求，使迟到回复只能释放句柄、不能重新启动 Server；同时维护 IPC 引用计数，确保取消后进程可自然退出。回归需覆盖 listen 后立即 close、迟到成功/失败回复，以及随后再次启动服务。

两个反例均由主线程独立复现两次，且基线在同一环境正常。完整可复跑 [探针](acceptance-evidence/ipc-listener-regressions.mts) 与 [结果](acceptance-evidence/ipc-listener-regressions.output.txt) 已保存。每个受限进程设置 2 秒截止时间，临时目录由 finally 清理；探针本身退出 0 表示采证完成，不表示其中每个场景通过。

Spec：2 项新增发现（R9、R10），均为 P2。

## 测试与验证限制

- 双 tsc 独立通过，Vite build 通过。
- 第一次 Graph [全量测试记录](acceptance-evidence/ipc-listener-graph-full-first.output.txt) 为 **175 通过 / 3 失败**，38 文件中 1 个失败：固定端口用例超时，其 afterEach 清理超时进一步影响两个后续用例。该次测试历时约 125.76 秒，最终自动结束；不能把这次执行描述为“全程每条命令不超过 60 秒”。
- 固定端口用例 [隔离复跑](acceptance-evidence/ipc-listener-graph-focused.output.txt) 通过，第二次 [全量复跑](acceptance-evidence/ipc-listener-graph-full-rerun.output.txt) **38 文件 / 178 项通过**，耗时 13.14 秒。第二次设置外部 40 秒上限。第一次超时未稳定复现，尚未证明与 R9 或 R10 同因，不能将其作为第三项确定的代码缺陷，也不能删去该失败记录。
- 从交付 `001f288a5a9fc797893497764d73bfe000bb198d` 导出源码和测试到临时目录，在当前受限 executor 中运行真实 Chromium E2E，**3/3 通过**；同环境全交付测试 **40/40 通过**。每次受限检查上限 15 秒，实际约 1.2 秒。见 [浏览器及交付输出](acceptance-evidence/ipc-listener-browser.output.txt)。
- 本轮结束检查未观察到本轮遗留的受限测试进程；R10 被超时机制终止的进程已回收。这不等于 R10 的自然退出行为正确。

## 验收决定

原 S4、R8 反例关闭；R6 的权限边界和此前 A13 交付继续认可。**新 R9、R10 修复前，不宣布本轮收尾或 Graph 整体完成。** 无需重跑收费模型任务，保留 OS 边界，针对 IPC 交付与取消补回归后复验即可。

本轮只新增验收报告、探针和输出，没有修改产品代码、任务数据库或交付仓库，没有提交、合入或发布。Graph 原有 `.gitignore` 修改与未跟踪 `docs/planning/m2-handoff.md` 保留。交付副本 HEAD 仍为 `001f288` 且干净；原仓库 `/Users/macmini/workspace/12-MediaBookmarks` HEAD 仍为 `1bed8f4` 且干净。

两轴计数：Standards 0 项；Spec 2 项，最高 P2。
