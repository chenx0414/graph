# 第三轮返工独立验收

日期：2026-09-12。**结论：S2、S3、R7 可关闭，R6 仍未通过。** 新交付的 Web 修复及测试成立，但不能接受“四项全部关闭”或 Graph 整体完成的结论。

## 范围与已确认事实

- Graph：`283ffbb5c04c9ed37310b9436f4ce40174b4c53a`；固定 diff `git diff 6004a2a...283ffbb`，提交 `f83760b`、`cc563d8`、`f0ab310`、`283ffbb`。
- 交付：`graph-m7-acceptance-9/project` 的 `main` 与 HEAD 均为 `001f288a5a9fc797893497764d73bfe000bb198d`，由 `2551af8` 实现与 `001f288` 审查组成。交付工作区干净。
- Graph 使用项目 Node 24.20.0 独立运行：双 tsc、38 文件/177 项 Vitest、Vite build、`git diff --check` 均通过。
- 从精确交付提交导出 `src`、`test`、`package.json` 到临时目录，以项目 Node 24.20.0 运行全部交付测试，**40/40 通过**，包括真实无头 Chromium 正常闭环、导出 HTTP 500、网络拒绝及重试成功。见 [测试输出](acceptance-evidence/third-round-delivery-tests.output.txt)。
- 任务 `834a5a88-c5f7-45a7-9b52-a6e0e95b0e4a` 的 a1–a5 当前有效证据均绑定 `001f288`，文件存在且摘要一致；任务 completed。实现 flash、审查 pro，206 次调用，已知用量 3,481,777 tokens，本次任务没有未知调用；超预留答复已记录，价格未配置故费用 unknown。
- 本次提案脚本固定、未重跑主管模型，是已经披露的局部返工方式，不作为新缺陷。未使用的 scratch 占位文件不构成本轮阻塞。
- 原项目 `/Users/macmini/workspace/12-MediaBookmarks` 未改动；本轮未调用真实供应商或 B站，不重跑登录现场，仅用合成数据验证页面。

## Standards

**通过：未发现本次变更中的硬违规或值得提出的代码异味。**

S2 可关闭。独立重跑原探针后，核对放行正确累计 19,999,950 个已知 token，后续调用被额度检查阻止；新实现从唯一 invocation 记录汇总，复用正常结算和持久答复事务，重复答复不会重复计费。

S3 可关闭。completed 输出 `{answer:42}` 正确传给后继，outputVersion 为 1；waiting 结果保留原问题，后续调度不重新执行。核对路径现已复用正常结果验证、路由、输出与状态提交。

只读核对真实历史数据库及 [usage-repair.json](/Users/macmini/workspace/graph-m7-acceptance-8/usage-repair.json)：work-errors 累计用量为 **5,661,736**，与已知 invocation 合计一致；1 次未知调用仍保留；outputVersion 为 1，节点输出与保存的 operation.result 一致。外部修复证据按已接受的方式认可。

Standards：0 项发现。

## Spec

R7 可关闭。主线程再次执行 `web-export-error-rework.mjs`：实际 HTTP 500、原因 `synthetic browser unavailable`；页面显示“导出失败”及可重试，`falselyClaimsSuccess:false`、`displaysFailureReason:true`。40 项交付测试也包含网络拒绝和后续重试成功。

### R6 · P1 · 检查子进程可移除 listen 守卫，仍能暴露非 loopback 服务

位置：[restricted-process.ts:213](/Users/macmini/workspace/13-Graph/src/runtime/restricted-process.ts:213)，守卫通过第 217 行的 `NODE_OPTIONS` 注入；第 189 行的 OS 规则仍允许通配绑定。

[architecture.md:135](/Users/macmini/workspace/13-Graph/docs/architecture.md:135) 要求本地检查仅绑定 loopback，并声称“非 loopback 监听在到达操作系统前即被拒绝”。目前守卫仅修改 Node 的 `net.Server.prototype.listen` 和 `dgram.Socket.prototype.bind`。受限脚本本身可以启动子进程，并移除其环境中的 `NODE_OPTIONS`，子进程不加载守卫。

独立 Node 24.20.0 本机复现：

1. 同一个受限 runner 开启 `localNetwork:true`，直接运行监听脚本：绑定 `0.0.0.0` 返回 `EPERM`，表明原反例确实被新守卫拦住。
2. 改为运行父脚本，使用 `spawnSync(process.execPath, ['listen.cjs'], {env})`，其中 env 复制当前环境后删除 `NODE_OPTIONS`：子进程成功绑定 `0.0.0.0`，退出码 0。
3. 宿主通过**本机 Ethernet/Wi-Fi 的非 loopback IPv4 地址**请求该端口，成功收到 `synthetic-r6`。仅连接本机，没有访问其他设备或外部服务，但这证明监听与入站仍超出回环边界。

因此 R6 是**原 P1 未关闭**，不是新的独立发现。仅测试直接调用 Node listen 的拒绝路径，不能证明检查脚本和子进程受到不可绕过的限制。即使注入文件由宿主写入，环境变量仍可由子进程调用者移除。

修复出口：使用受限代码及其子进程无法移除的执行隔离，或由可信宿主持有监听 socket、向检查暴露必要接口。应同时验证直接监听、清除环境的子进程、非 Node 子进程，以及 IPv4/IPv6 loopback 成功与非 loopback 监听/入站拒绝。不要继续把可移除的 Node preload 当作 OS 权限边界。

证据：[复现程序](acceptance-evidence/listen-guard-child-rework.mts)、[实际输出](acceptance-evidence/listen-guard-child-rework.output.txt)。从 Graph 根目录运行：

```sh
./node_modules/.bin/node docs/planning/acceptance-evidence/listen-guard-child-rework.mts
```

该程序创建并清理临时数据和服务，只有模拟响应；退出 0 表示观察完成。诊断选择 Ethernet/Wi-Fi 接口，避免把未工作桥接接口的连接失败误判为沙箱拒绝。

Spec：1 项 P1（原 R6 未关闭）。

## 验收决定

A06 的累计用量缺陷与 S3 结果处理缺陷已关闭，A13 本次导出返工通过；A10 的 R6 边界仍未通过，因此 Graph 整体不能标记验收完成。先关闭该单一剩余问题，复跑机制反例与相关回归即可；不要求重做已通过的昂贵 Web 编码任务。

本轮只增加验收报告与诊断证据，未改产品代码、数据库、交付代码，未创建提交或发布。原有 `.gitignore` 与 `docs/planning/m2-handoff.md` 保持原状。

两轴计数：Standards 0 项；Spec 1 项，最高 P1。
