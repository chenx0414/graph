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
- RSI 不限于修 bug：只要 Main Agent 能给出理由，修缺陷、重构、新增功能、改进命令或
  文档都属于 RSI。身份说明按“可改进即可改”表述，而不是“发现问题才改”。
- Main Agent 新增两个工具。`inspect_rsi_status` 只读源码根、当前分支、待重载请求和
  仍在运行的 operation 数量；`apply_rsi_change` 提交一次结构化变更：`title`、
  `problem`、可选 `evidence` / `diagnosis` / `impact` / `risk`、文件变更列表、可选
  `node` 检查、`activate` 和 `force`。文件变更列表可以省略，用于只重跑检查。
- 文件变更支持 `write`、`replace`（每个 `oldText` 必须精确匹配一次）和 `delete`。
  只允许 checkout 内路径，拒绝 `.git`，拒绝路径逃逸，并要求目标文件没有未提交改动。
  内容不设字节上限：变更集本身已经过一次模型工具调用，大文件也是合法改动；只有进入
  conversation 的报告 diff 有上限，因为那是要持久化和展示的部分。
- 写入后运行检查：先跑自定义 `node` 检查。检查在用户的 checkout 里、沙箱之外运行，因此继承环境，
  但主动丢弃 `DYLD_*`：第三方安装器可能用这些变量指向自己的同名系统库，让刚启动的 node 在加载自身库时就崩溃；
  同时保留继承的 `PATH` 顺序，并补上本机存在的标准开发位置（`/opt/homebrew/bin`、`/usr/local/bin` 等）：
  从桌面启动的应用只拿到 launchd 的最小 `PATH`，否则任何需要开发者工具链（`npm`、包运行器、浏览器）的检查会在验证对象开始之前就失败；
  命令本身走宿主的 node（打包应用用 `GRAPH_APP_NODE` 指向自带运行时，否则用 `PATH` 上的 node）。自定义检查给出快速内循环；改动 TypeScript 时至少带一条 `node --run typecheck`，让类型错误不必等到最后一刻的完整闸门才暴露；只有 `activate`
  为真、或没有提供自定义检查时，才追加 `node --run check`，并在 `activate` 为真时再跑
  `node --run app:build` 作为上线前的完整闸门。**检查失败不会丢弃改动**：文件保留在工作区、不提交、
  不重载，receipt 状态为 `checks_failed`，并把路径记入 `<stateDir>/rsi/working.json`。
  Main Agent 可以继续修复同一批文件，或传 `changes: []` 只重跑检查，直到通过。这样既
  容忍抖动，又让 Agent 迭代到成功。只有真正的意外错误（写入中途失败等）才恢复快照，
  避免留下不一致的半成品。
- 通过后提交到专用 `rsi/<slug>-<id>` 分支（已在该分支上则复用），提交信息为
  `rsi: <title>`。`activate` 为真时写出 `<stateDir>/rsi/restart.json`，记录 id、root、
  branch、commit、请求时间，以及 `force`。
- 桌面进程轮询 `/api/app/rsi/status`（app-token 保护）。当存在待重载请求且没有在途
  operation 时，它重启 daemon，成功后用 `/api/app/rsi/restart-ack` 清除该请求。只有
  在重载真正成功后才 ack，崩溃不会静默丢弃重载意图。`force` 为真时跳过“没有在途
  operation”这一条件，立即重载——Main Agent 有权选择强制重载，代价是可能中断仍在
  运行的 operation。
- 每次 RSI 操作都写 `rsi.change` 事件，并向所属 conversation 追加 `role=system`、
  `kind=rsi` 的消息，携带完整 receipt。界面把它渲染为独立报告卡：标题、状态、问题、
  分支、提交、文件、验证结果、重载状态与可折叠 diff。
- 完全访问模式下，Main Agent 的身份上下文新增一段 Harness 自我改进说明，要求它观察
  轨迹、寻找改进点（不限于缺陷）、用最小改动实现、验证并上报；不再需要先走用户审批。旧的能力安装通道
  （`propose_system_change` / `apply_system_change`）继续存在，用于能力包等配置变更。

## 后果

Main Agent 可以在同一次会话中把观察到的 Harness 缺陷变成已验证、已提交、会自动生效
的代码改动，执行者与改进者合一。改动落在独立的 `rsi/*` 分支并可审计，使用者始终能从
conversation 中看到发生了什么、改了什么、验证结果如何。

代价是：源码改动的正确性依赖 RSI 自带的检查与提交门槛，而不是人工审批；checkout 需要
是 Git 仓库。

RSI 只对“正在运行的这份代码”有意义，所以启用条件很具体：

- 源码/开发模式（在 checkout 里运行 `electron .` 或 CLI）：应用根就是 checkout，RSI
  默认可用，改动会立刻生效。
- 打包应用：`Graph.app/Contents/Resources/app` 是构建时复制出来的只读副本，不是 Git
  仓库，所以默认不可用——改仓库不会影响这份副本。要让打包应用也能自我改进，把
  `GRAPH_RSI_ROOT` 指向一个 checkout，桌面启动器会改从该 checkout 运行 daemon，
  于是“改哪份代码”和“跑哪份代码”重新一致，重载才会真正生效。该重定向要求 checkout
  里既有 `src/server/cli.ts` 也有构建好的 `dist/web/index.html`，否则回退到应用自带副本。
- 既没有 checkout、又不可用时，`inspect_rsi_status` 仍会暴露并返回 `available: false`
  与具体原因，`apply_rsi_change` 则不注册，避免 Agent 去改一份不生效的代码。

自动重载会重启 daemon 并重新加载页面，运行中的会话由持久化状态恢复。该闭环不承诺撤销
已生效的外部副作用；这些仍走恢复与核对。

## 2026-09-22：激活请求后的收尾与确认

实际轨迹显示，Main Agent 在成功请求激活后继续调用 RSI，会阻塞等待它结束的普通重载，
并可能把“已提交”误报为“已生效”。因此激活请求成功是当前 operation 的完成边界：工具结果
先落盘，Pi 在本批工具收尾后结束，不再请求下一次模型回复；同批尚未执行的工具不再执行。
Graph 返回“已提交，等待重载”的确定性回复，不额外生成下一步建议。

待重载期间，执行器保留新消息和待执行节点，暂缓新 operation 的准入，让既有 operation
自然结束；RSI 服务拒绝覆盖待重载请求或并发修改源码。`activate=false` 仍允许连续迭代，
检查失败也仍可在当前回合修复。`force` 保留中断在途 operation 的原有语义。

receipt 的 `status=applied` 只表示变更通过检查并提交；`activation.state` 分别记录
`saved`、`pending_reload`、`active`。宿主重载确认必须匹配请求 id、源码根、启动时提交，
且 runtime generation 高于发起请求时的 generation。确认后持久化激活信息、更新原报告卡，
记录 `rsi.activated`，最后清除请求并恢复派发。旧请求缺少 generation 时保留兼容，但不能
把请求文件消失本身当成激活证据。

## 2026-09-22：重载后的连续执行

激活结束当前 operation 是释放重载的边界，不是用户目标已经完成。发起请求时，宿主在
正式状态库保存关联请求、来源 operation 与提交的续跑记录；匹配的后台确认与唤醒在同一
事务中落盘。下一次 operation 原子领取它，并和已有排队消息一起处理；它是宿主恢复事件，
不伪造用户消息。重复确认和确认后重启不产生第二次续跑，派发前撤销则归还领取。
主管读取原会话中的未完成目标，先处理用户的新指令；目标已经完成时汇报后结束。
暂停推迟自动续跑，归档或终止时不自动唤醒。这保留当前用户控制，避免后台重载制造新工作。

桌面停止后台的定时器绑定当次进程，并在退出时清除；不能引用会被新后台覆盖的共享 child。
后台激活确认只证明对应版本已启动；桌面窗口还需加载成功，并持续存活越过旧进程的停止期限。
