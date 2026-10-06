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


## 拥有者通知与停止收尾

- 第六轮完整门禁通过：272 文件、1793 用例，164.41 秒；验收证据未改写。上述常驻权限/嵌套边界修复已提交 c0674be。
- native kernel 公开输出原子写入结果与独立 graph_output wake，业务值仍由公开输出保存；运行失败、模块缺陷、完成及停止分别通知 main。peer 聊天写入会话并唤醒 main。
- 两个 graph 的完成通知使用独立去重键，故障去重绑定 execution/delivery 事件，重试后新故障不被旧通知吞掉；terminal lifecycle 重复调用保持幂等，不能由 withdraw_complete 或 patch 重开已结束 graph。
- owner boundary 回归在 c0674be 上得到空通知列表（预期为一个输出和两个完成），修复后通过。生命周期/通知/runner 定向 51 用例通过。
- runtime shutdown 先停止新执行及重试，dispose 常驻服务，再等待 kernel 写入者结算后关闭 SQLite；正在建立的会话会清理已取得能力，不会在关闭后缓存/启动新 worker。未知用量与原输入保留，提交后工作不能重放。
- 真实 Pi 向悬挂 HTTP provider 发出一次请求后关闭 runtime：请求取消、execution blocked、queue queued、provider usage unknown、retries_used=0，并且磁盘状态可重新打开。3 个真实 browser/process 用例通过。
- 未完成项仍包括最终验收/Git、正式入口与旧内核退役、节点局部配置/实际 reviewer 身份及历史统计、复杂 graph 增量布局等。还需核对异步配置准备与 execution 修订冻结的一致性、模块执行期间控制操作串行，以及副作用/预算恢复的完整路径。


## 宿主操作模块与失败输入处理

- 第七轮完整门禁通过：272 文件、1797 用例，165.84 秒；上一批提交 efdc82f。
- 新 operation 模块通过正式 graph 输入/输出触发 workspace.command。生产没有模型的模块图也可运行；命令权限沿用现有 workspace runner，sandbox:false 要求 full access。没有新增独立工具节点。
- 操作派发与结果保存有 durable ledger；保存结果后、投递前中断，重启从结果继续投递而不重做命令。真实文件副作用回归证明只执行一次。
- 停止真实长时间命令会终止进程组，保留 uncertain 操作供 main 通过 operations 查询检查。cancel_operation 显式消费原输入，不撤销副作用、不伪造成功，重复取消幂等。
- 完成请求不能跳过失败输入；retry/skip 同时恢复节点调度状态与等待中的完成请求。回归在移除修复时失败（completed 而预期 blocked），修复后通过。
- 两个文件 26 个用例定向通过，包括真实命令运行、重开、恢复去重、停止和失败输入控制；后续细微防御修正纳入本轮全量门禁。
- 完整 spec 仍未完成：最终版本验收与 Git 集成、正式产品入口/旧内核退役、节点配置与统计、模块控制串行及复杂图布局仍需继续。commit 字段只是命令启动前 HEAD，不能冒充精确版本验收证据。


## 异步配置与控制的串行边界

- 第八轮完整门禁通过：272 文件、1802 用例，200.86 秒，证据未改写；提交 7d0cab1。
- 会话准备前先领取输入、保存 execution 的 revision，再将该 revision 传给配置/能力会话/host 组装，避免 patch 期间运行旧配方却记录新配置。回归修复前实际得到 revision 2（预期 1）；修复后第一项保留 1，下一项使用 2。
- main 的 reopen 与异步模块判断共用串行队列；不会在判断写回锁存时丢失 main 的重开意图。回归修复前 triggered=1（预期 0），修复后保留输入，下一条投递再次触发。
- 配置冻结定向 4 文件 26 用例通过，含实际 Pi 聊天和 shutdown；串行控制定向 5 文件 37 用例通过。
- operation 查询提供解析后的实际 request/result，main 可以检查执行命令、参数、工作位置及持久结果。
- 整个 spec 仍未完成，尤其是最终 commit 验收/Git 交付和旧内核正式切换，不应把上述门禁通过视为产品验收。


## 配方审查身份与实际节点提示

- 第九轮完整门禁通过：272 文件、1804 用例，205.54 秒；证据未改写，配置冻结/模块串行控制提交为 58e7944。
- v2 会话使用 recipe.review 决定 reviewer/work 身份、规则与能力 action，不再全部硬编码 worker。节点视图读取实际绑定角色，没有记录时不编造 worker。
- 新的可编辑 runtime/node.md 描述实际 submit、接口、聊天和稳定引用；不再给 reviewer 注入“开始写实现”或旧 submit_result 运行指导。
- 实际 Pi 两次聊天证明：修改节点运行指导后，第二次实际 provider 请求使用新文本，session ID 保留；配置缓存纳入相关可编辑提示，host 使用同次配置准备的能力会话，避免再读活动配置。
- 配方角色回归修复前注入 WORKER POLICY 而没有 REVIEWER POLICY；真实提示更新回归修复前第二次仍使用 FIRST 而非 NEXT。各自在修复后通过，3 文件 12 用例定向验证通过；角色视图新增验证纳入本轮完整门禁。
- 审查工作副本刷新、独立模型排除与不可变调用历史仍待接线；最终验收/Git 与正式旧内核退役仍是未完成事项。


## Native 执行完成与 Git 集成

- 第十轮完整门禁通过：272 文件、1804 用例，202.50 秒；证据未改写；配方身份与提示更新提交为 d1f4eb3。
- task execution 完成前接入实际工作副本结算，复用 GitIntegration 的提交/合并与冲突处理；接口 submit 仍立即投递。聊天不执行 Git 集成，reviewer 的报告作为共享产物而不合入实现。
- Git 接口改为只依赖实际 Git 工作身份（execution/task/node/instance/kind），不需要伪造完整旧 Operation 或插入旧 nodes/operations。集成异常留下本次失败输入及已投递的 submit，不能重发成功提交。
- 新回归使用真实 Pi、HTTP fixture、临时 Git 和磁盘 SQLite：write_file 实际修改自己的 worktree，再 submit；集成文件及 SHA 更新，目标 main 保留原 SHA 和内容，旧 nodes/operations 都是零条。
- 首版夹具误用了未开放的 write 工具，已纠正为 write_file。纠正后的回归在 d1f4eb3 上先证明 worker 文件已改，再因集成文件仍为 before 失败；修复后 3 文件 11 用例通过。
- 这只是集成步骤，不是最终验收或目标分支交付：精确 commit 检查、独立模型历史、human acceptance、formal scope/config、Git 恢复仍需接线。特别需要补齐提交前发布代码稳定 commit 的宿主能力，不能依赖执行结束后自动提交来证明提前投递的代码版本。

## 提交前的稳定代码发布

- 第十一轮完整门禁通过：273 文件、1805 用例，198.22 秒；证据未改写；native Git 集成提交为 1ff39c6。
- Git 工作副本已准备的 worker 获得 workspace_commit，使用可信执行身份并在 Git 排他边界内提交指定路径；拒绝工作副本外路径，不交付目标分支。reviewer 不开放该工具。
- artifact_publish 传递 metadata，kind:code 文件也必须与记录的 commit 字节一致；不再只按代码扩展名校验。已发布内容不随工作副本后续修改变化。
- 真实 Pi/Git/SQLite 回归在旧实现上因缺少稳定 commit 元数据失败；修复后进一步验证提交前发布被拒绝、越界提交被拒绝、稳定版本可发布、后续聊天改动保留原发布内容。4 文件 20 用例定向通过。
- 最终验收、目标分支交付、原生模型历史与正式默认入口切换尚未完成；本节不代表完整 spec 验收。


## 实际模型连接与调用历史

- 第十二轮完整门禁通过：273 文件、1805 用例，192.47 秒；证据未改写；稳定代码发布提交为 6eeb48b。
- resident host 使用本次配置准备的完整模型连接快照，不再按上游模型名重新查找连接；相同上游模型名的另一连接不能截获请求。
- 每次 provider dispatch 保存连接 ID、上游身份、provider/API/endpoint 的不可变快照；旧记录没有该信息时保留未知。
- provider_calls 检查接口提供实际调用 ID、执行、状态、预留与用量；main 可以据此处理未知用量。节点详情展示真实 invocation 与实际 modelsUsed，不再用最新绑定冒充历史。
- 真实 Pi/HTTP 回归修复前请求进入错误连接；修复后正确连接收到请求，错误连接零请求。检查接口回归修复前返回 summary 而非两条调用，修复后显示两条实际调用及 authoritative 用量。3 文件 30 用例定向通过，TypeScript 检查通过。
- 最终独立审查模型排除、预算/时间完整统计、最终 commit 验收与默认入口切换仍需继续。


## 独立模型与提交后的未知用量

- 第十三轮完整门禁通过：273 文件、1805 用例，191.75 秒；证据未改写；实际模型连接与调用历史提交为 cf4c838。
- review 配方按冻结的实现执行身份排除连接 ID 和上游模型身份，追溯模块、返工环及已接受投递；当前目录修改、连接禁用、别名连接不能抹掉历史。缺失身份或没有候选时暂停自己的队列，保留输入，不耗费自动重试。
- 提交后异常和正常结束但用量未知，都保留成功 submit、失败原输入及未知用量占位；恢复队列不再重发原任务。提交前的有限重试与补交次数不变。
- 决策回归修复前选择 implementation 而非 independent。真实 Pi/HTTP/SQLite 回归修复前独立 reviewer 收到零请求；修复后选择独立模型，热改目录不改变历史，移除候选只暂停 reviewer，worker 继续。
- 两个恢复回归修复前分别错误耗尽重试，以及将已提交原输入留成 blocked 可执行项；修复后缺模型为 blocked，提交后未知用量为 failed，保留占位、零重放。正常结束未知用量也纳入同一主测试。
- 4 文件 21 用例定向通过，另一个真实 Pi 用例通过；TypeScript 通过。正式完整门禁仍需执行。
- 完整 spec 尚未完成：最终版本证据/Git 交付、默认用户入口切换与旧内核退役、节点局部配置/真实预算与时间视图、稳定增量布局等仍需继续。


## 运行中的局部修改

- 第十四轮完整门禁通过：274 文件、1810 用例，166.23 秒；证据未改写；独立审查/禁止重放提交为 06cb4d3。
- graph_patch 接受完整 definition 或局部 JSON merge patch，二者只能选一；对象合并、数组替换、null 删除，结果仍由唯一正式定义验证。版本冲突、无效协议、待处理工作删除都在发布 revision 前拒绝。
- main 管理边界回归修复前因缺少完整 definition 失败；修复后只修改 task/edge.enabled，保留具名接口、实例和已接受队列；陈旧/无效/待处理删除零写入，显式取消后可移除节点及其边，旧 revision 不变。
- 2 文件 29 用例定向通过，TypeScript 通过；随后追加的歧义及非对象输入拒绝检查纳入完整门禁。
- 最终验收/Git 交付、正式默认入口/旧内核退役、节点局部模型预算重试配置及统计、复杂图增量布局仍未完成。
