# Issue #1 第 1 阶段可行性验证报告（常驻 Pi、配置重绑、模块隔离）

日期：2026-10-01。范围：Issue #1 第 13 节第 1 阶段（第 16 节要求先做的三个可行性验证）。
状态：三个 spike 均已实现并真实跑通，写成可重复的测试工件；两条**限制**实测暴露并按第 15.7 条明确报告。

## 结论速览

| Spike | 结论 | 证据（可重复） |
| --- | --- | --- |
| 1 常驻 Pi 多 turn | **可行**。同一 OS 进程、同一会话，跨 3 个 turn，PID 不变，三次真实 HTTP 模型请求 | `tests/m8/spike-resident-worker.test.ts` |
| 2 配置重绑 | **可行**。换 bundle digest 后重启进程，会话沿袭不断，模型看到历史 | `tests/m8/spike-config-rebind.test.ts` |
| 3 模块进程隔离 | **文件/环境隔离可行**；**进程启动无法在本 profile 形状下禁止（限制）** | `tests/m8/spike-module-isolation.test.ts` |

## Spike 1：常驻 Pi 多 turn

- 现状：生产 `src/runtime/pi-worker.ts` 一次 prompt 后 `process.exit(0)`；`openPiProcess` 首次 prompt 后即标记进程已耗尽。新内核要求相反：每节点一个常驻进程，接受 `start-turn`/`inspect`/`close` 直到图结束。
- 原型：`src/runtime/resident-worker.ts`。控制命令走 **stdin**，通知走 **fd 3**（带 `requestId` 回显），模型调用走 `controlledOpenAIStream`（与生产同一 transport）。
- 实测：`ready`（进程 pid）→ turn1（3 条消息）→ turn2（5 条消息）→ turn3，`inspect().processId` 恒定，`provider.requests.length === 3`，`close` 后进程退出。
- 含义：内核层「一节点一常驻进程、按 turn 串行」在真实 SDK 与本机沙箱下成立，不需要每 operation 起进程。计量/暂停 gate 是内核阶段叠加在已证明的常驻性之上的事。

### 过程中确认的两个真事实（写进注释，避免后人重踩）

1. `registerProvider(..., {apiKey})` **不足以**让原生 HTTP transport 拿到凭据：原生路径读的是 credential store，缺凭据会以 `No API key for provider` 在发起 HTTP 之前失败。生产 one-shot worker 之所以没事，是因为它用 `stream` 覆盖。
2. 由 1 推出：常驻 worker 沿用生产的 `controlledOpenAIStream`，而不是自己拼 fetch。

## Spike 2：配置重绑

- 机制已存在（ADR 0011，`pi-instance.ts`）：同 `stateDir`、不同 `bundleDigest` 或 definition 变化时，从 manifest 的 leaf 分支出新会话，记 `mode=rebind`。
- 实测：worker A（bundle-a）跑一个 turn → 停进程 → worker B（bundle-b，同实例同 stateDir）→ 新 pid、新 sessionId，但 turn B 的 transcript 仍含 A 的往返，`provider.requests.length === 2`。
- 含义：能力/身份变更可以在 **turn 之间**受控重建进程而保留会话沿袭；「进程身份与对话身份分离」成立。

## Spike 3：模块自定义代码进程隔离

契约固定在 `src/runtime/module-worker.mjs` + `src/runtime/module-evaluator.ts`：
`evaluate({inputs,state,trigger}) -> {state,outputs,diagnostics}`；5s 超时、输入/返回各 1 MiB、状态 1 MiB、同模块串行。
失败模式先列（R24），逐条用例钉住：

| 编号 | 失败模式 | 实测结果 |
| --- | --- | --- |
| F1 | 读 entry 之外的文件 | 拒绝（READ_DENIED） |
| F2 | 网络连接 | 拒绝（无 networkDomains） |
| F3 | 读宿主环境/凭据 | 干净（ENV_CLEAN，仅注入 PATH） |
| F4 | 启动其他进程 | **未拒绝（SPAWN_OK）——限制** |
| F5 | 超 5s | 杀掉，输入保留 |
| F6 | 超内存上限 | 见下 |
| F7 | 返回非法/超限值 | 拒绝，输入保留 |
| F8 | 抛异常 | 返回错误，输入保留 |
| F9 | 缺失输入 ≠ false/null | 标记存活（`{__missing__:true}`） |

### 限制 F4（按第 15.7 条明确报告，不包装为实现细节）

- 事实：seatbelt 文件 profile 不禁止 `process-exec`。实测强制加 `(deny process-exec*)` **或** `(deny process-fork)` 都会连 seatbelt 用来启动命令的 `/bin/sh -c` 外壳一起杀掉，于是模块根本不运行。
- 因此当前形状下**无法**在不破坏启动的前提下禁止模块启动子进程。
- 正确修法需要：让启动器 **直接 exec node**（不经 `/bin/sh -c`），或对子进程加 OS 级 `RLIMIT_NPROC`。这是内核阶段（Phase 4/9）的工作，不是本 spike 能收口的。
- 影响面：受限模块仍受文件/网络/环境三道隔离，且子进程继承同一 profile；但「启动进程」这一条尚未落实。**不得**退回宿主进程执行任意代码。

### 限制 F6（内存硬上限）

- 事实：`--max-old-space-size` 只约束 JS 堆。实测一个在堆外 `Buffer.alloc(200MB)` 的模块在 64MB 堆上限下**照常完成**。
- 结论：真正的进程内存硬上限需要 OS 级限制（`ulimit -v`/`RLIMIT_AS`）或宿主侧 RSS 看门狗，确切数值待内核阶段实测细化。本 spike 已用 `measurement.ms` 记录每次评估耗时，为后续测量留接口。

## 与后续阶段的关系

- 第 1 阶段另交付：新声明式 interface 解析器 `src/core/interface-spec.ts`（JSON 唯一正式格式、schemaVersion 2、边两端须同协议 id+版本、整份校验拒绝），以及三份可执行定义 fixture（流水线、返工、双 reviewer 汇合）。
- 第 2 阶段（DB schema 与事务）起，把本 spike 证实的常驻 worker 与模块评估器接进新内核；F4/F6 两条限制必须在模块正式可用前解决或再次明确报告。
