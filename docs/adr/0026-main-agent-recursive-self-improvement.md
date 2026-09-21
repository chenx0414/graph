# ADR 0026：Main Agent 的递归自我改进（RSI）

日期：2026-09-21

## 状态

已接受。

## 背景

Graph 已有两层自我修改：用户直接编辑可编辑 Prompt 文件，以及 `propose_system_change`
/ `apply_system_change` 这条需要用户批准的能力安装通道。两者都不足以让 Main Agent
在日常运行中改进承载它的 Harness：命令、文档、Prompt、策略、界面和运行时代码都在
Graph 源码里，而模型无法读取自己的运行轨迹、错误与评测结果并据此修改这些代码。

使用者要求：Main Agent 同时是执行者和改进者。它在执行任务时观察自己的运行轨迹、
错误和评测结果，主动诊断 Harness 缺陷，直接修改 Graph，验证并让改动自动生效；所有
RSI 操作必须对使用者可见、可审计。这一闭环建立在“完全访问”模式之上，且不保留需要
逐次批准的安全例外。

## 决策

- 新增 `rsi.ts`：一个宿主侧服务，解析 Graph 源码 checkout（`GRAPH_RSI_ROOT`、
  当前工作目录或打包应用根），要求它是 Git 仓库根且含 `package.json`。它不修改业务
  项目，只修改 Graph 自己。
- Main Agent 新增两个工具。`inspect_rsi_status` 只读源码根、当前分支、待重载请求和
  仍在运行的 operation 数量；`apply_rsi_change` 提交一次结构化变更：`title`、
  `problem`、可选 `evidence` / `diagnosis` / `impact` / `risk`、文件变更列表、可选
  `node` 检查，以及 `activate`。
- 文件变更支持 `write`、`replace`（每个 `oldText` 必须精确匹配一次）和 `delete`。
  只允许 checkout 内路径，拒绝 `.git`，拒绝路径逃逸，单文件上限 2 MB、单次变更集上限
  10 MB，并要求目标文件没有未提交改动。
- 写入后运行检查：先跑自定义 `node` 检查，再跑 `node --run check`；`activate` 为真时
  追加 `node --run app:build`。任一步失败即恢复文件快照；若本轮新建了 `rsi/*` 分支，
  切回原分支并删除它。
- 通过后提交到专用 `rsi/<slug>-<id>` 分支（已在该分支上则复用），提交信息为
  `rsi: <title>`。`activate` 为真时写出 `<stateDir>/rsi/restart.json`，记录 id、root、
  branch、commit 和请求时间。
- 桌面进程轮询 `/api/app/rsi/status`（app-token 保护）。当存在待重载请求且没有在途
  operation 时，它重启 daemon，成功后用 `/api/app/rsi/restart-ack` 清除该请求。只有
  在重载真正成功后才 ack，崩溃不会静默丢弃重载意图。
- 每次 RSI 操作都写 `rsi.change` 事件，并向所属 conversation 追加 `role=system`、
  `kind=rsi` 的消息，携带完整 receipt。界面把它渲染为独立报告卡：标题、状态、问题、
  分支、提交、文件、验证结果、重载状态与可折叠 diff。
- 完全访问模式下，Main Agent 的身份上下文新增一段 Harness 自我改进说明，要求它观察
  轨迹、诊断、用最小改动修复、验证并上报；不再需要先走用户审批。旧的能力安装通道
  （`propose_system_change` / `apply_system_change`）继续存在，用于能力包等配置变更。

## 后果

Main Agent 可以在同一次会话中把观察到的 Harness 缺陷变成已验证、已提交、会自动生效
的代码改动，执行者与改进者合一。改动落在独立的 `rsi/*` 分支并可审计，使用者始终能从
conversation 中看到发生了什么、改了什么、验证结果如何。

代价是：源码改动的正确性依赖 RSI 自带的检查与提交门槛，而不是人工审批；checkout 需要
是干净的 Git 仓库，打包应用默认没有源码 checkout，必须用 `GRAPH_RSI_ROOT` 指向一个
checkout 才能启用。自动重载会重启 daemon 并重新加载页面，运行中的会话由持久化状态
恢复。该闭环不承诺撤销已生效的外部副作用；这些仍走恢复与核对。
