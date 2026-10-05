# Issue #1 接手实施状态

工作分支：codex/graph-v2-complete；起点 5b5697c。实施仍在进行，不能关闭 Issue #1。

## 已修改并定向验证

- GraphRunner/NodeTurnDriver 传入真实队列 payload；首轮提供 graph、任务、验收、接口与协议；后续聊天不重复概览。
- 纯聊天不要求 submit；异常有有限重试，成功 submit 后失败不能重发。
- 后续 submit 使用当前连接；已入队投递继续保留。
- 完成意图独立持久化，blocked 时仍关闭外部输入且可撤销。
- 模块锁存不再因连续更新被清除；模块广播整体校验/事务写入。
- 模块输入逐次持久排队；判断和 inbox 消费同步提交；输出有恢复 outbox。
- lane 跨 tick 缓存，宿主按 graph/node 缓存，宿主退出拒绝 pending turn。
- 配方真实能力、skill/extensions/MCP 接入 resident worker；加载资源随 lane 关闭。
- main 管理工具 create/patch/inspect/control/send 接入；动态新增 admission、删除待处理工作限制、投递协议校验、公开结果与完成出口。
- 节点真实 prompt、assistant 消息、工具事件接入 node_entries；v2 TaskView 使用实际 ledger/model binding。
- 自定义模块使用 Node permission 模式补上 subprocess 禁止，输出字节限制在读取阶段执行，非法输出结构拒绝。
- execution 持久保存 retry/resubmit/pending gap；每 turn 重新预算 hold；重开数据库不刷新自动额度。
- v2 Graph HTTP 投影包含显式边、模块与 held state；结构缓存布局；边面板有 value/history，模块面板有规则/状态/重开。
- v2 nodeRun/nodePrompt 与独立聊天页接线；actual provider onSend 回写精确 system prompt/tool declarations，resident ready 记录真实 session。
- graph 内独立节点并行派发，submit 到达可在 producer 收尾前启动下游；节点仍串行。
- 产物修改权限加入权威存储层，身份绑定实际 kernel execution/admitted instance；首次作者不会被后续版本替换。

## 验证记录

第一次全量 check：272 文件，1768 passed / 8 failed，总计 1776；157.68 秒。
失败是主工具 preview 漏新工具（已修并定向通过）、blocked 队列立即重复领取撞 execution ID（已修并定向通过）、独立 worktree 未找到 sibling MediaBookmarks 项目（需设置 GRAPH_MEDIABOOKMARKS_ROOT；page fixture 已改用统一 helper）。
定向管理/模块/runner 6 文件 42 用例通过；真实宿主退出等 5 文件 17 用例通过；上述门禁产品回归 4 文件 15 用例通过。
日志在 /tmp/graph-v2-*.log。尚未提交。

## 必须继续完成

1. 正式 definition-only 切换和旧内核退役（ADR0030 已授权）；旧业务图调度器、旧 propose/revise 图语法仍在产品入口，不能宣称完成。
2. 验收/Git 交付门禁接入 v2：节点有独立 worktree，但成果尚未沿正式内核集成与交付；保留权限/预算/验收/Git 合并能力，不能删掉对应行为测试。
3. 去除 scripted path 从 legacy proposal 取输入的补偿；命令工具不得作为独立节点，外部操作应走宿主 broker 模块。
4. 模型/预算/retry 的节点局部配置及下一次执行生效；实际 recipe reviewer 身份仍需进一步核对。
5. resident OS 权限、native/extension tool 运行授权全面核对；未知副作用处理、提交后恢复剩余工作与停止收尾。
6. 子 graph 已正式展开并接通分组/折叠 UI；仍需嵌套模板映射、增量稳定布局、多条回边等复杂图验收。
7. 运行通知送达拥有者、真实统计视图、main 修改 graph 内产物、完整 acceptance/provenance 检查。
8. 全量门禁、实际新内核纵向验收、独立 review、领域文档和 ADR 更新后提交。不得将阶段性通过当作整个 spec 完成。

## 后续落地及验证

- 第三次全量 check 通过：272 文件、1783 用例，163.48 秒；日志 /tmp/graph-v2-third-integration-check.log。
- 自定义模块现在使用固定 Docker 镜像、Linux cgroup，默认进程内存 256 MiB、无额外 swap、1 CPU、32 pids，禁止网络、只读文件系统、Node permission 禁止外部文件/子进程。64 MiB 限制下分配 200 MiB Buffer 实测退出 137/OOMKilled=true。不可用时明确失败，无宿主 fallback。声明 limits 可调 timeout/memory/input/output/state 并留 revision。
- main 投递具有 durable direct Delivery，与 node queue/module inbox 原子落地；可送公开输入和模块输入。声明 control.reopen 只清 latch，保留业务输入，等待下一条投递。
- 正式 templates/instances JSON 入口固定模板版本，实例节点/边命名空间分离，公开映射编译为同一连接；分组折叠保留跨组边，带路径节点聊天 URL 正确编码。
- provider 生产请求走宿主 IPC，worker config 不含凭据；每次发送通过 durable provider ledger 与预算门禁，累计所有请求用量，避免 turn 再次计费。共享 credential scheduler 已接线，等待让出 execution slot，停止取消请求。底层权限还有待完整验收。
- runtime 获取 owner lock 后显式恢复中断 execution，保留输入/attempt/submit；未知 provider usage 可由 main 显式 reconcile_usage，幂等且不自动 resume。
- 协议验证改用当前依赖中的 Ajv 8.20.0（已增加直接依赖），验证 enum/additionalProperties/嵌套约束，拒绝非法 schema 和非 boolean enable。
- graph_create requestId 幂等，Git prepare 有 durable 状态；失败留下可检查的 graph ID，再次请求沿用原 graph 重试准备，不重复 admission。
- 32 个 authority/recovery/create 定向回归通过；14 个 subgraph browser/kernel 回归通过；51 个 schema/recovery/module/control 回归通过。完整门禁需要重新执行。

日志均在 /tmp/graph-v2-*.log。已验证的上一批改动提交为 d7f47b5；本文后续条目记录继续实施的改动，整个 spec 尚未完成。


## 常驻进程权限与嵌套边界

- 上一恢复点 d7f47b5 的第四轮全量门禁：272 文件、1790 用例全绿，日志 /tmp/graph-v2-fourth-integration-check.log。
- 生产 resident 现在通过已有 restricted executor 启动，使用实际能力 read/write/network grants；full access 沿用用户已授予的语义。IPC 通知独立于串行请求，模型和工具响应由宿主 stdin 控制，关闭/异常回收进程树。
- 实际 Pi + 扩展代码回归：工作区可写、非授权目录不可读，两个 turn 保持 PID 和 session，关闭后退出。现有 native graph 聊天/实际 prompt UI 回归通过。
- 嵌套 templates/instances 保存完整实例层级及具名 IO 映射；回归在修复前因 first/inner 接口丢失失败，修复后通过。
- submit 的 null/非 boolean envelope 返回纠正错误且不产生部分投递；自定义模块控制入口的 reopen 与 inbox acknowledgement 原子提交。产物工具不再以最新修订发布者错误覆盖存储层的原作者权限。
- 8 文件、74 用例定向验证通过，另有 malformed envelope 定向验证通过。全量门禁进行中。
- 下一阶段仍是原清单中的 Git 集成与最终验收、正式入口切换、节点局部配置与统计、通知及完整退役；这些尚未交付。

- 第五轮全量运行：272 文件中 271 通过；1792 通过、1 个 native UI 折叠边等待超时，163.68 秒。没有删除或放宽断言。子 graph 容器改为固定具名端口及已有布局尺寸，折叠时隐藏嵌套容器；浏览器等待边的观察上限明确为 10 秒，仍严格要求跨组边存在。单独 UI 5 用例通过；必须在同样全量负载复验，不能据单测宣告解决。日志 /tmp/graph-v2-fifth-integration-check.log。
