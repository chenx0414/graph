# Issue #1 接手实施状态

> 历史实施与验收记录：保留当时的实现和证据，不代表当前进程模型或任务状态。当前 Go + durable 基线见 [2026-10-20 整合说明](../planning/baseline-cleanup-2026-10-20.md)与 [ADR 0032](../adr/0032-go-backend-shared-durable-host.md)。

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


## 声明式模型、重试与恢复配置

- 第十五轮完整门禁通过：274 文件、1811 用例，167.13 秒；证据未改写；局部修改提交为 8863ada。
- 节点正式 JSON 支持 model 配置连接 ID、retry.automatic/retry.resubmit 非负整数；字段省略使用已确认默认值。指定模型仍先接受独立性排除，不可用时只从其余已配置候选替代。
- 重试限额从本次 execution revision 冻结；执行中 patch 不改变当前 allowance，新执行使用新值。恢复会话也使用执行已保存的 revision，避免记录旧配置、运行新配置。
- 配置回归修复前指定 preferred 仍选 independent，异常上限 1 仍跑 3 次、补交上限 0 仍补交，非法声明也被接受；修复后均按正式配置执行。
- 磁盘恢复回归修复前 host 准备 revision 2，修复后保留 revision 1，尝试计数不退还。5 文件 40 用例定向通过，TypeScript 通过；追加的指定 alias 不绕过独立性验证纳入完整门禁。
- 节点预算/工作位置与权限局部配置、最终版本证据/Git 交付、默认入口与旧内核退役、真实统计及增量布局仍未完成。


## 执行预算快照与真实额度视图

- 第十六轮完整门禁通过：274 文件、1819 用例，172.22 秒；证据未改写；模型/重试配置提交为 e95a13e。
- execution 保存实际 token budget；恢复沿用原额度，provider gate 优先使用执行快照，不能被重新准备的更高额度绕过。没有历史额度记录的旧执行保持未知。
- 轮次预留与执行预留记录同事务更新；提交后失败且用量未知时保留占位，显式用量对账后同步清理。节点视图读取实际总占位与各执行占位，请求占位单独显示，避免双重相加。
- 等待标记读取实际 waiting_slot；尚未统计的等待/运行分项保留 null，墙钟经过时间另作 elapsedMs。尚无预算记录显示“预算尚无记录”，明确 unlimited 才显示额度不限。
- 显示回归修复前为 budget:null、无 reserved 字段；provider 回归修复前允许超过原执行额度的请求。修复后两类已提交失败场景均显示 1000 额度、100 轮次占位及独立的 50 请求占位，并拒绝 1100 请求；磁盘恢复保留 1000 而非新宿主 10000。
- 2 文件、19 用例定向通过，TypeScript 通过；完整门禁待执行。节点预算声明/动态默认预算、完整时间和费用统计、最终验收与默认入口切换仍需继续，不代表完整 spec 已完成。


## 宿主检查的精确版本记录

- 第十七轮完整门禁通过：274 文件、1819 用例，168.75 秒；证据未改写；预算快照与真实额度视图提交为 6a6306e。
- workspace.command 在实际派发前和运行结束后读取 HEAD 与 Git 清洁状态；仅退出码为零且两端工作树干净、HEAD 相同，生成 verifiedCommit。普通 passed 仍表示命令退出码，不能冒充精确版本验收。
- record 持久保存 commitAfter/cleanBefore/cleanAfter/verifiedCommit，投递和操作账本保存对应版本结论。原先已保存但缺少这些字段的结果不补造证明，不重跑有副作用的命令。
- 原生宿主检查与 Git integrate/workspace_commit 共用 graph 的排他边界，检查期间不允许受管理的集成变更；独立节点可以继续运行自己的非 Git 工作。
- 四种真实 Git/命令回归修复前没有 verifiedCommit；修复后只有干净且版本不变的成功检查取得证明，已有脏改动、运行后脏改动、HEAD 改变均为 null。追加失败命令同样不得取得证明。
- 这只是最终验收的证据基础；最终检查/审查/人类确认与 Git 交付仍未接通，默认入口切换与旧内核退役仍未完成。


## 声明式默认配置、预算授权与继承

- 第十八轮完整门禁通过：274 文件、1824 用例，170.95 秒；证据未改写；宿主精确版本记录提交为 56be7d6。
- graph.defaults 与节点共享 model/retry/budget 配置；节点覆盖 graph 默认，重试字段逐项继承。子 graph 自己的默认值展开到内部节点，独立实例不会丢失模板配置。
- 新执行读取当前用户默认额度，保存有效额度；main 声明可降低节点额度，不能超过用户有限授权或转为无限。拒绝授权时保留输入、暂停本节点，零模型调用、零自动重试；不能把拒绝的申请保存成已生效的预算。
- 有历史预算的恢复执行沿用快照；没有记录的恢复执行明确暂停，不能按无限运行。main 显式 retry 后的新执行使用当前配置，累计用量与会话不清零。
- 原生 provider gate 使用实际执行额度，声明额度与实际 send 走同一账本。graph 默认模型仍受独立审查身份排除，指定连接不能绕过历史。
- 回归已实测：旧实现忽略 graph/node 额度、允许越过用户上限；旧展开器将模板 100 万变为顶层 200 万；graph 重试默认忽略后多跑一次；缺少原预算的恢复错误地继续执行。各回归修复后通过。5 文件、64 用例定向通过，TypeScript 通过；后加的页面额度显示检查待纳入完整门禁。
- 最终检查/审查/人类确认与 Git 交付、默认入口切换/旧内核退役、节点工作位置与权限配置、完整时间与费用统计、复杂图增量布局仍未完成。


## 终态管理控制与暂停后的停止

- 第十九轮完整门禁通过：274 文件、1842 用例，167.77 秒；证据未改写；声明式预算与默认配置提交为 7336ee9。
- 已完成、停止中、已停止的 graph 拒绝 pause/resume/reopen/retry/skip/cancel 队列控制，不能修改已结束的执行状态、重开 latch 或复活输入。用量对账及未知宿主操作的历史处置仍通过其各自入口处理。
- GraphRuntime 读取真实暂停标记，活动 graph 暂停后显示 paused；完成请求标记继续保留，外部输入关闭规则不变。
- stop 在同一次更新中设置 stopping 并清除 graph 暂停标记，防止暂停中的 graph 无法进入取消与停稳流程。
- 管理边界回归修复前终态控制返回成功；修复后两个终态的所有控制均拒绝，队列 generation、模块 latch 和暂停标记未变。暂停后的停止回归修复前仍保留 paused=1，修复后清为 0 并正常停稳。
- 3 文件、38 用例定向通过；完整门禁待执行。最终验收/Git 交付、默认产品入口与旧内核退役仍需继续。


## 可操作的失败队列与执行检查

- 第二十轮完整门禁通过：274 文件、1842 用例，168.73 秒；证据未改写；终态控制与暂停停止提交为 07b7648。
- graph_inspect 增加 queue/executions 分页，支持节点过滤、原输入、失败原因、generation、冻结配置及尝试/补交/提交身份。main 可以读取真实 seq 后选择处理动作，不再只能获取 summary。
- 默认 100 条、最多 200 条；按队列受理顺序及执行持久顺序使用 after/next。未知 query、非法 cursor/limit 明确拒绝，不静默返回无关摘要。
- 在提交后失败的两种真实执行结果上，修复前 queue 查询没有 items；修复后读取实际失败输入及有效 submit、预算快照，分页保留原顺序并排除其他节点输入。原输入不重新执行，检查本身不解除失败或清空用量占位。
- 2 文件、44 用例定向通过，TypeScript 通过；完整门禁待执行。原生最终验收/Git 交付、默认入口与旧内核退役仍未完成。

## 停止后的完成请求与明确取消

- 第二十一轮完整门禁通过：274 文件、1842 用例，168.74 秒；可操作队列检查提交为 93788d0。
- 停止保留 stopped 终态，即使之前存在完成请求也不能被 settleCompletion 改成 completed。停止取消的排队输入记为 done，并保存 cancelled by stop 原因，区别于执行失败。
- 调度器在停止前取得的可运行句柄，延迟运行时重新读取实际状态，不再尝试完成已停止 graph；没有启动 host 或复活输入。
- 两类运行时回归与真实 lane 延迟调度回归均在修复前实测失败；修复后 4 文件、45 用例定向通过。完整门禁待执行。
- 原生最终验收/Git 交付、默认入口切换与旧内核退役仍未完成，不能将当前测试通过等同于完整 spec 交付。

## 原生图的人类问题与完成门

- 第二十二轮完整门禁通过：274 文件、1843 用例，167.31 秒；停止终态与明确取消提交为 6242461。
- 即使队列已经清空，只要 graph 存在 open question，完成请求保持 blocked；main 的人类验收预审不解除用户问题，外部输入仍关闭。
- 用户接受或拒绝原生图的人类验收，复用实际问题、回答、等待与通知记录，不再读取不存在的旧节点 spec，也不创建伪造的旧节点/激活记录。拒绝产生返工问题；最后一个问题解决后，保留的完成请求重新进入 completing，由 lane 继续检查。
- 两个回答分支在修复前实测：完成门越过问题；接受回答因 undefined.spec 回滚。修复后 4 文件、55 用例通过；TypeScript 通过。初次 sibling 检查暴露纯 TaskStore 尚无 kernel 表，已守住 schema 存在边界后复验通过。
- 精确版本的检查/独立审查与 Git 交付门、正式默认入口和旧内核退役仍未完成。

## 原生最终证据与精确 Git 交付

- 第二十三轮完整门禁通过：274 文件、1845 用例，166.42 秒；原生人类问题与完成门提交为 3a7b24b。
- 正式定义增加顶层 check/review/human 验收项；普通 patch 不得改变已声明的最终标准。已有确认需求必须保持对应标准与需求版本，不能把程序检查改成人类回答来替代。
- 检查读取实际模块操作账本和 verifiedCommit，配置变更及旧版本记录显示 stale；审查读取完成执行发布的 graph.review@1 字节并验证 digest，而非 metadata、信任标签或路由通过状态。
- 实际 provider send 同时冻结配方身份与 review 角色；最终审查检查真实发送历史、模型独立性与报告 commit。历史缺失保持未知，不补造记录。
- 其他证据齐备后才创建绑定版本的人类验收问题。Git 交付位于 graph 排他边界，检查实际 HEAD 和清洁状态，成功才保存原生交付 receipt 并完成 graph；目标脏、集成偏移保留完成意图和处置通知。
- 删除旧执行器按原生节点成功状态自动完成的旁路；常驻 lane 根据显式完成意图处理证据与交付。
- 修前真实 Pi/Git 回归把无证据图标为 completed；修前局部 patch 能删除验收项；移除新的 Git 保护后，真实未经验证的 HEAD 被送入目标分支。各问题已复现，不以仅测试绿色作为证据。
- 真实公开工具流程验证宿主检查、两个独立 reviewer 会话轮次的不可变报告、旧版本 stale、实际字节阅读、用户确认、脏目标工作区、未验证 HEAD、脏集成工作区及最终精确交付；7 文件、72 用例定向通过，TypeScript 通过。最后的已确认标准匹配收紧待完整门禁验证。
- 默认产品入口切换/旧内核退役、工作位置与权限配置、恢复剩余工作、全局宿主名额、完整统计与复杂图增量布局仍未完成。

- 第二十四轮完整门禁未通过：275 文件、1854 用例中 13 个失败。新加构造函数参数属性不受 daemon 的原生 Node strip-only loader 支持，导致加载、启动和恢复级联失败；已改为普通显式字段，并修复 exactOptionalPropertyTypes 的 undefined 赋值类型。
- 旧 v2-completion 的 C2 只凭节点成功声称验收完成，已改为通过公开 task/control/inspect 验证确认的标准缺少证据时 blocked；C3 原先仅断言“不完成”，会被缺少验收声明的另一道门掩盖，现检查公开视图保留真正的 failed 节点状态。实际可完成的正例由新的真实 Pi/检查/用户/Git 交付流程负责，未恢复旧状态冒充证据的旁路。
- 失败的加载、启动、跨进程恢复、验收 harness、实际 daemon 流程已定向复验通过；后续 3 文件 6 用例通过。第二十五轮完整门禁待执行。

- 第二十五轮完整门禁通过：275 文件、1854 用例，168.44 秒；证据文件未改写。最终版本验收与原生 Git 交付这批改动已通过实际 daemon 加载、跨进程恢复及全量检查，但不代表整个 spec 已完成。

## 声明式文件的类型与验收衔接

- 最终版本验收与 Git 交付已提交为 7d64e79；第二十五轮完整门禁通过，275 文件、1854 用例。
- deliverable 可声明 schema，创建时校验 kind@version；自动发布沿用冻结执行声明。内容相同但 schema 改变会发布新稳定版本，不能把无类型旧版本冒充审查报告。旧版本保留，内容和 schema 都相同时仍复用版本。
- 回归修复前实际返回 published:false/version:1；修复后新类型报告发布 version:2。首次 briefing 展示交付声明，下一次执行的配置更新保留该声明。
- 现有真实 Pi/Git 验收流程的第二次审查改为实际 write_file 加声明式自动发布，不手动调用 artifact_publish；新版报告通过精确提交验收与 Git 交付。4 文件、48 用例定向通过；完整门禁待执行。
- 默认入口与旧内核退役等剩余工作继续，未宣称完整 spec 交付。

- 第二十六轮完整门禁通过：275 文件、1855 用例，168.63 秒；验收证据未改写。

## 确认只建立图，显式投递启动

- 声明式交付已提交为 7d56f7c，第二十六轮完整门禁通过。
- 删除 materializeGraph 根据入边推断 roots、循环图任意选首节点和 kind:start 空对象入队。确认只建立结构；main 初次启动也遵守具名输入协议与串行队列。
- 链式、无边、循环三个回归在修复前均收到擅自加入的 start；修复后无隐式任务，无效输入拒绝、合法输入仅激活指定节点。原生任务状态用例改为显式投递，未把节点 idle 冒充执行成功。
- 原生确认后的 main 通知在修复前缺失；Git 准备后通过既有持久 wake 发送 graph_ready，提示读取定义与 graph_send；重复确认不重复唤醒。界面确认文字改为等待 main 投递输入。
- 第一批 8 文件、107 用例通过；通知补齐后 4 文件、66 用例通过，TypeScript 通过。完整门禁待执行；默认入口全面切换和旧内核退役尚未完成。

- 第二十七轮完整门禁未通过：275 文件、1855 用例中 4 个失败。剩余四个测试依赖确认时隐式 start，已保留真实进程、脚本桥、字段适配及预算阻塞断言，改为由公开 graph_send 投递合法输入；真实链的边事实读取只选择 a→b，区分新加入的直接启动投递。修正后 4 文件、5 用例定向通过，等待第二十八轮完整门禁。

- 第二十八轮完整门禁通过：275 文件、1855 用例，175.52 秒；基线与验收证据保持一致。

## 停止后拒绝新输出，保留已提交历史

- 显式启动与确认通知已提交为 348a4ef；第二十八轮完整门禁通过，275 文件、1855 用例。
- 两个竞态回归在修复前实际成功：运行中的 agent 在 stop 后首次 submit、模块在 stop 后新广播，均继续投递并重新排队下游。
- 持久化输出事务读取实际 graph phase，在 stopping/stopped/completed 拒绝新输出；成功 submit 的幂等重放先读取原 receipt，不撤回已承诺的输出。已路由的模块 outbox 保持幂等；completing 内部投递继续允许。
- 修复后 5 文件、75 用例通过；迟到输入不产生新投递、原提交版本和取消队列保留，运行执行结束后正常停稳。完整门禁待执行。

- 第二十九轮完整门禁通过：275 文件、1857 用例，174.78 秒；验收证据未改写。

## 按字面身份识别已提交的队列代次

- 停止后的输出保护已提交为 630f021；第二十九轮完整门禁通过。
- main 的 retry 原先使用 GLOB 拼接节点 ID。方括号节点第二代执行提交后失败，旧实现把 ID 当模式，漏掉成功提交并允许再次投递。回归已实测，其余普通、星号、问号 ID 的对照分支保留。
- 改为原始 execution ID 和字面代次前缀匹配，按 graph/node 共同限定；不将节点名解释为模式。未提交的显式 retry 正常增加代次；任一代次成功提交后保持 failed 输入，由 main 处理剩余工作，不增加新代次、不再发送原输入。
- 3 文件、60 用例定向通过；完整门禁待执行。默认入口与旧内核退役等总体范围继续。

- 第三十轮完整门禁通过：275 文件、1861 用例，175.22 秒；验收证据未改写。

## 宿主操作共用全局程序名额

- 字面执行代次匹配已提交为 871243b；第三十轮完整门禁通过，275 文件、1861 用例。
- 生产 host 并行推进多个原生 graph；五个真实命令在修复前同时进入 dispatched，超过全局程序上限四个。首次回归夹具误用标准权限且声明 sandbox:false，实际未执行；已补显式 full 授权，重新实测五次派发，不把权限拒绝当名额证据。
- 新增持久资源占位，native/旧执行共用 occupiedSlots；等待留在 prepared，在短事务内取得名额后才派发。等待时遵守 graph/module 暂停、终态与关闭信号；实际 runner 关闭后 finally 释放。
- 真实公开 graph_create/send/host.drive 验证四个活跃、第五个等待，释放后第五个启动；追加第六个等待命令后 stop，未启动、未遗留占位，已有五个命令正常结算。
- 恢复只释放 prepared 未派发占位；不确定的已派发占位保留，cancel_operation 拒绝仍持有资源的操作。operations 视图展示实际占位，不能把它解释为操作成功或 PID 存活。
- 4 文件、69 用例及 TypeScript 通过；等待取消扩展单例通过。完整门禁待执行。硬崩溃后的真实进程身份核查/终止证明尚未接通，继续实施，未宣称恢复或完整 spec 交付。

- 第三十一轮完整门禁通过：275 文件、1862 用例，172.96 秒；验收证据未改写。

## 宿主命令的独立生命周期监督

- 全局程序名额已提交为 0e06ea5；第三十一轮完整门禁通过。
- 生产 runHostCommand 回归实测：父进程 SIGKILL 后命令仍存活五秒，正常 abort 对照通过。原因是清理仅由父进程回调执行，硬退出后回调消失，并非进程组终止失效或退出延迟。
- 命令改由独立监督进程拥有；先监听 IPC 断开再接受启动，父进程死亡、明确取消和超时均清理命令组。命令环境仍由既有 allowlist 构建，通过私有 IPC 传递；监督进程不继承 provider 环境。实际退出码和输出仍来自命令，父进程继续限制记录大小，不将监督进程退出码冒充检查结果。
- 修复后的三个真实进程生命周期分支通过；超时记录保留终止原因。4 文件、24 用例的命令、最终验收、环境/沙箱集成通过，TypeScript 通过；完整门禁待执行。
- 这只修复父进程硬退出时的命令清理。崩溃后的持久资源占位仍需实际进程身份与终止证据核查；操作结果保持未知，不能自动重跑或冒充成功。默认入口切换与旧内核退役等完整 spec 工作仍未完成。

- 第三十二轮完整门禁通过：276 文件、1865 用例，173.35 秒；验收证据未改写。独立命令监督已通过真实生命周期及全量验证，不代表持久资源恢复或整个 spec 已完成。

## 崩溃后核验命令资源，保持未知结果

- 独立命令监督已提交为 3167840，第三十二轮完整门禁通过。
- 跨原生 Node 进程回归在修复前实测：宿主 SIGKILL 后命令已清理，恢复把操作记为 uncertain，但 worker_active 永久为 1，main 也无法取消。
- 监督进程先准备并回复 ready；宿主在实际 start 前记录派发。清理凭证路径与一次性 nonce 先保存到操作账本；监督进程只在命令关闭后写凭证。正常退出同样清理后台进程组，监督进程自身异常退出而没有凭证时继续保留占位。
- 恢复或 main 明确取消时核对凭证，仅释放 worker_active 并记资源释放事件，不改变 uncertain/result、不重放命令。资源释放与审计事件同事务；重新准备操作清除旧凭证声明，避免旧凭证证明新一次执行。读取拒绝符号链接、过大文件、缺失/损坏内容、错误 nonce 和非 quiescent 状态。
- 真实跨进程回归验证 SIGKILL、命令关闭、资源释放、模块暂停、明确取消和零下游结果；实际监督进程写出的凭证被删除/损坏/换为其他操作 nonce/设为未清理时，main 均拒绝释放。5 文件、49 用例及 TypeScript 通过；凭证保护扩展单例通过。完整门禁待执行。
- 此证据接通 sandbox:false 的宿主操作。受限执行器和 Pi 常驻进程的宿主死亡清理仍需分别验证和接通，不能将这份命令凭证套用到它们；默认入口切换/旧内核退役等完整 spec 工作继续。

- 第三十三轮完整门禁通过：276 文件、1866 用例，183.34 秒；验收证据未改写。复核后将每次准备的凭证文件名也按新 nonce 区分，避免同一操作的旧文件阻止新凭证写入；后续完整门禁重新验证最终实现。

## 常驻 Pi 的宿主断连清理

- 真实 resident-worker-entry 在 stdin EOF 后，空闲、等待宿主 model_result、等待宿主 tool_result 三种状态都悬挂五秒。未完成调用不是唯一原因：空闲对照同样失败，读取循环结束后缺少会话/通道及待回答请求的清理。
- 控制流结束时拒绝所有待回答模型请求、返回工具断连错误、停止接收新的宿主请求，并中断当前 Pi turn；等待 turn 收束、关闭会话与通道，再退出进程。控制通道错误也进入同一清理路径。正常 close 的排空语义保留，断连与正常关闭分别判断，避免丢掉仍在排空的结果。
- 三个分支实测由红转绿，且断连后没有新增 provider 请求；7 文件、56 用例验证 resident 跨轮会话、真实工具桥接、模型传输、命令生命周期、未知资源和最终 Git 验收，TypeScript 通过。第三十四轮完整门禁待执行。
- 此回归证明已启动 Pi 的控制 EOF 清理，尚未证明任意 extension 进程树或受限执行器的崩溃资源凭证。旧内核退役、默认入口切换、节点工作位置配置、完整统计与布局等仍未完成。

- 第三十四轮完整门禁通过：276 文件、1869 用例，174.19 秒；验收证据未改写。每次准备的独立凭证文件和 Pi 控制 EOF 清理均在最终全量实现中验证。接下来处理默认入口切换与旧内核退役，不将当前绿色门禁视为完整 spec 验收。

## 默认切换诊断与原生宿主检查迁移

- 临时拒绝不含 schemaVersion:2 definition 的旧 proposal 后，全量诊断为 76 文件、260 用例失败；200 文件、1609 用例通过。诊断后已恢复入口。失败说明这些调用仍依赖旧入口，不足以证明原生能力缺失，也不是默认切换已经完成的证据。
- 手动将 program-check-sandbox、timeout、host-git、record 四个文件迁移到实际 graph_create/send/host.drive 操作模块。共享夹具不提供检查结果或记录凭证；需要 main 通知的测试使用真实外部 main 会话。保留权限拒绝、环境过滤、超时、平台 Git 和实际失败日志合同，移除旧 DAG/program 节点夹具。
- 原生路径实测 full 权限下的默认沙箱检查继承宿主 TMPDIR；现将默认检查临时目录固定为该操作的独立 scratch，显式 sandbox:false 仍使用宿主环境。另实测实际日志存在但操作元数据缺少指纹；结算时保存实际写入字节的 SHA-256，并通过 operations 查询公开。旧记录没有指纹时保持 null，不编造证明；业务输出协议不变。
- 6 文件、29 用例和 TypeScript 通过，包括原生操作及最终验收兄弟合同。日志指纹是审计元数据，不代表最终验收已实现日志防篡改门禁。第三十五轮完整门禁待执行；默认入口、旧内核退役继续实施。

- 第三十五轮完整门禁通过：276 文件、1870 用例，171.34 秒；验收证据未改写。原生宿主检查迁移及记录指纹均在最终全量实现中验证。

## 原生草稿与运行图共用结构投影

- 宿主检查迁移已提交为 a21b61b，第三十五轮完整门禁通过。
- 实际确认流程的 HTTP 回归在修复前返回空 nodes：draft-graph 只读旧 proposal.nodes，忽略有效 definition。初次夹具漏会话 cookie，得到 401；补正式会话后重新实测空数组，不将鉴权失败视为产品回归。
- 原生草稿与运行图共用节点、模块、连接及布局缓存投影。草稿解析正式定义，公开具名端点/协议，投递历史为空；运行态叠加实际节点状态与持久投递，状态变化不改变布局 key。旧草稿入口暂时保留，未宣称默认切换已完成。
- 草稿 Web 从实际返回结构统计 agent/模块；模块标注为功能模块，节点详情显示具名输入/输出，边详情接通原生接口。实际 HTTP 确认前后核对同一结构与相同布局；真实 Chromium 核对节点数量、模块、接口和未投递边。浏览器首次仅预期文案写错，实际显示“尚无投递”；已改正确文案，不算额外产品缺陷。
- 3 文件、17 用例及 TypeScript 通过。第三十六轮完整门禁待执行；main 构建语法、默认旧入口关闭、旧内核退役继续实施。

- 第三十六轮完整门禁通过：276 文件、1871 用例，175.82 秒；验收证据未改写。原生草稿的实际 HTTP、Chromium 与确认后同布局合同均通过最终全量验证。

## main 原生构建语法与配方合同迁移

- 原生草稿预览已提交为 82c5a6c，第三十六轮完整门禁通过。
- 将两个真实 Pi main 提案/HTTP 用例改为直接发送结构化原生定义，无旧 nodes 数组、无提升器；main 不在图内，命令声明为操作模块。首次提案后再次用户输入实际触发 TypeError：外部 main 的旧交接判断构造 GraphPlan 并读取不存在的 nodes.map。现外部 main 跳过旧图交接与输出协议计算；原生 follow-up、HTTP 提案及实际 provider 工具说明均通过。
- propose_graph 工具说明改用 schemaVersion:2、具名对象/接口/连接与文档入口；confirm_draft 明确确认只创建结构，等待显式 graph_send。bootstrap main 身份说明位于图外、会话跨 graph 完成保留，并说明原生创建/修改/观察/完成流程。旧兼容入口仍未关闭。
- 内置配方 prompt 注入合同也迁移到实际原生 graph_create/send 的常驻 worker，删除该夹具中的假检查 evidence。实际模型请求包含内置 worker 身份、会话记录包含回复；不依赖旧 DAG 结算。首次迁移误把已完成节点状态预期为 idle，实际为 succeeded；已按实际节点合同修正，不算产品缺陷。bootstrap 身份前缀断言更新为已确认的长期 main 身份，删除同一前缀的重复 contains 断言。
- 3 文件、22 用例及 TypeScript 通过。第三十七轮完整门禁待执行。生产预算/审查等剩余旧入口用例继续迁移；未宣称默认切换或整个 spec 完成。

- 第三十七轮完整门禁通过：276 文件、1871 用例，174.31 秒；验收证据未改写。main 原生 JSON 提案及后续消息、内置配方的实际原生 prompt 注入均通过最终全量验证。

## 原生生产预算合同与 agent 节点边界

- main 原生构建语法已提交为 4a789ab，第三十七轮完整门禁通过。
- 手动将生产测试的正常支出、未知用量、超预算三条合同迁移到真实 graph_create/send/常驻 Pi，删除对应旧 program 检查及假 evidence 夹具。模型两次实际调用累计 120010 tokens、正常写文件并完成；未知调用保留 usage:null 和 reserved，已排队的新聊天不导致第二次 provider 请求；超预算实际计费 20000001，后续聊天同样不能发送。正向记录类型检查初次误用兼容 nodeRun 联合类型中的 state，改为通过原生 graphInspect 读取调用记录，不改变生产 API 来迎合测试。
- 原生 NodeDefinition 原先支持 recipe 或 command，与已确认“节点是 agent、无独立工具节点”冲突。正式解析回归实测 command-only、recipe+空 command、recipe+null command 全部被接受。现 recipe 为必需字段，任何 command 字段均明确拒绝并提示操作模块；删除 scripted 兼容分支里的直接 execFile 路径。宿主命令仍由操作模块执行，沿用已有权限、预算、记录和生命周期监督。
- 5 文件、71 用例及 TypeScript 通过，包括实际命令模块、原生确认、生产模型及内置配方。第三十八轮完整门禁待执行；生产文件中的旧用量豁免、旧 graph.verify prompt、旧图检查概览/隔离写入合同尚未全部迁移，默认入口/旧内核退役继续。

- 第三十八轮完整门禁通过：276 文件、1874 用例，172.71 秒；验收证据未改写。原生节点拒绝 command、实际操作模块与生产预算合同均通过最终全量验证。

## 原生任务与 main 状态投影

- 原生生产预算合同已提交为 6192d0a。真实 worker 两次调用虽已记录在原生账本，任务视图仍返回零调用与金额 0；实际确认后的 main graphState 则尝试加载不存在的旧图并报错。另将原先依赖旧 main 节点及假 ActionAdapter 的视图合同手动迁移到 graph_create/send/patch，实测图版本为 0、修订历史为空。
- 任务视图读取原生修订、调用及节点账本；main 状态读取原生定义、模块、接口和同一任务投影。原生模型调用没有冻结的货币价格凭证时明确返回费用未知，不能解释为免费；会话费用汇总也使用这些实际调用。保留旧路径供尚未迁移的调用，不声称退役完成。
- 真实预算保留用例核对两次调用与未知费用；实际确认核对 main 能读取原生图；新增节点的实际 patch 核对修订 1→2、已有 blocked 状态保留和 main 位于图外。三个问题均有修复前失败记录，4 文件、25 用例及 TypeScript 通过。第三十九轮完整门禁待执行。
- 历史删除审计已标明日期适用范围，避免将旧能力缺失结论当作当前状态。价格凭证、原生完整统计、默认入口关闭和旧内核退役继续实施。

- 第三十九轮完整门禁通过：276 文件、1874 用例，173.39 秒；验收证据未改写。原生任务调用、费用未知、修订及 main 状态读取均通过最终全量验证。

## 真实 main / 浏览器流程迁到原生定义

- 原生任务投影已提交为 c33c215。手动迁移 conversation-pi、conversation-ui 和正式 CLI 启动的 integration 三个实际 provider / Chromium 流程，直接提交原生 JSON，不使用旧节点数组或提升器。确认只创建图；Pi 会话核对 worker 尚无请求，随后显式投递才运行；完整 CLI 流程由 main 接到实际 graph_ready 后调用 graph_send，worker 调用 submit 并经连接触发宿主命令模块。
- 实际 main 请求在迁移后暴露两个摘要遗漏：空闲原生节点显示 nodes:none，已成功执行并计量 16 tokens 的节点仍显示 tokens 0/0。摘要现读取原生节点状态、实际已用与保留 token，不把未读到账本解释为没有节点或免费执行。两项均有真实 provider 请求的修复前失败记录。
- Chromium 原流程确认后立刻点击同一个 chat-send 按钮，而 graph_ready 会唤醒 main，按钮当时实际是暂停功能。迁移夹具改为等待可观察的 data-mode=send，再严格核对回复；不改产品按钮语义、不使用固定等待。原 worker 工具断言也从旧 Pi 工具集合改为实际原生宿主工具，保留读写/命令能力合同。
- 正式 CLI 流程核对只有两个内部 agent，各自实际累计 25 tokens，两条边均保存真正 submit 的 value；实际节点/模块页面、配置更新、会话导航、正常 SIGTERM 退出仍通过。移除这份流程中的旧 proof-only 用量豁免分支，未知用量/保留额度合同由 production 的真实原生 provider 用例独立保护，不将缺失用量记为零。
- 4 文件、50 用例通过；第四十轮完整门禁待执行。propose_graph 的旧传输别名、旧 M7 运行示例和其验收入口仍待迁移，尚未宣称默认切换或整个 spec 已完成。

- 第四十轮完整门禁首次执行：275 文件、1873 用例通过，1 个浏览器用例失败；原生确认唤醒后的按钮仍为 pause，默认 expect.poll 短期限到期。单独流程已通过，保留严格 send 断言，将轮询期限设为该流程既有的 30 秒响应期限；最终全量重跑待执行，不把首次结果记为通过。

- 第四十轮最终完整门禁通过：276 文件、1874 用例，176.21 秒；验收证据未改写。最终实现及 Chromium 的严格状态等待均在全量并行负载中验证。

## 原生 worker 的检查概览、隔离写入与 prompt 窗口

- main / 浏览器流程已提交为 a061171。手动迁移 production 中的检查概览、工作副本写入和 node-prompt-ui 的实际发送展示合同；全部走 graph_create/send，移除对应旧 program 检查及假 artifact digest 夹具。
- 实际 provider 请求暴露原生首轮概览只列节点/模块 ID，既没有具体检查命令，也没有 graph 验收项；两个真实断言在修复前失败。首轮概览现包含节点配方/任务/接口摘要、模块类型/接口及操作配置、连接与公开接口，并单列 graph 验收。节点自身验收及输入协议仍分别说明。后续 turn 的既有差量规则不变。
- Git 写入合同使用真实临时仓库和宿主 write_file，核对成功写入独立 worker worktree，且原项目 feature.txt 不存在；不是只检查模型自述或假检查回执。节点窗口实际显示 worker 角色、折叠/展开 prompt、精确 provider system 字节、实际工具与本节点初始任务/输入，仍保存临时截图。
- 5 文件、33 用例及 TypeScript 通过，含串行初始/复跑 prompt、真实最终验收与独立发布审查。第四十一轮完整门禁待执行。production 仍有旧 graph.verify report schema 和 proof-only 未知用量豁免用例；旧 M7 入口、默认切换及完整旧内核退役继续实施。

- 第四十一轮完整门禁通过：276 文件、1874 用例，173.95 秒；验收证据未改写。原生首轮概览、真实工作副本写入及精确 prompt 窗口均通过最终全量验证。

## main 紧凑状态读取接通原生 graph

- 原生 worker 概览及窗口已提交为 4e89859。继续核对默认推荐的 get_task_status：真实新建/修改后的原生图在旧查询里显示版本 0、空节点；按节点查询报 not_found。无 conversation 的 main 拥有者查询其 graph 也被旧 conversation-only 边界拒绝。三项均有实际公开 API 的修复前失败记录。
- 紧凑查询读取原生修订与节点、实际绑定模型和执行时的配方/任务版本；按节点展开返回当前声明配置供下次执行，避免将旧 NodeSpec.input 当作原生投递。拥有者关系来自实际 kernel_graph_owners；同 conversation 的既有范围继续适用，其他拥有者仍不能读取该图。未改旧 revise 的权限或执行路径。
- 另实测已排队但尚未开始的原生聊天被 waitForNode 提前报告 settled。等待查询现读取 queued/claimed 状态；只有没有待运行工作或明确 blocked/failed 时才返回结束状态。实际零等待期限回归返回 timeout，不伪装已完成。初次扩展配置断言误将完整配置对象按只有 task/recipe 的对象比较，已改为正确的部分匹配；此夹具错误不算产品缺陷。
- 3 文件、48 用例及 TypeScript 通过，包含 native graph owner/非 owner、图修订、blocked/idle、按需配置、排队等待与既有 conversation 版本/越界合同。第四十二轮完整门禁待执行；旧 M7 示例仍依赖特殊 program/graph.verify、旧提交与自动交付，核对其独立合同后再替换，未直接删除或机械提升。

- 第四十二轮完整门禁通过：276 文件、1874 用例，173.26 秒；验收证据未改写。原生紧凑状态、拥有者读取及排队等待合同均通过最终全量验证。

## main 原生提案预检入口

- 紧凑状态读取已提交为 aad00b0。实际 Pi main 在提交正式原生对象给 validate_proposal 时，被旧 proposalJson 参数声明拒绝；有效定义不能进行预检，有真实 provider 工具结果的修复前失败记录。
- 预检改为与 propose_graph 相同的原生 proposal 对象，不再接收旧字符串别名；宿主继续使用正式结构与当前需求版本校验，错误返回 valid:false。未创建草稿、未运行内部 agent；有效预检后实际 propose_graph 与后续用户消息继续通过。旧 propose_graph 别名和旧 M7 示例仍未退役，未宣称默认切换完成。
- 扩展既有真实 main 生产合同，核对空 summary 的无效结果、有效原生结果，以及正式提交前提案版本仍为 0、仅有外部 main。3 文件、31 用例通过。第四十三轮完整门禁待执行。

- 第四十三轮完整门禁通过：276 文件、1874 用例，170.00 秒；验收证据未改写。真实 Pi 原生预检、无草稿副作用、正式提案和后续消息均通过最终全量验证。

## 复杂 graph 首轮概览与按需读取

- 原生提案预检已提交为 a6b2e1e。扩展现有真实 Pi 检查概览合同：60 个长任务与一个无关协议令首轮请求达到 128786 字符，所有无关内容被复制；read_graph 尚不存在。实际 provider 回归在修复前失败。
- 首轮概览限制节点/模块各 20、边 40，缩略其他节点任务与模块命令描述；只注入本节点接口引用的协议，保留自身任务/验收/接口全文。内部 agent 的 read_graph 提供只读具名对象与分页 section，不能管理 graph 或访问其他 graph。
- 实际执行中 patch 验证当前读取冻结 revision 1；再投递的第二次执行最初仍读到 1，原因是宿主能力操作跨 turn 缓存，闭包使用首次装配的 revision。现查询实际运行执行保存的 revision，无需为普通 graph 修改重启常驻进程；第二次读取 revision 2 及新任务。另核对分页 7 项、nextAfter 与总数。
- 初次定向验证误把原生宿主工具内容包装当作 main 工具的平铺 JSON，随后分页预期误按创建顺序而非持久定义顺序；已修正夹具，未改变生产序列化或顺序规则来适配测试。
- 最终定向验证通过：5 文件、30 用例，19.43 秒；TypeScript 与 diff 检查通过。首轮大小断言只证明本夹具避免全图复制，未宣称本节点自身超大任务/协议或工具全文结果都有硬字节上限。
- 第四十四轮完整门禁通过：276 文件、1874 用例，170.83 秒；验收证据未改写。复杂图的真实 provider 概览、按需/分页查询、同执行冻结与下次 revision 更新均通过最终全量验证。默认切换、旧 M7 示例及旧内核退役继续实施，尚未完成整个 spec。
- 提交后复核发现进度文档被本轮编辑误覆盖为 graph-v2 管理文档；恢复上一提交完整历史并保留本节。代码未改动；文档修复后重新执行提交门禁。

- 第四十五轮完整门禁通过：276 文件、1874 用例；验收证据未改写。历史进度文档恢复后的最终提交门禁通过。

## 原生 M7 验收入口与 main 工具语法收口

- 复杂图按需读取已提交为 e5695ae。本轮手动迁移 examples/m7-acceptance.ts：长期 conversation / 外部 main / 独立确认 graph 分开保存；version-2 run.json 通过 SQLite 确认 receipt 恢复，旧记录明确拒绝，不建立转换器。确认仅创建结构，main 负责合法输入与完成请求。退役旧 program 环境配置与 proof-only 未知用量豁免。
- CLI 真实跨进程验证覆盖：错版本确认不启动、确认后只有一个 graph、运行记录丢失仍恢复同一身份、真实 Pi 写 worker 文件与 Git 集成、宿主命令检查、独立 reviewer 发布实际 commit 报告、第二次修改后拒绝旧人工问题、当前 commit 用户确认后交付、完成后重跑无模型请求、旧记录明确拒绝。没有伪造产物 digest 或检查证据。
- 实测新 commit 的完成请求被旧开放 human_check 阻塞，永远无法形成新问题。settleCompletion 现将旧问题系统标记为 superseded 并保留事件，不记为用户批准，随后按新 commit 的实际证据产生独立问题。修复前 CLI 回归失败，修复后通过。
- 超额确认测试的第三次 provider 请求实际是首次运行生成聊天输入建议，不是重复规划或压缩。移除错误的上下文窗口猜测；确认后断言请求数未增长、草稿仍为同一版本且尚未接受。
- propose_graph 与 validate_proposal 共用结构化原生参数声明及宿主校验，关闭 proposalJson；旧别名的真实 Pi 调用在修复前创建草稿，修复后不产生草稿。移除无生产调用的旧 revise_graph 工具，运行中使用 graph_patch；SDK 旧修订及旧内核尚未退役，不宣称默认切换完成。
- 另外实测 M7 请求把模型写死为 DeepSeek，未采用实际配置；修复前真实 provider 请求断言失败。需求说明现使用用户配置的实现/审查模型 ID；运行记录仍绑定这份精确需求，变更后不能误续跑旧要求。
- 定向 M7 / production / 最终 Git 验收 3 文件、14 用例，扩展工具/会话/生命周期 6 文件、63 用例及 TypeScript 通过。模型说明修复后第四十六轮完整门禁待执行。

- 第四十六轮完整门禁通过：276 文件、1874 用例，170.41 秒；TypeScript、lint 与验收证据检查通过。整个 spec、SDK 切换与旧内核退役仍未完成。

## M7 真实应用 production 交付合同改用原生内核

- 原生 CLI 与 main 工具语法已提交为 0480a8d。继续手动迁移 tests/m7/production.test.ts，使用独立 conversation / main 与确认 graph、具名输入、宿主 workspace.command 模块和原生完成请求。未使用提升器，也未新建兼容执行路径。
- 真实 Pi 通过 write_file 将 B站 Web 三个文件写入独立 worktree；宿主实际执行 Node Web API 测试。独立 reader 实际读取这些文件并发布绑定当前 commit 的 graph.review@1 文件，验收核对四项检查、独立审查与用户确认；确认后交付目标 main，来源仓库 HEAD 与工作树保持原样。删除本用例的假 passingReviewAction / program ActionAdapter 回执。
- 迁移初次保留旧 write 工具名，真实工具结果为 Tool write not found，宿主检查明确报找不到测试文件，验收不通过。修正为实际 write_file 后通过。Web 检查需要本机监听与 CLI 子进程，因此测试明确配置 full access 和 sandbox:false；中途权限回调误传对象已修正，不算产品缺陷。
- SDK 的 Proposal 类型仍要求旧 nodes，暂以类型断言传入真实原生对象；未给它添加空旧节点或转换定义。该类型及旧 SDK 执行入口仍需在整体退役阶段清理。M7 delivery / freeze / adapters 的旧合同仍待手动迁移，未声称整个 M7 或默认切换完成。
- 此原生应用用例与 TypeScript 已通过；第四十七轮完整门禁待执行。

- 第四十七轮完整门禁通过：276 文件、1874 用例，172.78 秒；TypeScript、lint 与验收证据检查通过。原生应用交付与来源仓库保护通过最终验证。

## M7 原生需求冻结与旧修订 SDK 边界

- 原生应用交付已提交为 c5ad50b。继续手动迁移 freeze.test.ts：讨论留在外部 main 的 conversation，草稿声明具名 agent / 操作模块 / 一次汇合与公开入口，四项应用检查、独立审查和 human-login 全部在原生定义中冻结。确认生成独立 graph，只有内部 agent，所有节点 idle，队列为空；不通过旧 master 依赖推断启动工作。
- 迁移保留独立 profile、禁止并发采集、不共享日常 Chrome、实际 reviewer 配方与目标 main 的既有合同；新的 main 会话 phase 为 chatting，替换旧 discussing 夹具期望，不改变生产 phase。该用例只验证冻结与确认，不宣称验证整个多 worker 流水线执行。
- 对真实已确认原生 graph 调用旧 SDK revise，实际进入旧 applyRevision 后读取不存在的旧 graph_revisions，抛 TypeError。现先识别原生 revision 并明确返回 invalid_graph，指向 graph_patch/baseRevision；不触碰原生定义或队列。公开 SDK 修复前真实失败、修复后原生应用继续成功交付。
- M7 freeze / production / 跨进程 CLI 3 文件、4 用例，14.89 秒及 TypeScript 通过。未移除其他有价值的旧 Git、权限、审查或合并冲突合同；M7 仍有 delivery / adapters / proposal 一套旧入口待迁移，SDK 类型与整个旧调度器退役继续实施。第四十八轮完整门禁待执行。

- 第四十八轮完整门禁通过：276 文件、1874 用例，172.13 秒；TypeScript、lint 与验收证据检查通过。原生冻结/确认及旧 SDK 拒绝均通过全量验证。下一项为 M7 多 worker delivery 的原生迁移，随后删除它独占的 adapters / proposal；不跳过独立工作副本、真实应用检查、共享审查与来源仓库保护。

## M7 原生多 worker 交付与确认需求版本

- 多 worker delivery 改由四个真实常驻 Pi 执行：API/UI 使用独立工作副本，测试节点读取已集成实现，独立 reviewer 读取实际文件、发布共享 Markdown 与绑定当前 commit 的正式报告。宿主执行真实 Web API 检查，用户确认后才交付同一 commit；保留原 CLI scripts、JavaScript 工具链和来源仓库保护。
- 实测需求讨论到版本 2 后，确认创建的子 graph 需求版本仍写死为 1，导致所有检查及审查通过后仍被 requirement-version 阻塞。修复前公开交付回归失败；确认现在保存所确认草稿的实际需求版本，子 graph 的草稿/结构版本仍独立从 1 开始。未取消版本验收约束。
- 退役候选证据：tests/m7/adapters.ts 的 mediaBookmarksActions 与 proposal.ts 的 mediaBookmarksProposal 仅互相引用，没有生产或其他测试调用；历史 f1ddaaa 为补齐 M7 独立验收而保留 scripted 夹具。迁移后的 delivery 在公开 runtime/Pi/Git 边界保护独立工作副本、集成后读取、共享审查、真实检查和来源保护，production / freeze / CLI 继续覆盖应用交付、需求冻结与跨进程恢复。删除这两个无调用的旧支持文件，不删除测试。风险是遗漏旧夹具的独立合同；通过完整 tests/m7 与全量门禁验证。
- 本用例使用本地 HTTP 模型响应、预写应用内容和合成用户确认，不证明自主规划、真实 B站登录或付费模型 A13 验收；main 明确等待代码集成后启动测试与检查，不声称 submit 会隐含等待 Git 集成。
- 交付/冻结/会话定向验证 4 文件、49 用例及 TypeScript 通过；删除旧支持文件后的 M7 与第四十九轮完整门禁待执行。

- 第四十九轮完整门禁通过：276 文件、1874 用例，178.62 秒；TypeScript、lint 与验收证据检查通过。删除支持文件后 M7 定向 6 文件、8 用例通过；完整 spec 和旧内核退役仍在进行。

## 原生 M1 演示与不限额度缺失用量

- M7 原生多 worker 与确认需求版本修复已提交为 c4d31bc。手动迁移 examples/m1-demo.ts，移除旧 nodes/dependsOn、ActionAdapter 与脚本自报证据。第一个宿主启动真实 Pi、写 search.mjs 并 submit；第二个宿主重开同一 graph/实例、读取已持久公开结果，通过宿主 operation 执行独立 check.mjs，再显式完成。报告保留实际检查结果与 SHA-256；旧演示目录明确拒绝，不转换历史。
- 实际演示在不限额度且 HTTP 响应没有 usage 时被第二次请求阻塞。扩展 kernel-node-budget 的真实 Pi 公开合同，修复前 unlimited 请求数只有 1，预期 2 的断言失败；原生 lane 现复用 controlled transport 的缺失用量估算，仅以当前 execution 冻结的 unlimited 额度启用。有限额度仍保留 unknown，不伪装零用量、不发后续请求。
- 新回归同时核对实际文件写入、两条 estimated 持久调用与有限额度原输入保留、节点 blocked；后者夹具最初误期望 failed，实际正确合同为 queued/blocked，已修正测试而未改生产队列规则。预算与执行器 2 文件、31 用例通过。
- 演示最初的路径非 canonical、模型 runtime 缺失、result 字段名及受限命令配置错误均已修正；中途扩大权限不能解决缺失用量问题，已恢复默认受限配置。检查采用 allowlisted node 文件命令，不用 inline eval 或绝对 command 绕过边界。当前默认权限下两进程实现/检查通过；使用本地脚本模型与估算用量，不证明自主开发或真实供应商账单。
- 原生演示负向、重放验证和第五十轮完整门禁待执行；SDK 旧提案格式、旧调度器、转换夹具及正式默认切换仍未全部退役。

- 第五十轮完整门禁通过：276 文件、1875 用例，173.60 秒；TypeScript、lint、基线与验收证据检查通过。默认受限模式下两宿主演示通过，完成后重放两个阶段均为零模型请求；修改真实实现使检查失败并阻止完成，旧演示目录拒绝且原状态字节未改变。没有收费模型调用。


## 原生确认任务排队、停止与界面类型

- 手动迁移 task-runtime、decision-digest-cap、git-recovery，以及 conversation 的撤回草稿和 app-shell 的三个提案/聊天/图例合同。这些文件不再调用旧提升器；保留幂等 receipt、需求冻结、持久事件游标、实际 Git 恢复、聊天历史与浏览器布局/分页断言。仍有旧 SDK 测试和提升器自身的历史测试，未宣称整个退役完成。
- 原生公开 runtime 回归在修复前实际失败：完成后的确认任务仍占用全局活动名额，后继一直 queued；用户 abandon 写旧 abandoned 状态且未取消原生队列。共享 releaseTaskSlot 仅允许当前名额拥有者释放，完成/停稳与后继准入在原事务内完成；management graph 不释放其他确认任务的名额。用户停止改走 stopping → stopped，取消待运行输入，直到工作停稳才启动后继。
- 修复后 5 文件、44 用例与类型检查通过；新增完成回归核对后继实际操作执行，但通过检查不会隐含完成。停止回归核对待运行输入取消、幂等 receipt、事件顺序与停稳前后准入，未声称本轮证明活动 Pi 的强制中断或所有资源清理。
- 原生浏览器迁移另发现操作模块被统标为 route；修复前真实 DOM 的 data-node-type 返回 route 而非 tool。草稿/运行图共用结构投影现区分 operation、command 与 router，路由的 each/once 仍分别显示 route/join；未引入独立工具节点。初次 2 文件、72 用例仅该断言失败，修复后定向 3 个浏览器合同通过；其余 69 用例已通过。
- 第五十一轮完整门禁待执行。SDK 类型仍暂需 Proposal 断言，默认切换、旧调度器和整个 spec 仍未全部完成。

- 第五十一轮完整门禁通过：276 文件、1876 用例，215.59 秒；TypeScript、lint、基线与验收证据检查通过。新增原生完成排队回归使基线增加 1 用例；聊天浏览器合同在最终全量全部通过。完整 spec、SDK 切换与旧内核退役仍在实施。


## 旧 graph 转换设施退役

- 候选与调用证据：上一轮手动迁移后，tests/fixtures/v2-lift.ts 的调用只剩 v2-lift.test.ts 与 scripted-legacy-fields.test.ts；scripts/lift-v2-test-proposals.py 只有 lift-tool.test.ts 调用，没有生产、包脚本或其他活跃测试使用。历史 9c51081 / 60934cb 为当时批量迁移建立夹具与工具，4d02f7e 的旧字段回归仅证明读取旧 proposal.input/context 的 scripted 补偿，不证明真实 Pi 收到原生投递。
- 删除以上两个工具和三个独占测试文件，共 17 个测试。转换器的解析、字段保留、跨容器猜测、源码扫描与重写脚本断言仅保护已弃用迁移工具；删除不等于旧内核已退役。保留真实原生 kernel-node-host / node-turn-driver / resident lane、接口队列、路由、子 graph、确认与真实 Git 交付合同；SDK 和 scripted adapter 的旧字段补偿仍待后续移除，未借删除此测试改变补偿行为。
- 风险是遗漏外部脚本调用或旧夹具隐含合同：仓库全量引用扫描无活跃调用，历史 handoff/独立验收文档保留当时事实，可在上述提交查看旧文件。此次基线有意从 276 文件 / 1876 用例降为 273 文件 / 1859 用例，使用 GRAPH_UPDATE_BASELINE=1 明确公告，不绕过数量门禁。第五十二轮完整门禁待执行。

- 第五十二轮完整门禁通过：273 文件、1859 用例，179.21 秒；TypeScript、lint 与验收证据检查通过。基线按上述已记录的 3 文件 / 17 用例退役有意降低，数量守卫仍正常启用。


## 原生提案 SDK 类型

- 公开 M7 production 合同移除旧 Proposal 断言后，修复前 TypeScript 在 main.propose 实际报 TS2741：原生对象缺少旧 nodes 字段。新增 NativeProposal，与暂留的旧 Proposal 共用需求/验收/决策字段，原生 definition 必需；SDK propose / validateProposal 接受原生类型，main 的 Pi 工具通道及工具参数解析只声明 NativeProposal。
- 原生校验仍先校验定义、具名验收和决策；剩余旧 SDK 校验单独放入 private validateLegacyProposal，不新增转换或兼容执行器。旧调用尚未迁移完，仍不能宣称默认切换完成。
- M7 production / freeze / delivery、两个控制台合同、原生任务/撤回草稿/聊天浏览器夹具移除不必要的旧 Proposal 断言；非法结构的负向夹具保留类型断言，因为它们有意提交运行时非法值。未改运行图、预算、审查或 Git 行为。
- 修复后主应用与 Web 类型检查通过；定向及第五十三轮完整门禁待执行。

- SDK 定向验证 5 文件、12 用例通过，5.87 秒。首次定向命令遗漏 GRAPH_MEDIABOOKMARKS_ROOT，两个 M7 用例在不存在的来源 cwd 调用 Git 报 ENOENT；补齐实际来源路径后通过，未改变产品或夹具以掩盖错误。第五十三轮完整门禁待执行。

- 第五十三轮完整门禁通过：273 文件、1859 用例，176.78 秒；TypeScript、lint、数量基线与验收证据检查通过。原生 SDK 无旧 nodes 的调用已通过真实 M7、聊天界面及任务生命周期全量合同。整个 spec、默认切换及旧内核退役仍未完成。


## 原生 SDK / 常驻 Pi 聊天入口与可视化事实

- 原生 SDK 的 sendNodeMessage 原先忽略 requestId，重复请求实际创建第二条队列项；sendPeerMessage 仍读旧 nodes，拒绝真实原生节点；常驻 Pi 虽能排入 peer 输入，却不写可视化使用的来源账本。手动迁移 graph-messages 合同到真实本地 HTTP/Pi：修复前三个用例分别因上述原因失败。
- SDK 节点/peer 及常驻 Pi 的节点间 peer 工具共用 sendKernelNodeMessage，校验同 graph 身份、消息大小和 requestId，队列/来源记录/receipt 同事务落账。命令 scope 区分目标与发送者，改变内容拒绝；内外聊天沿用已有完成/停止输入边界。enqueue 复用 enqueueInCurrentTransaction，已有事务内不二次 BEGIN，独立调用仍开启事务；未改变 TaskStore 全局事务行为。
- 初次接入遇到 nested transaction，三个回归真实失败；上述 enqueue 修复后 3 文件、37 用例通过，4.83 秒。真实 Pi 首次回复等待期间收到 peer 和用户两条消息，队列为 claimed / queued / queued，释放后仅 3 次请求；后续请求保留旧回复但不重复注入初始 graph 概览，同一实例；发送者节点未被隐含运行。实际工具调用 send_to_peer 产生持久来源弧，用户消息不计作 peer 弧，删除来源记录即移除弧。
- 保留 node-messages 的旧合同直至旧 SDK/调度器退役，不把旧 steering/后继失效规则迁回原生模型。main 作为 peer 目标仍沿既有 owning-conversation 通道，本轮仅统一节点间消息，没有声称验证其 requestId 幂等或整个默认切换完成。新增停止后 receipt 重放 / 新聊天关闭验证；第五十四轮完整门禁待执行。

- 第五十四轮完整门禁通过：273 文件、1861 用例，177.86 秒；TypeScript、lint、数量基线与验收证据检查通过。迁移原可视化合同并新增两个独立回归，基线增加 2；停止后 replay/new-message 断言也通过最终全量。默认切换和整个 spec 仍未完成。


## 原生模型删除保护

- modelsInUse 只查旧 nodes / instances，遗漏原生声明与实际绑定。手动迁移现有 settings HTTP 合同到 conversation 确认产生的独立 graph，排除同 task 的旧 main 记录掩盖；原来的空模型目录又触发 invalid_config，改为合法替代连接后，修复前真正 HTTP 返回 200 并删除模型，预期 config_in_use 的 400 失败。
- 新增真实 Pi 冻结合同：旧模型 HTTP 请求被保持，运行中 patch 声明新模型；修复前 modelsInUse 返回 []，预期保护旧/新两项失败。kernelModelsInUse 读取活动节点声明、最新执行与实际绑定；执行中保护冻结模型，配置未变时保留实际选择的 fallback，配置已变且 turn 结束后释放旧绑定。按 graph / revision 在本次查询缓存定义，避免每个节点重复解析整图；退役节点和 completed / stopped graph 不占保护。
- API 删除判定只比较当前确实存在、且候选中被移除的连接，避免未配置的偏好 ID 拦住无关保存。HTTP 验收保留合法替代配置：原生 graph 未结束时拒绝并保留 revision 0，停止后即使另一个图声明 unavailable，也可保存 revision 1。
- 定向 2 文件、3 用例通过，9.05 秒，覆盖当前冻结、下次切换、同一实例、idle 实际 fallback、节点退役、graph 停止和 HTTP 拒绝/许可。第一次类型检查发现未配置情况下 current.config.models 可为 null，已修正为可空目录；提取只读 helper 后第五十五轮完整门禁待执行。
- 原生模型目录守护已补齐；旧 SDK/调度器退役、正式默认切换及整个 spec 仍未完成。

- 第五十五轮完整门禁通过：273 文件、1862 用例，181.83 秒；TypeScript、lint、数量基线与验收证据检查通过。新增真实冻结/配置/退役生命周期回归使基线增加 1；已迁移 HTTP 合同和实际模型历史均通过全量验证。整个 spec 与旧内核退役仍未完成。


## 原生 agent 向外部 main 聊天

- 常驻 Pi 的 main 分支丢弃 requestId；同一请求两次真实工具调用实际生成两条 owning-conversation 消息。SDK 的原生 peer 入口又把 main 当作内部节点而拒绝。新增 owner-boundary 回归修复前因消息数 2 而非 1 失败。
- sendKernelMainMessage 统一 Pi / SDK 通道，按 graph、发送节点和 requestId 保存持久回执。消息、可追溯来源元数据和 main wake 在同一命令事务写入；异内容重放拒绝，来源必须是当前 graph 声明的 agent。完成/停止后拒绝新消息，旧回执仍可重放；completing 期间内部 agent 仍可与 main 协作。
- 回归使用真实本地 HTTP / 常驻 Pi 两次 send_to_peer，外部 main 使用正常 ActionAdapter 回复。只生成一条 peer 消息和一个 peer_message wake，main 实际收到原文；SDK 重放复用同一消息 ID，异内容、未知及原型属性发送者拒绝。停止 graph 后 main 仍能处理用户新聊天。
- 定向消息 / wake / conversation-queue 合同 3 文件、20 用例通过，4.10 秒；随后补充 main 在 graph 停止后继续回复的验证。第五十六轮完整门禁待执行。该轮未退役旧 SDK / 调度器，也未完成整个 spec。

- 第五十六轮完整门禁通过：273 文件、1863 用例，185.30 秒；TypeScript、lint、数量基线与验收证据检查通过。新增一个 main peer owner-boundary 回归使基线增加 1；停止 graph 后外部 main 继续处理聊天也通过全量验证。整个 spec、旧内核退役和正式默认切换仍未完成。


## 不限额度且无法估算的原生用量

- graph-mvp 明确允许不限额度在无法估算时继续，原生 provider gate 和 workspace_commit 却无条件拦截 unknown。真实本地 HTTP / Pi 回归以有效 SSE 注释超过估算器的有界读取上限，响应正常、用量确实无法估算；未修复时后续实际请求只有 1 次而非 3 次。只修 provider gate 后，真实 workspace_commit 又返回 Reconcile unknown provider usage 拒绝。
- 两个入口只依据当前执行冻结的 tokenBudget.unlimited 放行，缺失预算历史不作为不限额度。unknown 调用保持 null 用量、unknown 来源、未知费用及占位，已知调用继续记录实际用量，不把未知成本记为零。运行期间 patch 到有限额度不改变本次执行的权限。
- owner-boundary 合同验证工具返回的实际 commit、git show 中的实际文件，以及接口任务结束后的集成 commit 文件；不以聊天触发隐含集成。下次有限额度执行保留旧 unknown 占位并等待核对。测试最初有限额度等于执行预留量，先触发已用 token 导致超额的另一层拒绝；改用有余量的 500000 后暴露了未知用量被自动重试到 failed 的真实问题。
- NodeExecutor 在保存冻结额度后、开始 attempt 前检查既有 unknown provider 调用，有限额度按 blocked 保留输入并暂停后续队列，attempt 保持 0。该检查不依赖异常消息中的 budget 字样，不以未知用量消耗自动重试。原有限额度缺失用量、估算来源与预算耗尽合同仍保留。
- 定向预算合同 2 文件、12 用例通过，7.74 秒；新增 fixture 仅提供真实 SSE 注释，不注入用量、提交回执或 Git 结果。生产改动 6 行，新增一个真实 Pi / Git 回归；第五十七轮完整门禁待执行。整个 spec、旧内核退役及默认切换仍未完成。

- 第五十七轮完整门禁通过：273 文件、1864 用例，187.81 秒；TypeScript、lint、数量基线与验收证据检查通过。首次类型检查发现 nodeRun 新旧调用记录联合类型不能直接读取原生 state；测试改用公共 usageSource 并对原生记录作类型收窄后，全量通过。新增一个真实未知用量 / 冻结额度 / Git 提交 / 有限额度等待合同使基线增加 1。整个 spec 和旧内核退役仍未完成。


## main 的原生草稿、确认、patch 与会话节点卡片

- 手动迁移 conversation 主合同中的五项：草稿验证、同需求版本/历史/最新确认、主 agent 修改 feature graph、范围变更创建排队任务、重新绑定项目使旧草稿失效。共享的是手工声明的 NativeProposal，具名接口、连接及 workspace.command 模块；没有旧定义转换器。旧 revise 调用改为 graph_patch，保留 revision / 状态 / 配置 / 非法目标读取拒绝；操作模块通过 graph_inspect 查看。
- 原生迁移后草稿确认合同真实失败：conversations.view 的 task.nodes 是 []，不是 idle 的 work。该 reader 原先只读旧 nodes 表；新增 kernelConversationNodes 从原生节点、绑定、累计用量和最新执行冻结额度批量读取卡片事实，不读取完整 prompt / 会话分页。旧分支暂留直到整体 SDK / 调度器切换，不声称旧入口已关闭。
- 草稿历史、过期拒绝、已确认范围保持不变的原断言均保留；确认不隐含执行，原生 work 为 idle、队列为空；仅明确 graphSend 后 taskStatus 等待才超时。外部 main 仍属于会话。不存在 graph 的 graph_patch 返回 not_found，保留新 API 实际合同，不沿用旧 revise 的错误码。
- 既有真实 Pi / main 聊天合同增加独立来源的卡片验证：三次 provider 响应各明确 7 输入 + 3 输出，卡片 used 为 30、实际 local 模型与 worker 身份、worker@1 配方及冻结不限额度均来自真实运行。随后声明下次额度为 500000，历史预算仍不限，不把新配置当作旧执行的预算。
- 初步定向 2 文件、45 用例通过，20.21 秒；随后补充额度卡片 patch 验证。测试数量不增加，五项旧 DAG 合同在原文件内迁移，移除这些夹具里不再调用的 work adapter 和旧图输入。第五十八轮完整门禁待执行。整个 spec、旧内核退役和正式默认切换仍未完成。

- 第五十八轮完整门禁通过：273 文件、1864 用例，184.73 秒；TypeScript、lint、数量基线及验收证据检查通过，测试数量不变。第一次类型检查发现手工夹具的 NativeProposal type import 未补齐，修正后最终全量通过。五项 native 草稿 / patch 合同及真实 Pi 节点卡片累计用量、绑定与冻结预算验证均通过；整个 spec、旧 SDK / 调度器退役及正式默认切换仍未完成。


## 原生 worker 的确认约束快照

- 手动迁移 conversation 中四项 worker briefing 合同：约束传递、草稿冻结与项目作用域、显式空决策、外部 main 监控上下文隔离。使用手工 NativeProposal、真实本地 HTTP / 常驻 Pi 与明确 work.job 投递，检查实际模型请求；不使用旧 work adapter 的 context.briefing 证明原生行为。原文件测试数量不变，共享真实 Pi 支持夹具减少重复设置。
- 修复前定向三项中两项真实失败：确认任务虽已保存 decision_digest，原生 NodeTurnDriver 的首次 prompt 没有读取它；显式空决策的负向合同已通过，不能据此声称约束传递正常。生产两行补上首次节点上下文，只读取该任务确认时的快照，不重读 main 可变消息，也不把 main 的监控状态送入 worker。
- 修复后定向 conversation / node-turn-driver / decision-digest-cap 3 文件、51 用例通过，23.40 秒；之后将剩余监控隔离合同迁移到真实 Pi，并加强草稿后消息合同，要求原始已确认约束仍在。项目重绑、早期约束、显式 curated 决策、撤销约束和新需求空快照断言保留；已有快照长度/条数边界与后续执行差量合同保留。
- 第五十九轮完整门禁待执行。整个 spec、旧 SDK / 调度器退役与正式默认切换仍未完成。

- 第五十九轮完整门禁通过：273 文件、1864 用例，188.77 秒；TypeScript、lint、数量基线及验收证据检查通过，测试数量不变。四项已迁移真实 Pi 的约束/监控隔离合同在最终全量通过。生产增加 2 行，测试及支持夹具净减少 76 行；旧 SDK / 调度器和整个 spec 仍未完成。


## 原生执行中的节点状态与 main 监控

- 手动迁移 post-confirmation chat 合同：确认只建立 idle 节点，main 初次询问读到 work:idle；明确投递后运行真实本地 HTTP / 常驻 Pi，main 后续询问读到 work:succeeded，两次聊天均不改变已确认需求版本。原生支持夹具可记录外部 main 的真实 Operation briefing，worker 不再使用旧 adapter；沿用同一份手工 NativeProposal。
- conversation-boundaries-ui 的实时 worker 合同迁移到真实 Pi；首个 HTTP 响应通过明确 barrier 保持，确认后显式 work.job 投递。保留未刷新页面的 running → succeeded、账本一致、独立 graph tab / drawer、聊天中不混入任务卡片、未知 master 用量不阻塞、后续聊天及 210 条历史分页断言；不降低或覆盖验收截图。宿主检查为 operation 模块，human 为正式验收项，没有独立工具节点。
- 修复前 2 文件、43 用例中浏览器 running 断言真实超时，其余 42 项通过。startExecution 仅将 execution 设为 running，kernel_nodes 始终 idle 直到结算；首次或 blocked 恢复现于同一事务更新节点运行状态，并追加 graph.execution.started 持久事件，让卡片和增量刷新读取同一事实。没有从浏览器或 provider 回调伪造节点状态。
- 修复后 conversation / conversation-boundaries-ui / node-executor 定向 3 文件、67 用例通过，24.45 秒；随后加强等待中真实节点账本 running 验证。测试数量不变；旧 result_noncompliant 交接异常合同暂保留，其升级/用户决策/修复内容传播尚未完整迁移，不把通知唤醒视为该合同的全部替代。
- 第六十轮完整门禁待执行。整个 spec、旧 SDK / 调度器退役及正式默认切换仍未完成。

- 第六十轮完整门禁通过：273 文件、1864 用例，191.56 秒；TypeScript、lint、数量基线及验收证据检查通过。迁移后的浏览器合同在全量并行负载下 8.11 秒通过；main 的 idle / 真实执行后 succeeded 摘要和冻结需求合同也通过。生产净增加 3 行，测试及支持净增加 13 行，未新增测试数量。整个 spec、旧 SDK / 调度器退役及正式默认切换仍未完成。


## main 修改原生 graph 共享产物

- artifact_publish 的 main 宿主通道始终覆盖 taskId 为外部会话的 anchor，无法修改内部 graph 的产物；ArtifactWorkspace 的 main 权限又只认 kernel_graph_owners，遗漏确认草稿创建的 graph，并只核对 operationId 未核对节点/实例/activation。新增两个真实本地 HTTP / Pi owner-boundary 回归，分别使用确认与管理创建路径；worker 真正发布 v1 后，修复前 main 修改未进入目标空间，期望 v2/master 实际仍为 v1/author。
- main 的工具 schema/说明新增可选 graphId；宿主只允许 main 选择确实存在的原生 graph，工作目录与 producer 仍由宿主捕获。存储层按明确 owner 绑定或所属 conversation 的真实 anchor 核对 main 权限，同时匹配 actual operation/node/instance/activation；其他 conversation / 独立 owner 拒绝。不从模型参数接受 producer，不通过旧图无权限分支绕过原生检查。
- 回归核对 v1 字节与原作者、main 实际发布 v2 的字节和修改者、同 execution 请求重放仍只有 v2、跨 owner 发布没有落入目标或偷偷落入 anchor、持有真实 main operationId 却伪造节点/实例的请求被存储拒绝。原作者在 main 修改后仍可真实发布 v3；另一个 agent 的同名修改和指定 graphId 均被拒绝，最终仅三个不可变版本。
- 夹具首轮因真实 main 另调用 composer suggestion 消耗 worker 计划而在 v1 前失败，属于测试设置错误；给实际 suggestion 独立本地 endpoint 后，两条回归在预期 main v2 缺失处真实失败。未改变 suggestion 产品行为。修复后 owner / conversation scope / artifact workspace 3 文件、14 用例通过，6.77 秒。新增两项合同，不删除原产物隔离、版本、配额和路径安全合同。
- 第六十一轮完整门禁待执行。main 退役产物的 Pi 入口、完整产物可见范围与 provenance 索引仍需核对；本轮只证明发布与修改版本，不宣称整个产物子系统完成。旧 SDK / 调度器退役、正式默认切换及整个 spec 仍未完成。

- 第六十一轮完整门禁通过：274 文件、1866 用例，176.45 秒；TypeScript、lint、数量基线及验收证据检查通过。新增 owner-boundary 文件含确认 / 管理两项真实 Pi 合同，使基线增加 1 文件 / 2 用例；全量中两项 12.54 秒通过。生产净增加 13 行，新增测试及支持 106 行；本轮未改旧 SDK / 调度器，不宣称正式默认切换或整个 spec 完成。


## main 撤回原生 graph 产物的权限与归属

- artifact_retire 的 Pi 通道没有传入本次真实 producer，且存储层根据调用者 taskId 而非产物 ownerId 决定是否使用原生权限。外部 anchor 可读所属 graph 的产物，却被误判为旧任务而跳过修改权限，撤回事件也写入 anchor。扩展已有确认 / 管理两项真实 Pi 合同，未增加重复测试文件；修复前两项均在“没有 actor 应被拒绝”的断言失败，证明确实发生未授权撤回。
- 存储层根据目标产物所属原生 graph 核对 actor、原作者或 main 所有权，并将幂等命令和事件归属该 graph；Pi 通道传递宿主捕获的 operation/node/instance/activation。工具参数保持精确 artifactId/version，不增加任意身份参数或新工具。
- 真实主 Agent 连续调用两次 artifact_retire，核对目标版本 retired、旧字节可读、最新 v3 仍 published，以及唯一撤回事件在 graph 而非 anchor。独立存储权限合同拒绝缺失身份和持有真实 main operation 却伪造节点的请求。已有发布版本、原作者权限、跨 owner 发布、配额与会话范围合同保留。
- 聚焦验证 3 文件、14 用例通过，7.69 秒。第六十二轮完整门禁待执行；本轮只修复撤回权限和归属，完整产物可见范围、旧 SDK / 调度器退役、正式默认切换及整个 spec 仍未完成。

- 第六十二轮完整门禁通过：274 文件、1866 用例，185.85 秒；TypeScript、lint、数量基线及验收证据检查通过。未增加测试数量，扩展原有两条实际 Pi owner 合同；生产净增加 3 行，测试净增加 14 行。旧 SDK / 调度器退役、正式默认切换及整个 spec 仍未完成。


## 原生 graph 控制目标与已结算输入

- graphControl 只拒绝 absent / claimed 队列项，已成功回复但未 submit 的聊天和已经取消的输入仍可 retry；skip/cancel 也能改写 done 历史。同时 pause/resume 无目标验证，会为不存在或已删除节点写入 kernel_node_state。
- 扩展已有真实 HTTP / 常驻 Pi 串行聊天合同与 main 局部 patch / 退役合同，不创建新测试文件或重复的模型夹具。首轮两个合同在已结束聊天与取消输入的 retry 未被拒绝处失败（2 failed / 31 passed）；先修队列条件后，退役节点 pause 未被拒绝的独立断言继续失败（1 failed / 28 passed），分别确认两种产品缺陷。
- 管理入口拒绝对 done 输入 retry/skip/cancel；不改写历史、generation、取消原因或节点暂停状态。claimed 仍拒绝，失败且未提交的输入仍可按原规则 retry；成功 submit 后不能重发。pause/resume 用当前定义的具名 agent 节点验证目标，拒绝旧节点、ghost 和原型属性名。
- 实际 Pi 三次聊天全部完成后，非法控制仍保留三个 done 输入与原 generation，再次驱动不调用第四次模型；实际取消后的输入保持历史，再显式 patch 删除节点，非法 pause/resume 不写任何新状态。失败重试、已提交世代检查、完成/停止和队列计数的原合同保留。
- 第六十三轮完整门禁待执行。整个 spec、旧 SDK / 调度器退役及正式默认切换仍未完成。

- 聚焦验证 3 文件、40 用例通过，4.82 秒；第六十三轮完整门禁通过：274 文件、1866 用例，191.71 秒，TypeScript、lint、数量基线及验收证据检查通过。生产净增加 3 行，测试净增加 23 行；未增加测试数量。旧 SDK / 调度器退役、正式默认切换及整个 spec 仍未完成。


## 原生草稿的展示验收与执行验收一致性

- 原生 validateProposal 仅验证外层 acceptance.checkNode 是否存在，不要求 definition.acceptance 存在，也不核对两者的 ID、描述和检查对象。最终验收虽能阻止缺失条件的图完成，但已让矛盾草稿进入确认；若内部原始 criterion 存在，外层不同描述或 checkNode 甚至不影响最终判断，用户确认内容与执行依据分离。
- 扩展现有 Main Agent 验证 / 项目绑定合同，分别测试缺失 definition.acceptance、外层描述不同、checkNode 指向另一个真实节点、ID 不同、内部多出未展示的人工验收项。修复前首个缺失定义变体被验证为 valid:true，回归真实失败。修复后验证与创建都拒绝所有变体，conversation.proposal 仍 null。测试首次修复运行把 view 的字段误写为 draft，修正为公开 proposal 后通过；未通过伪造数据绕过实际入口。
- 原生草稿要求执行定义与展示摘要具有同一组 ID / 描述，check/review 精确绑定 module/node；graph_create 的独立管理用途与 human 正式验收流程保持原有行为。工具说明和指导文档同步规则，错误在提交草稿时返回。
- node-prompt-ui 的原生草稿预览夹具原先只有路由及外层摘要，未声明正式验收；手工声明同一描述的 human criterion，仍展示 worker / gate 两个对象、具名接口和实际节点数，不把 gate 状态假装成验收证据。
- 聚焦验证 4 文件、57 用例通过，26.40 秒；第六十四轮完整门禁待执行。旧 SDK / 调度器退役、正式默认切换及整个 spec 仍未完成。

- 第六十四轮首次完整门禁为 269 文件 / 1859 用例通过，5 文件 / 7 用例失败，189.18 秒；所有失败均来自遗漏正式 criterion 或隐藏一个正式宿主检查的有效草稿夹具，不放宽生产校验。手工修订 confirm-graph / graph-auto-run / scripted-lane / v2-completion 的人工验收声明，浏览器状态合同外层补齐现有 check；保留实际执行与断言。v2-completion 明确证明成功节点不能代替用户验收，graph-auto-run 修正措辞为“队列清空”而非整个 graph 完成。5 文件 / 17 用例聚焦通过，7.17 秒。另补同一验证合同中 review 目标与摘要不一致的拒绝，未增加测试数量；完整门禁重跑待完成。

- 第六十四轮修订后完整门禁通过：274 文件、1866 用例，191.30 秒；TypeScript、lint、数量基线及验收证据检查通过。生产净增加 4 行，测试净增加 21 行，未增加或删除用例。旧 SDK / 调度器退役、正式默认切换及整个 spec 仍未完成。


## 节点详情真实 Pi 合同迁移与脚本输入旧字段退役

- node-run 的实际 Pi 记录 / 重启一致性合同、实际 HTTP 详情 / 分页 / 未知节点合同仍通过旧 dependsOn 图和伪造 digest 的程序 Evidence 启动 worker。两项改为手工原生声明、显式输入和非隐式完成的 human criterion，删除对应旧节点数组及假检查适配器，不使用转换器。
- 保留 actual read 工具调用 / 结果、assistant 回复、Pi session、权威 provider usage、条目总数、HTTP 限量分页和未知节点拒绝。原生执行采用 completed 状态、实测 elapsedMs 和总墙钟时间；runMs / waitingMs 尚无实际分项记录，明确断言 null 而非补造零。初始提示记录以实际 HTTP 请求核对，重启后完整条目、sessionId 与实测时间一致。首轮旧分类 user:briefing 断言不适用原生 message，改核对角色、graph 概述及实际发送正文，不为分类字符串改动生产代码。
- Scripted ActionAdapter 桥仍查旧 proposal.nodes 的 input/context，原生投递反而收到 {}。扩展现有无模型实际宿主合同，捕获真实 adapter 收到的输入，修复前期望 {text:"go"} 实际 {}；删除旧 proposal 查询与字段回退，使用本节点已 claim 队列的实际 value / payload 和本次组装的 briefing。缺少 claim 时明确拒绝，仍经过原 NodeSubmitBridge / KernelStore 提交和一次完成记录。
- 节点详情单文件 8 用例通过，5.71 秒；合并聚焦 3 文件、12 用例通过，6.08 秒。移除 pause-ledger 夹具返回的无人使用假 Evidence adapter；该独立旧暂停账本合同与旧存储投影合同仍保留，不宣称 node-run 整个文件或原生暂停计时已迁移完毕。
- 第六十五轮完整门禁待执行。只删除原生脚本输入的旧字段兼容，其他旧 SDK / 调度器分支仍待退役；正式默认切换及整个 spec 仍未完成。

- 第六十五轮初次门禁在 TypeScript 阶段发现 SDK nodeRun 返回新旧投影联合类型，测试不能直接访问仅原生具备的 elapsedMs；使用字段判别读取，并继续要求首个实测时间为正、重启后相等，不扩大生产类型或伪造旧投影字段。修正后重跑完整门禁。

- 第六十五轮修订后完整门禁通过：274 文件、1866 用例，194.23 秒；TypeScript、lint、数量基线及验收证据检查通过。生产净减少 12 行，测试及支持净增加 14 行，未增删测试数量。旧 SDK / 调度器、剩余旧图测试及原生暂停计时仍待处理；正式默认切换及整个 spec 仍未完成。


## 原生暂停账本与最后一个公开暂停详情合同迁移

- node-run 的公开 task.pause/resume 测试原来仍通过 dependsOn / program check 建图，并直接读旧 nodes 投影。现改为手工原生声明及 runtime.nodeRun；确认不隐含投递，不启动模型。扩展同一合同检查用户 / main 两个真实控制入口、双向 graph / node 暂停重叠、重启、重复恢复及 stop 后冻结，未新增用例或测试专用生产入口。
- 修复前新合同失败：原生详情 pauseMs 为 null，无法与实测时间比较（/tmp/graph-native-pause-red.log）。根因是旧 time-ledger 只写旧节点表、kernelNodeRun 固定返回 null。原生节点新增可空计时及两个独立暂停来源标志，以实际边界累计两类暂停的时间并集，接入公开控制、队列恢复和实际详情投影。旧 main 基础设施账本保留；未测量的人工等待保持 null。
- 新增节点继承已记录的 graph 暂停，不把 worktree 准备期间 tasks.paused 的内部锁当作用户计时。退役、停止和完成关闭开放区间，历史未记录的数据不补零。
- 初次扩大聚焦检查发现 queue retry 原本就在 TaskStore 事务中，新调用嵌套 KernelStore 事务导致 9 个合同失败；修正为在原事务内关闭节点暂停账本。修订后聚焦 4 文件 / 56 用例通过，5.71 秒。
- 第六十六轮首次完整门禁在 TypeScript 阶段发现 SDK nodeRun 的旧分支含不具备 pauseMs 的 timing 类型；测试显式判别计时字段，缺少字段直接失败，未扩大生产类型。修订后完整门禁通过；实际统计见下一条。
- 本轮仅补齐原生显式暂停计时及迁移该公开合同。旧 SDK / 调度器与其剩余图测试、原生等待分项、正式默认切换和完整 spec 仍未完成。

- 第六十六轮修订后完整门禁通过：274 文件、1866 用例，195.59 秒；TypeScript、lint、数量基线及验收证据检查通过（/tmp/graph-v2-full-check-66-fixed.log）。生产净增加 50 行，测试净增加 23 行，未增删测试数量。正式切换及整个 spec 未完成。


## 原生文件交付实际 Pi 合同与旧节点消息分派退役

- node-deliverable 的四个公开合同原来使用旧 DAG、program check 和脚本 OperationResult，其中隐式依赖产物通过旧 dependencySources / 私有路径传递。手工改为 NativeProposal、真实 Pi / 本地 provider、显式具名输入：真实 write_file 写文件后自动发布；reader 收到精确 artifactId / version 并实际调用 artifact_read；实际 artifact_publish 与自动发布不产生重复版本；未写文件失败并保留 failed 队列原因。测试文件净减少 66 行，四个合同数量不变。
- 迁移中的初次失败由夹具错误造成：presets 路径误写 catalog，之后把真实工具 write_file 写作 write；实际 transcript 明确报告 Tool write not found。修正夹具后四项通过（8.38 秒）；没有将这两次夹具失败写作生产回归，也没有修改工具授权来让错误工具名通过。
- 删除 src/core/node-messages.ts（107 行）的旧 steer / DAG reactivate 实现，SDK sendNodeMessage / sendPeerMessage 及 Pi adapter peer channel 统一使用 kernel-node-messages。旧 fallback 不再存在；主会话 execution steering 保留。另保留旧 adapter peerNodes 地址列表，因为仍有非测试调用者。
- 删除 tests/console/node-messages.test.ts 的五个已废弃合同。删除前逐项记录真实检测能力、非测试调用者、旧行为与已确认设计的冲突、历史提交和保留的真实 Pi owner-boundary 证据，见 issue-1-old-kernel-removal-audit.md 的 2026-10-08 节。旧忙碌节点 steer、DAG 后继失效和 completed graph 重开不再作为正式产品保证。
- 扩展现有原生 graph-messages 三回合合同检查累计实际用量增加，并继续验证同实例 / 同 session 历史、幂等投递、busy 队列仅一项 claimed、无 sibling 执行、结束输入不能重试、停止后拒绝新消息及 peer sender/target 权限。聚焦 7 文件 / 57 用例通过（9.17 秒）。
- 第六十七轮完整门禁通过，统计与基线变更见下一条。这次只退役节点消息的一条旧分派路径；LegacyProposal / 旧确认物化 / DAG 调度器及正式默认切换仍未完成，完整 spec 未完成。

- 第六十七轮完整门禁通过：273 文件、1861 用例，187.25 秒；TypeScript、lint、验收证据检查通过（/tmp/graph-v2-full-check-67.log）。按已记录的五个废弃合同将基线从 274/1866 显式改为 273/1861。生产净减少 127 行，测试及支持净减少 205 行（不计基线 JSON）；未创建转换器或测试专用 seam。整个 spec 未完成。

## 原生实际执行链与常驻 Pi 自动压缩（待门禁通过，未提交）

- chain-depth 的两段、三段真实 HTTP / Pi 合同手工迁为 NativeProposal、具名协议与显式边；确认后不隐含启动，main 显式投递第一节点，每个实际 submit 投递下游，最终结果进入公开输出。移除旧 dependsOn、result_handoff 和伪造检查 digest。初次夹具漏写 enabled:true 导致下游 idle，修正声明后通过；生产解析器尚未拒绝缺失 enabled，记录为后续边界，不宣称本轮修复。
- 自动压缩和暂停期间摘要请求两个实际 Pi 合同迁为原生入口。首轮真实回归为 compaction 请求数为零：常驻 worker 未收到压缩配置，openPiInstance 默认禁用；原生详情还固定 purpose / cost。接入既有模型窗口设置和事件，摘要经过同一 provider gate，保存摘要条目、实际用途、用量及费用。价格在派发时冻结，结算与未知用量核对使用冻结价格；未知费用不补零。实际重启后调整配置价格，历史详情保持一致。暂停合同验证仅已在途 completion 结算，摘要没有发送，再次 drive 也不新增请求。
- 删除上述自动压缩合同末尾直接操作旧 taskGate 的 branch_summary 模拟片段：它没有真实 provider 请求，产品未打开 Pi branch navigator，且复用已结束 operation；不能证明用户可见分支摘要。保留旧 taskGate 的实际 main 调用方和主会话压缩合同，不删除共享基础设施。有限预算缩减、未知摘要用量及上游模型身份三个旧 worker 合同尚未迁移，不据此宣称整文件完成。
- 聚焦 5 文件 / 31 用例通过，28.95 秒（/tmp/graph-native-compaction-focus.log）；无新增或删除用例。生产净增加 23 行，测试净减少 61 行。git diff --check 通过。
- 第六十八轮首次完整检查 266 文件 / 1854 用例通过，7 文件 / 7 用例失败，316.81 秒；失败文件单独复跑 7 文件 / 122 用例通过，32.21 秒。重跑完整检查 271 文件 / 1851 用例通过，2 文件 / 10 用例失败，219.47 秒。失败全部在 command-module / spike-module-isolation 的 Docker 隔离执行；单独复跑仍为 10 failed / 11 passed，90.13 秒，不能算全绿。
- 只读诊断：docker version 持续不返回；直接连接本地 Docker Unix socket 的 /_ping 在 3005ms 内收到零字节并超时。磁盘可用约 2.7 GiB。证明 Docker 服务当时无响应，尚不能证明磁盘空间是原因。原生压缩及执行链合同在第二轮完整门禁均通过，不通过扩大超时或跳过隔离测试掩盖故障。
- 重启 Docker Desktop 会影响其他容器，已向用户请求这项操作的确认；未得到确认前不重启。当前改动未提交，必须恢复隔离服务并重新运行完整 node --run check。旧 SDK 草稿 / DAG 调度器退役、正式默认切换及整个 spec 仍未完成。

- 用户已明确允许重启 Docker Desktop。正常 restart 与退出未能结束无响应后台，停止旧后台后重新启动 Desktop；/_ping 返回 OK、docker version 返回 29.4.0。上述两个隔离文件未经源码或超时修改复跑，2 文件 / 21 用例通过，7.52 秒（/tmp/graph-v2-module-restart-focus-68.log）。此轮环境故障已解除，完整门禁仍需重跑，磁盘不足是否导致原始服务故障仍未知。

- Docker 恢复后第六十八轮完整门禁通过：273 文件、1861 用例，194.59 秒；TypeScript、lint、数量基线及验收证据检查全部通过（/tmp/graph-v2-full-check-68-after-docker-restart.log）。未扩大超时、跳过用例或修改数量基线。该批可以提交；整个 spec 及旧内核最终退役仍未完成。

## 边启用声明的统一校验

- 上轮真实执行链迁移暴露缺失 enabled 时静默断流：agent submit 只沿 enabled===true 的边发送，模块输出却只跳过 enabled===false；正式 JSON 解析器未检查此字段，因此同一无效声明具有两个不同含义。类型与正式 spec 明确 Edge 保存布尔 enabled，不引入隐含默认值。
- 扩展既有公开解析合同，验证缺失、null、0/1、字符串、对象及数组均拒绝，true/false 均保留；扩展现有 G7 管理合同验证无效 create 不留下 task/revision，无效 patch 不推进版本。首轮 2 failed / 61 passed，失败分别是未拒绝解析和实际创建，属于真实产品回归。修复仅在单一 parseGraphDefinition 入口增加一行检查，不另建运行时开关路径。创建后无 revision 的夹具断言使用实际返回 null，未以扩展生产返回类型适配测试。
- 聚焦 interface-spec / graph-runtime / kernel-store / module-router 四文件、82 用例通过，0.94 秒；无增删测试数量。生产净增加 1 行，测试净增加 19 行。git diff --check 通过。第六十九轮完整门禁待执行；旧 SDK 草稿、DAG 调度器及完整 spec 仍未完成。

- 第六十九轮完整门禁通过：273 文件、1861 用例，189.73 秒；TypeScript、lint、数量基线与验收证据检查全部通过（/tmp/graph-v2-full-check-69.log）。Docker 健康接口仍正常，未修改测试超时或数量基线。旧 SDK 草稿 / DAG 调度器退役、正式默认切换及完整 spec 仍未完成。

## 剩余 worker 压缩合同迁移与宿主拒绝原因

- compaction.test.ts 最后三个旧 worker 合同已手工迁为原生 NativeProposal / 明确输入 / 实际常驻 Pi，不再以 dependsOn / 旧 program check 启动。该文件保留主会话和旧共享 schema 迁移合同，因为它们守护被复用的主会话与预算基础设施；不能据此删除旧账本。
- 原有限预算测试在执行期间 setBudget 立即缩减 cap，与已确认的执行配置下次生效规则不同。改用执行前声明的 200000 quota，本地主请求实际计费 199940，留下 60 tokens；主请求实际发送并结算，摘要至少需要 256 tokens 输出预留，因此拒绝，后续聊天也不新增 provider 请求并显示 blocked。首次夹具设 100000 时被既有 200000 turn 预留先拦截，无 HTTP 请求；调整为能实际启动的额度，不放宽生产预算门禁。误用 task.events 的夹具改为真实 runtime.events API。
- 有限预算摘要未返回 usage 时，原生节点保留 queued 输入并显示 blocked；provider_calls 保持 unknown、usage / cost 为 null，再次 drive 不发送。模型身份合同核对真实 HTTP model=original-model、历史 modelIdentity=original-model，同时 configured connection id 仍为 local，避免把连接名和上游身份混同。
- 实际诊断缺陷：拒绝摘要的 RuntimeError 在供应商 SDK 内变为泛化 Connection error，原生事件没有保留宿主预算原因。扩展真实有限预算合同要求正式拒绝事件，修复前独立聚焦为 1 failed / 14 skipped，收到事件 []（/tmp/graph-native-compaction-refusal-red.log）。kernelProviderGate 在准入事务回滚后持久化 graph.provider.refused 的真实 code / reason / node / call / purpose，再抛出原错误；实际 send 在此捕获之外，不把供应商失败标成准入拒绝。被拒绝请求不产生 provider_calls 或费用，不改变准入结果。
- 首次绿色阶段断言错误要求恰好一次拒绝；真实 SDK 有多个内部尝试，因此改为逐条核对真实拒绝原因且要求非空，同时仍严格断言仅一个已发送主请求、零摘要 HTTP / invocation。没有为了固定次数限制 SDK 或制造回执。聚焦四文件、29 用例通过，22.16 秒（/tmp/graph-native-compaction-remaining-focus.log）；无增删测试数量。生产净增加 7 行、测试净减少 1 行。第七十轮完整门禁待执行。旧 SDK / DAG 调度器退役与完整 spec 仍未完成。

- 第七十轮首次门禁在 TypeScript 阶段发现测试 HTTP 记录的可选属性与 exactOptionalPropertyTypes 不一致，以及 nodeRun 的新旧联合类型不能直接读 modelIdentity；改用实际可缺失字段类型和字段判别，保持原生身份断言。未更改生产接口。上述测试净行数应为增加 1 行，非减少 1 行；完整门禁重跑待完成。

- 第七十轮修订后全量为 272 文件 / 1860 用例通过、1 文件 / 1 用例失败，191.83 秒。失败是隔离模块首个普通路由返回 ok:false，其他五项隔离合同及本轮压缩合同通过；Docker /_ping 正常。单独复跑该文件六用例全部通过，7.42 秒（/tmp/graph-v2-check-70-isolation-focus.log）。原断言未展示 evaluator.error，补入既有断言的失败说明，以便全量再次失败时报告真实原因；不放宽 5s 限制，不跳过测试。此次失败原因尚未确定，完整门禁继续重跑。

- 第七十轮最终完整门禁通过：273 文件、1861 用例，198.06 秒；TypeScript、lint、数量基线及验收证据全部通过（/tmp/graph-v2-full-check-70-rerun.log）。隔离文件原有失败在单独及全量重跑均未复现，不能据此推断首次失败的具体原因；保留真实错误的断言说明以利后续诊断。生产净增加 7 行、测试及支持净增加 1 行，无增删用例或放宽隔离限制。已完成自检与 git diff --check；本轮可提交。旧 SDK 草稿 / DAG 调度器退役、原生用户 setBudget 的旧实例依赖及正式默认切换仍待处理，完整 spec 未完成。

## 原生用户节点预算授权入口

- 公开 user.task(graphId).setBudget 仍查询旧 instances，正式原生节点没有对应行，因此用户无法修改额度。新增一个实际 HTTP / 常驻 Pi 的公开政策合同（无测试专用生产 seam）：已有 graph_patch 冻结合同守护声明变更，这个合同独立守护用户授权、命令幂等、跨重启持久性及 main 无法越权增额。首轮在实际请求等待期间调用 setBudget 报 Unknown agent node，1 failed / 8 skipped（/tmp/graph-native-user-quota-red.log）。
- kernel_node_state 新增可空 authorized_budget，旧节点没有明确政策时继续继承全局配置，不补造授权。用户命令事务验证现有 agent 及 graph 生命周期后仅写授权；current execution / provider gate 继续使用冻结 tokenBudget。新 execution 先读取用户授权，再校验 graph 节点 / defaults 的使用声明；额度增加、显式无限和缩减都不改变累计用量、预留、旧执行或 graph 定义。
- 节点详情新增独立 instance.authorizedBudget，原 instance.budget / unlimited 仍展示最近执行快照，不把新配置假装成已运行额度。预算调整不隐含恢复已停驻的队列，也不清除 unknown；需要执行时仍由 main 显式处理输入。老 main 会话的实例预算基础设施保留。
- 真实首回合在 HTTP 等待期间从默认 200000 授权改为 400000，回合结算仍显示 200000；同请求重放相同 receipt、改变内容拒绝。下一回合使用 400000（超过原全局默认但在用户新授权内）；显式不限额度后再运行同 session。累计用量增加且不重置。随后缩减为 10、重启后台，main 声明 1000000 仍在模型发送前被阻止，三条实际历史调用完整保留。ghost 拒绝，停止后拒绝新授权但可重放旧 receipt。
- 迁移中的夹具错误：JSON merge patch 中 tokens:null 表示删除字段，并非写入 null；解析器按现有契约正确拒绝缺失 tokens。改为删除节点的 budget 声明，从显式用户无限授权继承，不修改 merge patch 的既有语义。
- 聚焦 kernel-node-budget / v2-budget-blocking / compaction / budget-ledger / unlimited 五文件、37 用例通过，22.58 秒（/tmp/graph-native-user-quota-focus.log）。新增 1 个公开政策 owner-boundary 合同，无新文件；生产净增加 25 行、测试净增加 77 行。git diff --check 通过。第七十一轮完整门禁待执行，预期数量 273 文件 / 1862 用例。旧 SDK / DAG 调度器退役、main 旧 set_budget 控制路径及正式切换仍未完成，完整 spec 未完成。

- 第七十一轮完整门禁未通过：TypeScript / lint 已通过；4 用例失败，1857 用例通过，pre-push-hook 的同步子进程长期停滞后被明确终止，另记录 1 个 worker error；不能把它报告为完整通过。失败涉及 pi-extension-peers 的两次安装脚本启动与 conversation-capability-access 的两次扩展执行；本轮原生预算合同通过。日志 /tmp/graph-v2-full-check-71.log（630.92 秒）。小范围重复后脚本停滞仍出现，不是只在全量负载出现。
- 进一步最小化到独立于 Graph 的 /tmp/graph-exec-probe.sh（仅 #!/bin/sh + echo）：Node 24、Node 26 和 Python 直接启动均超时，显式 /bin/sh 读取同一文件立即成功；采样停留在 dyld_start。去掉仅此临时文件的 provenance 属性、使用最小 PATH 环境均未解决；系统日志记录 syspolicyd 的 dispatch_mig_server / qtn_proc 错误，但具体系统原因未确定。未改变系统安全设置，未绕过扩展真实执行合同，也未扩大超时。清理仅本轮自身遗留的脚本进程。
- 浏览器扩展既有原生独立窗口合同，真实用户授权 2000000，最近执行仍保持 1500000，同时显示两种含义。首次回归确实收到缺少用户授权的 DOM；首次聚焦因替换位置失误把授权放进另一用例，纠正夹具后真实浏览器与预算两个文件 13 用例全通过，9.68 秒（/tmp/graph-native-user-quota-final-focus.log）。新增界面用户授权一项，无新增浏览器用例或生产测试 seam。当前修改尚未提交，完整门禁仍需恢复并通过；完整 spec 仍未完成。

- 第七十二轮继续：终端 / Python 最小脚本仍超时，TTY 与最小环境均未恢复；sudo 只读采样提示需要密码，未提升权限或重启系统服务。已向用户单独询问 macOS 重启，既有 Docker 授权不被扩大解释。
- 扩展既有真实用户预算合同，main 旧 control_task set_budget 对原生节点应明确拒绝并指向 graph_patch；RED 为 Unknown agent node 而非正式指引（/tmp/graph-native-main-quota-control-red.log），增加一个入口 guard，保留旧 main 会话基础设施。原生声明只有 graph_patch 一条变更路径，不增加预算 API 别名。kernel-node-budget / node-prompt-ui / agent-control / v2-budget-blocking 四文件、21 用例通过，12.04 秒（/tmp/graph-native-main-quota-control-focus.log）。
- pre-push-hook 测试同步 execFileSync 的无限等待会绕过 Vitest 单用例计时，导致整套门禁停滞；为测试夹具命令增加 10 秒超时，保留失败 message 并在既有断言显示。不是增加产品超时，不把系统启动失败改为通过，不更改真实 pre-push hook。完整门禁仍需重新执行，当前不提交。

- 第七十二轮完整门禁正常结束：270 文件 / 1857 用例通过，3 文件 / 5 用例失败，共 273 文件 / 1862 用例，256.38 秒（/tmp/graph-v2-full-check-72.log）。全部失败仍是 pre-push / peer npm / 扩展脚本启动；新增预算合同、浏览器、main 控制及进程隔离合同通过。没有 worker 被迫终止导致的报告缺项。TypeScript / lint 通过，但后续数量基线及验收证据步骤因测试失败未执行，不声称整套门禁通过；清理仅本轮失败用例遗留进程。
- 独立复验正确原生浏览器夹具：真实用户授权 2000000，在只去掉新增 Stat 的生产基线下断言缺少用户授权，1 failed / 3 skipped，4.39 秒（/tmp/graph-native-user-quota-ui-actual-red.log）；恢复展示后 1 passed / 3 skipped，3.34 秒（/tmp/graph-native-user-quota-ui-actual-green.log）。未保留临时基线文件。
- 读取执行配置发现真实产品缺陷：无模型 ActionAdapter 桥每个 turn 查 kernel_nodes 最新 spec，在当前执行补交时提前采用新任务 / 配方。扩展既有 scripted-lane 实际运行合同，首回合由真实 callback 修改图后拒绝交付，第二回合应仍调用旧适配器；RED 为旧适配器只执行 1 次，预期 2 次（/tmp/graph-native-scripted-frozen-config-red.log）。读取正在执行的 kernel_executions.revision_version，再从不可变 revision 取节点定义，复用稳定 instance_id，移除最新 spec 的 JSON 解析与配方 fallback，不增加新的回调参数或测试 seam。
- 首次修复后唯一夹具失败为最后一次提示已是合法补交 delta，不能再要求 GRAPH OVERVIEW；改为分别记录初始与补交提示，严格要求第二条包含 required output(s) out 且无重复概述。第二次运行仍为旧 task / worker@1，提交一次完成旧 execution；下一条真实 graph_send 才调用 modified / worker@2，节点累计两个 execution。五文件 / 26 用例聚焦通过，11.65 秒（/tmp/graph-native-frozen-config-focus-final.log），新增零用例。该修复在第七十二轮全量之后，当前修订还需系统恢复后的最终完整门禁。完整 spec、旧 SDK / DAG 退役与正式切换仍未完成；所有当前修改尚未提交。

- 用户完成 macOS 重启后继续：独立 shebang 脚本直接启动返回 script-ok；Docker Desktop 原先未启动，按既有授权打开后 /_ping 为 OK。没有关闭系统执行检查服务或修改安全策略，具体停滞根因仍未确认；重启前后的实际启动结果可核对。
- 第七十三轮首次门禁在 TypeScript 发现共用 Operation 类型不声明真实原生 adapter 传入的 recipe；测试改用字段存在判别，仍严格断言 worker@1 / worker@2，未增设生产字段或改变实际运行配置。第七十三轮重跑完整通过：273 文件、1862 用例，159.87 秒（/tmp/graph-v2-full-check-73-rerun.log）；此前 5 个脚本启动失败均恢复通过。TypeScript、lint、自动增加一个预算合同的数量基线、验收证据检查全部通过。自检和 git diff --check 通过；可以提交本组原生政策与执行冻结修复。完整 spec、旧 SDK / DAG 调度器退役及正式切换仍未完成。

## 原生草稿关闭旧式混合结构入口

- 只读检查发现旧 SDK validateLegacyProposal 与 DAG 调度器仍有活跃引用，不能宣布整体退役。本组先关闭实际的新旧混合草稿缺陷：有正式 definition 时，顶层旧 nodes / loops / containers 会被静默忽略，导致所见声明与实际执行结构不一致。NativeProposal 本来只声明 definition，不为额外旧字段推断新协议或编造连接。
- 扩展既有 task-runtime 公开草稿与确认合同，三个旧字段分别测试空数组、null 与非空数组；全部必须以 invalid_proposal 明确指出字段，且 proposalVersion 保持 0，随后纯原生草稿仍能确认。修复前第一次 nodes:[] 实际写入草稿并返回 proposalVersion:1，RED 为 1 failed / 5 skipped（/tmp/graph-native-mixed-proposal-red.log），不是无关协议拒绝。
- validateProposal 的原生入口增加两行拒绝，不增加转换器或另建格式解释路径。手工去掉 confirm-graph / graph-auto-run-e2e / node-prompt-ui / scripted-lane / v2-completion 五个原生夹具的顶层 nodes:[]；定义内部的具名节点及原有验证保留。没有删用例、跳过或增加测试 seam。六文件 / 25 用例聚焦通过，10.01 秒（/tmp/graph-native-mixed-proposal-focus.log），TypeScript 与 git diff --check 通过。生产净增加 2 行、测试净增加 2 行；数量仍为 273 文件 / 1862 用例。第七十四轮完整门禁待执行，旧式单独 SDK 入口与 DAG 调度器仍待最终退役，完整 spec 未完成。

- 第七十四轮完整门禁通过：273 文件、1862 用例，153.75 秒（/tmp/graph-v2-full-check-74.log）。TypeScript、lint、数量基线及验收证据全部通过；自检和 git diff --check 通过。没有删除用例或放宽提交、协议、完成条件。此组只关闭原生混合结构的静默丢失入口，旧 SDK 单独草稿、旧 DAG 调度器、正式切换及整个 spec 仍未完成。


## Git 准入合同迁移到原生接口图

- 保留 git-admission 的十个真实 Git 合同；正式执行夹具改用具名节点、协议和公开输出，确认图后由 main 显式 graph_send 再通过真实 host.drive 运行。确认本身没有创建 execution；脏仓库、空仓库、未知分支与项目子目录的准入边界仍实际验证。
- 删除夹具中的旧 program/check 节点、dependsOn 及伪造 /tmp/ok digest 证据。这里只验证 Git 准入和工作副本隔离，以 human 验收明确表达，不冒充自动交付验收；工作副本修改不会修改项目原文件。没有新增或删除测试，也没有改动生产路径。最初聚焦十用例通过，4.87 秒；最终修改还须完整门禁。旧 SDK / DAG 退役及完整 spec 仍未完成。

- 第七十五轮完整门禁通过：273 文件 / 1862 用例，156.55 秒（/tmp/graph-v2-full-check-75.log）。TypeScript、lint、数量基线及验收证据检查全部通过；自检确认十个准入合同保留，新增显式投递前零 execution 与子目录原文件不变断言。生产修改 0 行；本组是迁移验收入口，旧 SDK / DAG 和完整 spec 仍未完成。


## 最后一项 host check 的真实原生交付合同

- program-check-delivery 原有单用例迁移到原生接口图：真实 Pi worker 写入独立 worktree，另一个实际模型和 review 配方读取集成代码并发布具体 commit 的 graph.review@1；operation 模块通过真实 node 命令检查文件，移除旧 program 节点、dependsOn、route/pass 和编造 digest。
- 保留独立风险：审查已通过、最后的检查尚缺失时，先把检查投递排队，再请求完成关闭外部输入；检查必须继续运行，完成状态、目标分支内容与验收 commit 全部一致。仅用生产 host.pump tick 推进，不调用 host.drive 的附加收尾。最初误用只调旧 DAG 的 runReady 导致 completing；改读生产宿主实现并换为 pump，按可观察 completed 状态有界轮询，不用固定延迟或放宽断言。聚焦 1 用例通过，2.77 秒。没有发现或修改生产缺陷。
- 旧夹具允许目标分支空提交后自动重绑旧证据，这不能代表新规格要求的精确 commit 审查；该旧断言不移植到本合同。Git 目标变动与条件更新基础设施仍由 git-baseline、merge 与 faults 的现有合同保护；原生目标变动后重新审查的完整交付仍须单独核对。数量保持 273 文件 / 1862 用例；完整 spec 和旧 SDK / DAG 退役仍未完成。

- 第七十六轮完整门禁通过：273 文件 / 1862 用例，155.04 秒（/tmp/graph-v2-full-check-76.log）。TypeScript、lint、数量基线与验收证据全部通过；自检和 git diff --check 通过。生产修改 0 行，测试净减少 10 行；没有删用例、跳过或增加测试 seam。旧 SDK / DAG 调度器退役、原生目标变动后的交付核对及完整 spec 仍未完成。


## 原生目标分支变动后的重新审查与交付

- 扩展已有 program-check-delivery 主边界合同为目标不变 / 目标前进两种场景，复用真实 Pi、Git 和检查模块，不引入新的生产 seam。新增一用例独立保护 Git tryDeliver 合并目标后、新 commit 的精确版本验收与 main 恢复路径；已有纯验收判断不能证明这个实际交付生命周期。
- 目标在旧审查后创建空提交，最后检查排队再请求完成。真实宿主 tick 将目标合入集成分支后阻塞；旧 review 和 check 均为 stale，目标仍为 value=1，不误把同内容的旧结论当作新 commit 的审查。完成意图保持关闭外部输入，graph_send 返回 completing；main 显式 withdraw_complete 后重新投递原 reviewer 与检查，所有验收 passed，目标 commit 与验收 commit 一致，最终 value=2。真实 reviewer 六次请求、worker 两次请求证明只复跑审查，没有重做实现。
- 首次夹具误把外部输入拒绝码写成 invalid_graph，实际为明确 completing；依据现有生产协议修正断言，未修改或放宽行为。两用例聚焦通过，4.79 秒（/tmp/graph-native-target-move.log）；本组未发现生产缺陷。完整门禁待执行。旧 SDK / DAG 退役和整个 spec 仍未完成。

- 第七十七轮完整门禁通过：273 文件 / 1863 用例，151.81 秒（/tmp/graph-v2-full-check-77.log）。TypeScript、lint、自动增加一用例的数量基线及验收证据全部通过；自检和 git diff --check 通过。生产修改 0 行，现有测试扩展目标变化合同；原生目标变化后的实际重新审查 / 检查 / 交付路径已核对通过。旧 SDK / DAG 退役、最终切换及完整 spec 仍未完成。


## 退役旧 DAG 专属 strandedNodes 诊断接口

- 删除前只读审阅 tests/console/stranded-nodes.test.ts 完整两用例、Execution.runReady/strandedNodes/drive、SDK 转发及全仓引用；历史 5900d47 为 HB-185 引入一轮 runReady 后的 DAG pending/readiness 诊断，后续 6c4cca4/cbb6710 迁移没有消除旧路径。两个用例分别是 a single runReady pass reports the node it left stranded 与 the guard names a node that IS stranded, so a silent hang cannot pass unnoticed；后者直接改旧 nodes 表再断言 readiness 推断，不能验证接口投递。
- 非测试引用只有 TaskRuntime.host 的转发，无生产调用；删除清单为 Execution.strandedNodes、host.strandedNodes 和该旧测试文件，不删除仍有活跃调用的 runReady / DAG 调度器。风险为删除旧 SDK 诊断方法，符合 ADR0030 的旧内核退役决定，无用户运行入口依赖。
- 保留的更强主边界证据为 chain-depth 的真实 Pi 两级 / 三级接口链：确认不启动、main 显式投递、每节点唯一 execution、实际 prompt 含上游 value、全部 queue done 和最终公开输出正确；program-check-delivery 另保护生产 pump tick 的真正交付。无需新增替代诊断或测试 seam。聚焦链、实际 host tick 交付与 scripted-lane 后运行完整门禁；明确审计数量下降两用例 / 一文件，不为全绿删除失败测试。完整 spec 和旧 SDK / DAG 整体退役仍未完成。

- 聚焦首次误用系统 Node 26.3.0：chain-depth 两用例节点 failed、另外三用例通过（/tmp/graph-retire-stranded-focus.log），失败根因未确认，未删除失败链测试或放宽断言。改用仓库固定 Node 24.20.0 运行相同三文件 / 五用例全部通过，4.98 秒（/tmp/graph-retire-stranded-node24.log）。生产净删 29 行，旧测试删 95 行；预期全量为 272 文件 / 1861 用例，明确 GRAPH_UPDATE_BASELINE=1 记录经审计的减少。

- 第七十八轮完整门禁通过：272 文件 / 1861 用例，154.65 秒（/tmp/graph-v2-full-check-78.log）。TypeScript、lint、明确审计降低的数量基线和验收证据全部通过；固定运行时下链合同也全量通过。自检与 git diff --check 通过；src/tests 中旧诊断名已无引用。仅退役无生产调用的旧诊断接口，不声称旧 SDK / DAG 或完整 spec 已完成。


## 原生常驻 Pi 节点补齐受控网络检索

- 从旧 SDK 迁移 retrieval 的七个真实 Pi 合同，去掉 dependsOn、旧独立 program 节点和编造 digest；通过具名输入显式启动，网络授权等原合同不删不放宽。RED 为五个合同失败，实际模型收到 Tool fetch not found（/tmp/graph-native-retrieval.log），证明旧路径覆盖掩盖了新节点漏配检索能力。
- TaskRuntime 将网络授权传入原生 lane；节点装配绑定已有 createRetrievalBroker 的 fetch，用既有 agentTools 创建声明与工具执行，不新增并行检索实现。按授权域名或 unrestricted 决定暴露工具，session 配置签名包含网络授权；宿主在真实 running execution 下检查图 / 节点暂停、停止、有限预算与未核对用量。检索由宿主执行，拒绝重定向 / 非文本 / 未授权域名；零 token 用量以真实 graph.retrieval.started/settled 事件记录，不伪造成模型 provider call 或污染独立审查身份。
- 修复后六项通过，剩余夹具把旧工具响应的单层转义当合同；改为解析实际工具结果，严格匹配 status=200 和正文。最终七用例通过，17.82 秒（/tmp/graph-native-retrieval-final.log）。暂停场景真实 provider beforeReply 后暂停，服务器零访问；未授权域名零检索结算；无授权工具不暴露。没有增删用例、跳过或新测试 seam。完整门禁待执行，旧 SDK / DAG 仍待整体退役，完整 spec 未完成。

- 第七十九轮首次完整门禁在 TypeScript 发现 NodeStateRow 未暴露 used；改为读取 kernel_node_state 的实际 used/paused，不用扩充接口或绕过预算。重跑：270 文件 / 1858 用例通过，2 文件 / 3 用例失败，合计 272 文件 / 1861 用例，177.94 秒（/tmp/graph-v2-full-check-79-rerun.log）。原生检索合同通过；失败仅 peer npm 两项脚本启动超时和 pre-push stub 超时。TypeScript / lint 通过，测试未全绿，后续基线 / 验收证据步骤未执行，当前修改不得声称完整门禁通过且未提交。
- 独立 Node24 最小 shebang probe 再次证明直接执行脚本 ETIMEDOUT，显式 /bin/sh 脚本及 /bin/sh -c 正常退出；Docker info 正常，不能把此问题归因于 Docker。与此前系统启动停滞现象一致，确切系统根因仍未知；未更改系统安全策略、未删除失败合同或放宽断言。保留当前未提交修复继续推进目标，系统门禁恢复与旧 SDK / DAG 整体退役仍待完成。


## 原生能力命令 / shell 装配及宿主准入

- 迁移 workspace-command 的实际 Pi / sandbox 合同及 plain-directory host check：移除两个旧草稿 / program 节点 / dependsOn 和伪造 check digest，按真实具名输入启动 worker 或 operation 模块。plain check 必须在集成 worktree 生成证明文件且 operation settled，不将会修改树的测试伪称为 clean commit 验收。保留 Git 元数据与路径拒绝、完整访问、Electron Node 模式及 loopback 等既有合同。
- RED 为原生 bash 未装配，实际工具结果 Tool bash not found（/tmp/graph-native-command-red.log），不是文件系统测试偶然未写入。nodeSessionRequest 以能力库的 disabledTools 配置启用 Pi 原生 bash；保留现有 Graph 文件工具，最小新增 shell 职责。
- 检索与能力层复用 kernelToolGate：从真实 running execution / kernel_node_state / provider calls 判断暂停、停止、有限预算、未核对用量与占位；工具开始 / 零用量结算独立于 provider 账本。原生本地 bash 通过 Pi beforeToolCall / afterToolCall 接宿主准入 IPC，宿主验证声明工具与唯一准入，拒绝结果返回模型；工作目录权限仍由现有 OS 沙箱承担。生产需要的接口回调不为测试专设。
- 两文件 16 项既有合同聚焦通过，17.88 秒（/tmp/graph-native-tools-fixed.log）。新增一个真实暂停竞争合同：模型 response 回调暂停后返回 bash 写文件，文件必须不存在、无工具结算且仅一次模型请求。正确代码通过 12.57 秒；临时去掉宿主 beforeNativeTool 准入后负控失败，文件实际被写入（/tmp/graph-native-shell-pause-negative.log），12.47 秒，证明不是工具缺失或模型拒发造成的假通过；已恢复生产代码。TypeScript 聚焦通过。新增一项独立本地 native tool / IPC 行为，不重复检索权限检查，预期全量 272 文件 / 1862 用例。完整门禁与旧 SDK / DAG 整体退役仍待完成，本组和之前检索修复未提交。

- 第八十轮完整门禁：271 文件 / 1861 用例通过、1 文件 / 1 用例失败，共 272 文件 / 1862 用例，151.09 秒（/tmp/graph-v2-full-check-80.log）。失败仅 conversation-pi 原生 worker 的过时工具清单期望 run_command；实际按既有 selectAgentToolSurface 规则由已启用 bash 替代，主流程执行成功。改该原生清单断言为 bash，保留 read/write_file/submit 及实际结果验证。此前 peer npm / pre-push 超时本轮均恢复，未更改系统策略、未删失败用例，原因仍未确认。当前仍需完整重跑，不据单次恢复推断系统根因。

- 第八十轮重跑完整通过：272 文件 / 1862 用例，168.13 秒（/tmp/graph-v2-full-check-80-rerun.log）。TypeScript、lint、自动增加一项本地 native tool 准入合同的数量基线及验收证据全部通过；此前系统脚本超时本轮也通过。自检与 git diff --check 通过，临时负控已经恢复。检索 / 工作目录命令旧草稿已移除；原生 shell 与检索按宿主准入真实运行，工具零用量不冒充模型 provider 记录。旧 SDK / DAG 整体退役、正式切换和完整 spec 仍未完成。


## 关闭 SDK 旧图创建与修订执行入口（整体切换进行中）

- 当前目标要求整体退役，不能继续以旧 SDK 正常创建 DAG 为最终状态。只读确认正式 propose_graph 已原生，但 SDK validator、user.accept / conversations.confirm 仍有旧创建分支。扩展既有 public SDK invalid-proposal 合同要求拒绝无 definition 的旧草稿，RED 为旧草稿返回成功 proposal receipt（/tmp/graph-sdk-cutover-red.log）；关闭入口后同一合同 GREEN，1.60 秒（/tmp/graph-sdk-cutover-green.log）。
- 删除 validateLegacyProposal 及其 GraphPlan/verifier/context/predecessor 校验导入；validator 要求原生 definition 并继续严格拒绝顶层 nodes/loops/containers。两个确认入口重新校验持久草稿且只 materializeGraph，不再插入旧 graph_revisions/nodes/activations。移除 SDK revise 的 applyRevision 依赖、旧隐式目标推断和修订实现，明确拒绝并指向 graph_patch。当前仍留历史类型与拒绝方法签名待调用面迁移，旧 DAG 执行代码 / 存储与旧历史清理还未删除，不宣布最终切换。
- simple-tier 合同改为 main 在图外派生原生 graph，具名协议边传递完整结构化结果，graph 公开输出送回 main，空闲与显式完成分离。确认每节点唯一 execution、四次真实 Pi 请求、队列均 done、main 原会话保持 discussing；graph 完成后拒绝新投递，历史节点输出仍可查看。删除旧 fake program/check、submit_result、predecessorHandoffs 和直接旧 operations 表计数。最初失败为不可变投递 JSON 按 canonical 顺序写入，与夹具字段顺序不同；使用同一公开 canonical 格式核对传入值，不放宽内容。三文件 / 五用例原生链、实际 Git 交付与 simple tier 聚焦通过，5.62 秒（/tmp/graph-sdk-cutover-native-focus.log）。
- 当前 TypeScript 报三个过时成功修订断言（m2/revision 两处、m4/command-check 一处）访问 Promise<never> 的 graphVersion；旧 SDK revise 已不可成功，不伪造返回类型迁就测试。需迁移或审计退役这些合同，以及其余创建旧草稿的调用测试；临时测试不全绿是这次整体切换的中间状态，不回滚成并存方案或删除未审阅失败。当前未提交，完整门禁与完整 spec 未完成。

- 第八十一轮 node --run check 在上述三个旧修订断言的 TypeScript 错误处停止（/tmp/graph-v2-full-check-81.log），未进入后续门禁。另行全量运行诊断得到 222 文件 / 1684 用例通过，50 文件 / 178 用例失败，107.26 秒（/tmp/graph-sdk-cutover-suite.log 与 /tmp/graph-sdk-cutover-suite.json）：169 项直接旧草稿拒绝，6 项过时断言内包装同一拒绝，3 项原生 MediaBookmarks 用例因诊断命令未设置 GRAPH_MEDIABOOKMARKS_ROOT 的夹具路径错误。不能把最后三项计作内核失败或原生验证通过；后续正规门禁需带正确根路径。测试数量未降低，未删除未审阅失败。失败文件与分类保存在 /tmp/graph-sdk-cutover-failures.json；当前生产净删 122 行，simple-tier 测试净删 34 行并保留一个真实运行合同，工作树未提交。整体旧图历史、DAG 执行代码与类型退出仍待完成。

### 修订边界迁移审计（2026-10-08，进行中）

- `tests/m2/revision.test.ts` 四项旧 SDK 修订契约迁移至公开 `graphPatch`：保留过期版本与实例身份、验收不可削弱、待处理输入不可借删除丢弃、显式 retire。旧“完成后重新运行图”不再保留，改为验证终态不可修改；旧 optional/multiview/replaces 是已废弃 DAG 语义。预算与真实模型历史的独立证明保留在 `kernel-node-budget.test.ts` / `kernel-model-history.test.ts`，不以新实例抹去旧账本。
- `tests/m4/check-input-revision.test.ts` 两项 HB-26 用例原先直接伪造 SQLite evidence；原生公开接口应在检查运行前后都禁止弱化验收检查配置，使用真实宿主命令证明运行后的状态。历史来源 `1b9748d` / `32a8f64`，旧“未产出证据可改 input”例外属于被替代的修订器。
- `src/core/revision.ts` 原生产调用已从 Task Runtime 退出，唯一剩余调用是上述 HB-26 测试；完成迁移后删除该模块（不保留测试专用路径）。风险：原生模块配置未冻结，需先获得公开接口失败证据再修复。聚焦验证：revision、check-input-revision、graph-runtime、scripted-lane、kernel-model-history。

- 原生修订缺陷的 RED：声明验收检查在首次执行前、真实宿主执行后，都能把断言命令改成 --version 并成功生成 revision 2（/tmp/graph-native-check-freeze-red2.log，2 项失败）。GraphRuntime.patch 现在在写修订前冻结验收引用模块的 operation 配置；合法图名修改仍通过。`check-input-revision` 不再伪造 SQL evidence，真实宿主命令在干净 Git checkout 运行。
- 四项 native revision 合同暴露退休节点的历史查询错误：数据库保留节点，但 kernel.listNodes 只列当前修订，nodeRun/nodePrompt 因而报 Unknown node。两个查询改从该 graph/node 的持久记录读取；活跃结构仍只含当前节点。历史、原实例、执行记录、聊天记录与 prompt 可读，退休节点新聊天被拒绝。旧 revision.ts 154 行已经删除，无残留导入。五文件 / 38 用例通过，3.97 秒（/tmp/graph-native-revision-focus3.log）。
- `m4/command-check` 全部 12 项合同迁移至具名接口与宿主 operation 模块，使用真实集成 commit / 模块结果记录，不再依赖旧 check node 或 evidence 表。保留失败命令、禁止命令、TMPDIR、loopback/非 loopback/子进程防绕过、并发固定端口与取消、宿主依赖与环境、项目依赖、动态 probe、打包 Node runtime 合同。RED 为缺少 localNetwork、宿主 program 配置及依赖链接（另两项是验收数组包含独立审查约束，改为查指定验收项而非假设无其他约束）；宿主原生 broker 复用现有依赖链接及工作目录执行器，主 Runtime → lane → broker 传递宿主授权配置，不由 graph 输入扩大权限。四文件 / 20 用例通过，7.42 秒（/tmp/graph-native-command-migration-green.log）。
- `confirm-graph` W6 按原注释要求随切换改为拒绝旧草稿，确认不会产生 feature、旧 graph revision 或 native graph owner；其余原生确认、模块隔离、最终验收和有限预算同完整门禁验证。
- 第八十二轮正规完整门禁已运行（设置真实 GRAPH_MEDIABOOKMARKS_ROOT）：TypeScript / lint 通过；229 文件 / 1705 用例通过，43 文件 / 157 用例失败，仍共 272 文件 / 1862 用例，106.31 秒（/tmp/graph-v2-full-check-82.log）。155 项失败信息含原生 definition 必需拒绝；另两项为 design-examples 文档旧图被拒绝、m3/planning 旧草稿未产生 receipt，均仍待迁移。前轮三个 MediaBookmarks 路径问题本轮不再出现，真实原生交付验证通过。失败详细清单 /tmp/graph-sdk-cutover-failures82.json。门禁仍红，所以不提交、不降低基线；旧 SDK 类型、执行器、历史与剩余调用迁移继续进行。完整 spec 尚未交付。


### 原生配方、生产调用与控制台合同迁移（2026-10-08，进行中）

- `m3/planning` 两项合同改为完整原生草稿、显式输入与显式完成，保留用户私聊不复制到 worker、任务与验收进入首轮 briefing、独立功能队列不改变原范围。真实宿主检查与人工验收完成后才释放确认队列。新内核原先清空工作后仍保持 running；GraphLane 现在在无完成请求且已清空时记录 idle，下次调度恢复 running。确认前/尚未收到输入的任务 phase 仍需整体生命周期审计。原生 task view 不再把旧表中的 main 显示成内部节点。
- `docs/design-graph-examples.md` 删除 dependsOn/旧 verifier/program node 示例，给出可直接 graph_create 的三份原生定义。两个文档合同从公共创建接口验证全部 JSON，并实际运行返工路由、双输入一次汇合、保留通过状态和显式重开后的下一次输入；不声称示例已经交付真实项目。五文件 / 40 用例通过（/tmp/graph-native-main-doc-focus.log）。
- `m3/catalog` 原先使用无服务端 endpoint 与伪造计量；现在用两个真实本地服务验证不同模型、精确配方版本及显式升级。RED 显示 coder@1 在已发布 coder@2 后被错误判成不存在（/tmp/graph-native-catalog-diagnostic.log）。listDefinitions 只列最新版，不能用于精确版本判断；Catalog.hasDefinition 查询指定版本，节点宿主、prompt 组装和 Git 审查身份三个生产调用共同修复。三文件 / 10 用例通过（/tmp/graph-native-catalog-fixed.log），既有版本不会隐式升级。
- `m3/models` 四项合同迁移至实际 Pi 调用：实例/会话/真实账本跨重启保持；审查排除实现模型；无独立模型时原输入排队、节点 blocked，重启不丢失且不发送；缺失模型从配置候选切换。`m3/capabilities` 保留真实扩展的工作副本内写入和外部拒绝，工具遥测读取实际 settled 事件，模型记录不再混入零 token 工具调用。`m3/production` 迁移未知用量幂等核对与不可变 graph.review@1 发布；发布 fixture 漏 requestId 已修正。三文件 / 17 用例通过（/tmp/graph-native-model-capability-green.log）。
- `m8/provider-headers` 三个旧派发合同改成原生草稿确认后显式聊天，保留真实 daemon 配置、私有凭据、自定义 header、OpenCode routing header 与缺失凭据不影响其他模型。`m8/credentials` 两项改为原生图，删除伪造 digest/check；不同 endpoint 各取自己密钥，无凭据时真实请求数为零，失败原因记录在 graph.node.failed。`m8/node-prompt` 使用原生节点，HTTP 面板与实际 provider system prompt 逐字相同、briefing 与真实 session 首条消息相同；模块没有 Agent prompt，返回 not_found。`conversation-readonly` 的确认 worker 保留绑定扩展和隔离工作副本，但等待显式输入才执行。
- `m8/tool-failure-record` 迁移暴露真实缺陷：失败读取的 result 内容含 ENOENT/isError:true，事件却记录 isError:false（/tmp/graph-native-tool-failure-diagnostic.log）。核对当前 Pi agent-loop 的 executePreparedToolCall：正常返回总是成功，仅捕获工具异常才标记失败。resident-worker 对宿主拒绝抛工具异常，Pi 将其转成可继续当前会话的失败结果；原生 lane 同时保存有界可读失败说明和 machine-readable message。没有结束整轮或重试成功提交。六文件 / 20 用例通过（/tmp/graph-native-tool-failure-fixed.log）；另八文件 / 31 用例覆盖真实常驻进程、transport、能力与生产调用（/tmp/graph-native-resident-contracts.log）。
- 第八十三轮门禁先在 TypeScript 阶段发现 optional briefing 赋值，已修正。第八十四轮 TypeScript/lint 通过，234 文件 / 1715 用例通过，38 文件 / 147 用例失败（111.03 秒）：146 旧 DAG 调用、1 个已清空下游仍期待 running 的旧断言，改为 idle。第八十五轮 TypeScript/lint 通过，240 文件 / 1724 用例通过，32 文件 / 138 用例失败（112.16 秒），失败均仍由旧草稿拒绝引起；两轮总量均为 272 文件 / 1862 用例。日志 /tmp/graph-v2-full-check-84.log 与 /tmp/graph-v2-full-check-85.log。
- `m5/http` 三项旧合同使用原生定义、真实宿主检查和明确完成请求，删除伪造 evidence。暂停中通过受控执行等待确定，不靠 sleep；人工验收声明在配置中，回答一项仍保留其他 open question。RED 发现已请求暂停但原生 Agent 仍运行时 HTTP 提前显示 paused（/tmp/graph-native-http-pause-red2.log）。kernelHasActiveWork 从实际运行 execution / 宿主 worker_active 读取状态，任务详情与紧凑状态查询共用，正在结束时显示 pausing。`m8/concurrency` 迁移真实 credential slot 排队/暂停，证明没有 provider 请求、没有用量且 worker 已停。四文件 / 50 用例通过（/tmp/graph-native-http-pause-fixed.log）。
- 本批测试数量保持不变，所有日志是本地验证，未构造交付证据、未删未审阅失败。旧 SDK 类型、DAG 调度器与历史退役仍未完成；全量门禁仍红，不提交、不宣布完整 spec 已交付。

- 第八十六轮正规门禁 TypeScript/lint 通过，242 文件 / 1728 用例通过，30 文件 / 134 用例失败，仍共 272 文件 / 1862 用例，115.91 秒（/tmp/graph-v2-full-check-86.log）。失败均由已退役旧 DAG 草稿拒绝引起，清单 /tmp/graph-sdk-cutover-failures86.json；所有真实 MediaBookmarks 用例通过。未提交。
- `conversation-capability-access` 两项旧 worker 用例迁移：标准权限通过配方中声明的只读 source-reader capability 读取 Graph package 内容，不给所有 worker 添加隐式源码目录权限；真实工具返回的 JSON 内容被解析后核对包身份。旧“每次派发跟随最新 recipe”改为精确版本不隐式升级、公开 patch 显式重绑。两个独立 worker 都实际调用 MCP；升级后的下一轮移除该 MCP，原实例与 transcript 保留。ADR 0011 明确要求 bundle digest 变化时 branch 到新 session ID，测试核对旧会话文件仍可读且新请求含旧聊天，不错误要求配置重绑时继续原 ID。三个文件 / 18 用例通过（/tmp/graph-native-capability-rebind-green.log）。

- 第八十七轮在 TypeScript 阶段发现节点投影 union 的直接字段读取，测试改用公开对象形状断言，不放宽生产类型。第八十八轮 TypeScript/lint 通过，243 文件 / 1730 用例通过，29 文件 / 132 用例失败，仍共 272 文件 / 1862 用例，117.00 秒（/tmp/graph-v2-full-check-88.log）。132 项仍全部由旧 DAG 草稿拒绝引起，清单 /tmp/graph-sdk-cutover-failures88.json。与第八十二轮相比，已迁移并验证 25 个此前失败合同，未减少测试数量。当前累计未提交变更 36 文件，文档记录真实局限；门禁仍红，整体旧内核与完整 spec 未完成，不提交。后续优先迁移 m1 执行/恢复和 m2 图/验证合同，再取消旧 main foundation 对 DAG 调度器的依赖；不得恢复兼容转换器来通过门禁。

- `m1/recovery` 四项旧恢复合同改为原生 graph、真实常驻 Pi 和真实 HTTP 服务；父进程在公开发送状态及服务端实际收到请求后 SIGKILL 宿主，不注入 operation/provider receipt。验证未提交输入保留原 execution、实例、历史和累计预算，显式核对未知用量后恢复；成功 submit 的输出保持不可变、原输入禁止重试；full access 不抹去未知账目或自动重发。连同既有跨进程 owner lock 共 5 项通过（/tmp/graph-native-hard-recovery-fixed.log）。
- 真实硬崩溃 RED 暴露 token reservation 泄漏：第二轮等待 credential 时宿主被杀，恢复留住 200000 预留，重跑再预留并仅释放一次，执行成功仍残留 200000（/tmp/graph-native-hard-recovery.log）。kernel recovery 在原子恢复事务内，仅对该 execution 没有 inflight/unknown provider call 的未用 turn hold 释放；有不明调用仍保留预留、暂停和原输入，需核对后恢复。已知 usage 与尝试计数不清零。
- 第八十九轮 TypeScript 发现测试直接读取新旧 nodeRun union 的 reserved 字段，改为公开形状断言与窄化，未放宽生产类型。第九十轮 TypeScript/lint 通过，244 文件 / 1734 用例通过、28 文件 / 128 用例失败，272 文件 / 1862 用例总量保持不变，116.70 秒（/tmp/graph-v2-full-check-90.log）。恢复合同全部通过，剩余失败仍需迁移旧 DAG 调用；整体退役未完成，未提交。
- `m1/scheduling` 两项旧合同迁移，删除内嵌 master / 旧 DAG 和 fake check/digest。真实 Pi/HTTP 验证图外 main 与 11 个原生 worker 共用十个执行名额：main 正忙时 9 个 worker，main 结束后 10 个 worker；main 后续用户消息满额时不发送，容量释放后保留实例与原聊天继续。最终验收用真实宿主命令检查加 human criterion，显式完成等待人工确认，确认后第二个功能任务解除排队；重启后完成状态、活动任务与 task.started 事件游标保持。复验恢复、调度、节点预算四文件 / 20 用例通过（/tmp/graph-native-recovery-scheduling-final.log，9.68 秒），未减少原测试数量。
- 第九十一轮 TypeScript/lint 通过，244 文件 / 1735 用例通过、28 文件 / 127 用例失败，116.59 秒。其中 126 项是旧 DAG 草稿，新增的真实并发测试有一处主 Pi 冷启动超出默认 1 秒 poll 上限；单独运行成功，不更改并发断言或加入固定 sleep，改为显式 15 秒上限等待真实 HTTP 请求边界。第九十二轮 TypeScript/lint 通过，245 文件 / 1736 用例通过、27 文件 / 126 用例失败，272 文件 / 1862 用例总量不变，116.74 秒（/tmp/graph-v2-full-check-92.log）。126 项全部为旧 DAG definition 缺失拒绝，清单 /tmp/graph-sdk-cutover-failures92.json；本批恢复、调度和真实 MediaBookmarks 测试均通过。门禁仍红，未提交。后续仍需迁移 m1 execution、m2 图/循环/验证与模板；原生模块未完整接替旧 verifier 的连续无进展状态，不能仅转换夹具或删除断言来宣称退役。

### 原生执行器账目与模块暂停边界（2026-10-08，进行中）

- `m1/execution` 六项旧合同迁移至真实 Pi/HTTP、原生 definition 和公开管理接口，保留文件内 20 项总量。成功发布 Markdown 稳定版本并 submit 后，暂停使下游检查保留未发送状态；重启执行真实 host command 后显式完成，worker 身份、用量、公开结果与产物原版本不变。未知用量保留 hold，核对幂等且不自动恢复；原输入复跑与随后聊天各自串行执行。缺少 usage 或非法负数不能当作零放行，冲突 late reconciliation 不改写已结算账目。累计预算跨重启保留，用户 setBudget 幂等且按节点授权，旧 execution 保持冻结额度，显式 retry 产生新 execution 才采用新额度。实际用量超过 turn reservation 在累计额度内继续，跨重启不重复记账；这是已生效的真实 provider 合同，替换旧 reservation_exceeded 人工确认语义。
- RED /tmp/graph-native-execution-focus.log 暴露原生模块暂停缺陷：worker 有效 submit 后、最后回复仍在途时暂停，runner 已准备的下游 host check 在发送前被拒绝，却写成 failed 并暂停模块。修复 GraphRunner 在逐投递/恢复 outbox 前检查暂停，paused 拒绝不作为 module defect；operation broker 仅对 state=prepared 且 RuntimeError paused 保留预发送记录，已发送的不明副作用仍保持 uncertain。回归在正式确认图上重启，未发送输入能继续、同一 prepared operation 能真实 settled、worker 不再发送。没有制造 evidence/digest 或调用旧 host.report。
- 六项原生 focused 合同通过（/tmp/graph-native-execution-six.log，5.23 秒；其余 14 项仍是待迁移旧合同，focused 的跳过不视为门禁通过）。TypeScript 两项目通过（/tmp/graph-native-execution-typecheck.log）。整体旧内核退役与完整 spec 仍未完成，未提交。
- 相邻模块/宿主命令/恢复/调度六文件 49 用例通过（/tmp/graph-native-module-pause-contracts.log，10.69 秒）。第九十三轮 TypeScript/lint 通过，245 文件 / 1741 用例通过、27 文件 / 121 用例失败，119.83 秒；120 项仍为旧 DAG，另 1 项为新测试时序假设：submit 立即激活下游，真实 host check 可能在暂停前已发送并完成，不能强制仅观察 prepared。断言改用真实 task.paused 事件时间，允许暂停前已发送的 settled 记录，拒绝 failed/uncertain 与暂停后 started；prepared 必须无 started_at、worker_active=0。恢复继续同一 operation（如已准备）而不重跑 worker。六项 focused 合同再通过（/tmp/graph-native-execution-six-final.log，5.30 秒）；不把 focused 跳过当成全绿。
- 第九十四轮 TypeScript/lint 通过，244 文件 / 1740 用例通过、28 文件 / 122 用例失败，128.17 秒；其中 120 项旧 DAG、1 项原生 worker/check 暂停超时、1 项既有 hot-config 清理 ENOTEMPTY。暂停超时不能归为测试负载：waitForKernelProgramExecutionSlot 在 graph 已暂停时返回 false 并持续等待，而 drive 也等待该 module，形成死锁。发送前 slot wait 现在抛 paused 控制异常，由 broker 保留 prepared，再由 runner 保留输入退出；暂停前已 dispatched 的工作仍排空。六项 focused 再通过（/tmp/graph-native-execution-slot-pause-fixed.log，5.39 秒），正复验包含 hot-config 的相邻合同并再跑完整门禁。未提高 30 秒测试上限掩盖死锁。
- 修复程序名额发送前暂停死锁后，包含 hot-config 的相邻六文件 51 用例通过（/tmp/graph-native-slot-pause-siblings.log，11.55 秒）。第九十五轮 TypeScript/lint 通过，245 文件 / 1742 用例通过、27 文件 / 120 用例失败，总量 272 文件 / 1862 用例，117.28 秒（/tmp/graph-v2-full-check-95.log）。120 项全部由旧 DAG definition 缺失拒绝引起，清单 /tmp/graph-sdk-cutover-failures95.json；本批六项原生合同与既有 hot-config 全部通过，未抹掉失败、未提高超时。单独执行 check:baseline 与 check:evidence 均通过，接受证据未变。全量测试仍红，未提交；后续先完成剩余 m1 execution 的权限、失败/等待和回调合同迁移，再删除 DAG 调度器及旧 main foundation 依赖，完整 spec 审计仍待完成。

### 宿主工具预算与普通暂停恢复（2026-10-08，进行中）

- `m1/execution` 再迁移四项合同：真实凭据排队与在途回复暂停、提交成功但用量未知时下游只收到一次结果、full access 仍受有限额度/未知用量/暂停约束、额度耗尽后零预留文件工具被拒绝且重启不恢复额度。文件仍共 20 项；未知用量核对使用实际 provider call，不以 proof 字符串或 SQL 制造收据。业务 submit 的已提交输出不可撤回，原输入显式 retry 被拒绝。
- 额度 RED：真实 Pi 收到已耗尽 2000 万额度的模型回复后仍通过宿主 `write_file` 写出 unauthorized.txt（/tmp/graph-native-execution-ten.log）。原生 shell/extension 已有 gate，但解析出的宿主工具直接 execute。宿主工具现在先经过同一运行状态与预算 gate，再执行和结算工具事件；submit 的业务投递入口保留独立职责。修复后文件不存在，重启也无新模型请求。
- 普通暂停 RED：原测试用 main 显式 retry 掩盖了暂停误记失败。移除该操作后恢复没有 HTTP 请求，30 秒失败（/tmp/graph-native-pause-red.log）。执行器对无提交、已知用量且 graph/node 确实暂停的 paused 返回保留原 execution 和排队输入，不消耗自动重试，不产生失败事件；恢复自动继续。未知用量先进入核对分支，提交后的错误仍保留提交且不重放。
- 十项原生执行合同通过（/tmp/graph-native-execution-resume.log；该过滤还匹配了三项未迁移的旧 grant 合同，它们仍因缺少原生 definition 失败，另七项跳过）。相邻八文件 / 47 项全部通过（/tmp/graph-native-tool-admission-siblings.log，18.87 秒），包含真实 MCP/能力、有限预算、并发、工具失败、恢复和调度。第九十六轮完整门禁正在运行；尚未宣称全绿或完整交付，未提交。
- 第九十六轮 TypeScript/lint 通过；245 文件 / 1745 用例通过、27 文件 / 117 用例失败，272 文件 / 1862 用例总量不变，129.44 秒。116 项旧 DAG 拒绝，另 1 项原生凭据暂停仍误记 failed，清单 /tmp/graph-sdk-cutover-failures96.json。不能把该差异归为负载抖动：增加原生节点状态断言后，单项也稳定复现。真实 graph.node.failed 事件显示原因为 Connection error.（/tmp/graph-native-pause-cause.log），自动重试两次、实际模型请求零次。
- 宿主 gate 的 RuntimeError paused 被 provider SDK 包装为连接错误。原生宿主现在在发送 gate 记录 paused/budget 拒绝，并在错误 settlement 中保留原始原因；真实网络失败和未知用量保持原处理。执行器的暂停分支因此可用；回归同时检查原输入仍 queued、execution blocked 且 retriesUsed=0，普通 resume 自动发送后在途回复排空。移除临时 SQL 诊断。十项原生合同通过（/tmp/graph-native-execution-refusal-fixed.log，8.89 秒），第九十七轮完整门禁正在运行。
- 第九十七轮 TypeScript/lint 通过；245 文件 / 1746 用例通过、27 文件 / 116 用例失败，总量保持 272 文件 / 1862 用例，126.02 秒（/tmp/graph-v2-full-check-97.log）。116 项全部为旧 DAG definition 缺失拒绝，清单 /tmp/graph-sdk-cutover-failures97.json；原生暂停恢复与额度耗尽工具拒绝均通过全量。check:baseline、check:evidence 与 git diff --check 通过，证据未变。门禁仍红，未提交；接续迁移剩余 m1 失败/等待/权限合同及 m2 图、循环、模板、旧 main foundation，之后才可完成旧调度器删除与完整 spec 审计。
- 再迁移原 prepare/dispatch 两项失败恢复合同，不再由 ActionAdapter.reconcile 伪造 not_started 收据。prepare 使用实际不可解析凭据，零 provider call、failed 输入和节点队列跨重启保留，修复凭据本身不清掉失败，main 显式 retry 后原任务与后续聊天各执行一次。dispatch 使用真实 HTTP 500 / usage:null，第一次发送不明用量保持 hold；重启和单独 resume 均不重发，main 给出实际 call 用量核对后仍需显式 resume。两条路径保持同一实例，累计用量分别 100/150，最终两个输入均 done。初次 fixture 保留 apiKey fallback 导致缺少凭据场景实际上成功，按真实凭据解析规则移除该场景的 fallback 后验证通过，无生产修改。
- 十二项原生执行合同通过（/tmp/graph-native-execution-failures-fixed-fixture.log，10.13 秒；另外八项 focused 跳过不视为门禁通过）。`m1/execution` 总量仍为 20 项，其中六项旧合同仍待迁移、两项旧 main soft-stop 合同尚需随外部 main cutover 迁移。第九十八轮完整门禁正在运行。
- 第九十八轮 TypeScript/lint 通过；245 文件 / 1748 用例通过、27 文件 / 114 用例失败，总量 272 文件 / 1862 用例，124.82 秒（/tmp/graph-v2-full-check-98.log）。114 项全部为旧 DAG definition 缺失拒绝，清单 /tmp/graph-sdk-cutover-failures98.json；十二项原生执行合同和真实 Pi/Git/能力/预算相邻合同通过全量。单独 check:baseline、check:evidence 通过，验收证据未变。当前完整门禁仍红，未提交；下一批保留六项旧等待/权限/验收合同的实际行为，继续完成 m2 模板与 verifier 的原生替换，然后清除旧 main foundation 和 DAG 调度依赖。完整 spec、默认应用交付和可视化验收仍未完成。

### 原生权限快照、等待和宿主验收合同（2026-10-08，进行中）

- 上一目标轮为实际进展：修复暂停/工具预算，完成六项真实执行迁移，完整门禁旧 DAG 失败从 120 降至 114；本轮继续完整退役，不缩小目标。
- 三项旧 per-tool grant 合同要求 `artifact:write` / `mcp:remote:echo` 再次审批，已被接受的 ADR 0021 替代。重写为真实外部文件权限边界的三组策略转换：standard→full（执行后修改）、full→standard（模型请求途中修改）、standard→full（模型请求途中修改）。当前执行沿用冻结策略，下一次执行采用新策略；standard 实际写外部路径失败、full 实际写成功。策略修改不解除手动暂停，跨重启队列仍暂停，显式 resume 才执行下一输入；同实例和 200 累计 token 保留。绑定能力正常调用的独立证据仍在 m3/capabilities / conversation-capability-access，不复活重复 grant 审批。
- 两项旧 waiting/unknown_usage 合同迁移到真实 Pi `send_to_peer`→外部 main 的持久会话消息。澄清请求/稳定 Markdown 发布发生后，后续未知用量核对不删除或重复请求，不解除 main 显式节点暂停；恢复后回答作为另一输入排队并沿用历史。重启核对保留产物版本、摘要、作者和实际内容，只追加访问审计。旧 ActionAdapter outcome=waiting 与 proof 字符串放行不保留；等待是明确的业务消息与运行控制，而不是额外结果格式。
- 原“program 声称 passed 却没有证据”合同迁移到原生宿主验收：agent 真实 submit 的业务 `{passed:true}` 不等于声明 host check 的执行记录。未运行 host check 时完成请求 blocked/acceptance missing；撤销完成请求后投递具名模块输入，执行真实 node --version，核实 settled 记录和通过判断，再显式完成。未伪造 evidence 表或宿主收据。
- 删除 `m1/execution` 最后一个旧图构建 helper，文件仍 20 项：18 项原生执行合同全部通过，另外两项 main soft-stop 仍由旧 main foundation 驱动，待随外部 main cutover 迁移。完整五文件 / 28 项通过（/tmp/graph-native-execution-contracts-final.log，14.73 秒），含真实聊天、产物所有权、最终 Git 验收、工具失败。第九十九轮完整门禁正在运行，未提交。
- 第九十九轮在 TypeScript 阶段退出：联合返回值的 conversationId 经 in 检查仍推断为 unknown，五处 view 调用类型不满足；增加字符串类型收窄后运行第一百轮完整门禁。该轮没有运行全量测试，不能计为门禁通过。
- 第一百轮 TypeScript/lint 通过；246 文件 / 1754 用例通过、26 文件 / 108 用例失败，总量保持 272 文件 / 1862 用例，116.20 秒（/tmp/graph-v2-full-check-100.log）。108 项全部因旧 DAG definition 缺失拒绝，清单 /tmp/graph-sdk-cutover-failures100.json；`m1/execution` 全部 20 项通过，包括权限冻结与重启、等待消息/产物保留和真实宿主验收。单独 check:baseline、check:evidence 通过，验收证据未变。完整门禁仍红，未提交。下一批 m2 调度、循环、模板和 verifier 需保留连续无进展局部阻塞等真实合同；不能仅替换定义或删除断言。旧 main foundation/DAG 调度器仍待退役，完整 spec、可视化和默认应用交付仍未完成。

### 原生循环调度与模块显式恢复（2026-10-08，进行中）

- 上一目标轮为实际进展：删除 m1 旧构建 helper、迁移六项合同并通过全量，旧 DAG 失败从 114 降至 108。本轮继续完整退役。
- `m2/scheduling` 四项旧图合同迁移到真实 Pi/HTTP、具名接口和原生模块，保留文件五项总量。快速节点 submit 后，真实宿主 successor 已 settled，而慢 sibling 的 HTTP 回复仍在途；慢任务结束后 graph 先 idle、由 main 显式完成。可复用子 graph 的 11 个 worker 各有独立实例，外部 main 与它们共享十个名额：main 在途时实际启动九个，释放后十个，最后启动第十一个；没有合成 container/master 执行。原生定义不再依赖 dependsOn/containers 或伪造 evidence。
- 连续无进展合同用 main 可编写的版本化自定义判断代码，在真实受限 Docker 进程执行。模块成功状态记录失败维度/计数/轮次，连续三次无进展抛出带实际 attempts=[1,2,3] 的 stalled 原因，模块保留第三次输入并暂停；独立 agent/后继 host operation 继续执行。失败判断不写成功 state，因此面板的最后成功 state 为 count=2，第三次输入与故障原因分别保留，不能把失败状态伪造为成功 transition。一个曾失败维度通过时，正常 transition 的连续计数为 1→0→0，最终输出通过。没有声称内置 verifier/template 库已完成，这里证明的是原生自定义模块、持久状态和循环运行能力。
- RED /tmp/graph-native-module-repair-red.log：重启保留 module 输入，main 修复代码并调用 resume(moduleId) 后 worker 仍只有六次请求而非八次。GraphManagement 的 pause/resume 原先忽略 moduleId，偷偷当作 graph 控制；现在明确校验 nodeId/moduleId 二选一并控制相应队列。未知模块和同时指定两个目标拒绝；局部恢复不解除整个 graph 的手动暂停。修复策略的新代码显式重启自己的业务计数，不由 kernel 重开清掉状态，待处理第三轮先重评，再触发第四轮真实 worker/reviewer，最终 count=0、attempts=[1,2,3,4]，独立工作未重跑。
- 三项 focused 原生合同通过（/tmp/graph-native-scheduling-three.log，7.04 秒）；嵌套用例首次只因把稳定节点集合误作数值排序数组失败，改为独立集合断言，未修改执行名额规则。四文件 / 42 项全部通过（/tmp/graph-native-scheduling-and-controls.log，11.52 秒），含 m1 全局名额、生命周期和模块重开合同。删除 m2 旧图 setup helper；一项 main pump 测试仍由旧 main ActionAdapter 驱动，待随 main foundation 迁移。第一百零一轮完整门禁正在运行，未提交。
- 第一百零一轮 TypeScript/lint 通过；247 文件 / 1758 用例通过、25 文件 / 104 用例失败，总量 272 文件 / 1862 用例，131.72 秒（/tmp/graph-v2-full-check-101.log）。104 项全部因旧 DAG definition 缺失拒绝，清单 /tmp/graph-sdk-cutover-failures101.json；真实局部 module resume 与四项调度合同通过全量。完整门禁仍红，未提交。
- `m2/scheduling` 最后一项模拟 main pump 也迁移到两个真实 Pi 会话：第一会话 HTTP 回复挂起，第二会话仍发请求并收到独立回复，两者实例不同；第一回复释放后实际结算为原正确文本。首次 drive 后立即读会话仍为空，因为 pump 启动的任务不在后续 drive 局部 running 集合，改为等待实际会话回复出现，保留严格消息断言和两次请求总数。五项全部通过（/tmp/graph-native-scheduling-all-real-fixed.log，12.73 秒），文件不再引用 ActionAdapter、旧 graph setup 或 verifier。

### 显式返工与稳定审查版本（2026-10-08，进行中）

- `m2/loops` 四项旧 DAG 合同迁移至真实 Pi、each 路由、具名输入/输出和精确产物引用，保留文件四项总量。worker 发布版本 1/2、reviewer 实际读取各版本后提交 verdict；失败经 gate.rework 触发原 worker 下一次执行，通过经公开出口交给 main。worker 实例、会话历史与累计 300 token 保留，独立 sibling 只执行一次。两轮 transition 明确引用不同 digest/version；历史已发布内容仍为 version 1，不因返工原地变动。成功只有当前第 2 版审查；这不要求路由自动失效旧通过状态，最终 commit 版本验收仍由独立 final acceptance 合同证明。
- 重启合同：暂停 gate 后完成第一轮 worker/reviewer，模块投递保留；重启后不会额外模型调用，显式 module resume 才处理第一次失败并触发第二轮。原实例/用量保留、四个队列输入全部 done、通过结果精确引用版本 2。模块异常合同：真实受限 Docker 模块抛出 column index out of range，full access 的三次 drive 和重启后三次 drive 仅记录一次失败，输入保留、无虚构成功 transition，完成请求 blocked。
- 初次版本断言读取 provider content 数组的 JSON 表示，导致内部 JSON 被二次转义，改为按真实 text parts 提取最新输入再断言 version=2。四文件 / 44 项通过（/tmp/graph-native-loop-scheduling-siblings.log，15.72 秒），含全部 loops/scheduling、模块重开与生命周期。第一百零二轮完整门禁正在运行。旧 verifier/templates/main foundation、完整可视化和默认应用交付仍待完成，未提交。
- 第一百零二轮 TypeScript/lint 通过；248 文件 / 1762 用例通过、24 文件 / 100 用例失败，总量保持 272 文件 / 1862 用例，135.63 秒（/tmp/graph-v2-full-check-102.log）。100 项全部为旧 DAG definition 缺失拒绝，清单 /tmp/graph-sdk-cutover-failures102.json。全部原生循环和调度合同通过全量。check:baseline、check:evidence 与 git diff --check 通过，验收证据未变，未提交。
- main pump 合同再做严格 owner 验证后发现实际宿主缺陷：drive 只等待本次调用的 running 集合与原生 activeGraphs，不等待先前 pump 已启动、同宿主 pending 中的 main 工作。移除末尾 poll 后实际返回时会话无回复（/tmp/graph-pump-drive-drain-red.log）。前述“只需等待可见消息”的判断不充分，已纠正：drive 的退出条件和等待集合现在包含宿主 pending；pump 仍非阻塞，两个会话仍并行，无新外部等待工具或测试专用 seam。回归在 drive 返回时严格检查回复已持久化。四文件 / 32 项通过（/tmp/graph-pump-drive-drain-siblings.log，19.97 秒），含全局调度、执行/暂停和硬崩溃恢复。第一百零三轮完整门禁正在运行；完整退役尚未完成。

### 嵌套投递、显式重试与稳定产物交接（2026-10-08，进行中）

- 第一百零三轮 TypeScript/lint 通过；248 文件 / 1762 用例通过、24 文件 / 100 用例失败，总量 272 文件 / 1862 用例，135.91 秒（/tmp/graph-v2-full-check-103.log）。100 项仍使用旧 DAG：其中两项 context-model 断言旧校验错误文字，其余直接遭 definition 缺失拒绝，清单 /tmp/graph-sdk-cutover-failures103.json。实际 main pump/drive 修复通过完整回归；完整门禁仍红，未提交。
- `m2/graphs` 四项合同迁移为真实 Pi/HTTP 和原生接口，移除该文件旧 ActionAdapter/setup/dependsOn/container 执行推断。两层模板通过公开入口投递，只启动选中的 text agent，json 无模型调用/边投递；公开输出直接映射稳定路径，两个实例存在但只有一个执行，没有额外容器执行。文件用例总量仍为四项。
- once 汇合声明 requiredInputs=[work,sibling]，optional 不在必需集合。work/optional 明确未满足交付要求后各自暂停，成功 sibling 的值保留。main 对原 work 队列项显式 retry，原实例继续、sibling 不复跑，optional 缺席仍产生汇合结果；main 显式 skip 可选失败后完成。初次用 HTTP 400 模拟失败遗漏了供应商用量，完成被未知调用账阻止，属于正确保护而非 skip 缺陷；最终改用真实有用量回复但不 submit，覆盖交付失败本身，未知用量仍由已有专门恢复合同负责。
- 产物交接先暂停下游：producer 真正发布内容、submit 精确 artifactId/version/digest，重启后下游沿原投递实际 artifact_read；producer 不重跑，边的 delivery 和原执行记录不变，阅读内容与精确版本一致。嵌套内部 reviewer 实际读发布内容后，显式映射的公开输出投递到子 graph 外的 gate；gate 记录真实输入/transition，main 接收精确 subject。这里证明连接/版本/路由，不声称旧三种 verifier 策略库已原生替换。
- 四文件 / 20 项通过（/tmp/graph-native-graphs-contracts.log，12.74 秒），含 graphs/loops/scheduling/subgraph。check:baseline 和 check:evidence 通过，272/1862 基线与验收证据未变；git diff --check 报一处测试空行尾部空白，需全量测试结束后清理。第一百零四轮完整门禁正在运行。下一步原生 HTTP 布局与旧模板/verifier 库；完整退役、可视化和默认应用交付仍未完成。
- 第一百零四轮 TypeScript/lint 通过；249 文件 / 1766 用例通过、23 文件 / 96 用例失败，总量保持 272 文件 / 1862 用例，144.38 秒（/tmp/graph-v2-full-check-104.log）。四项原生 graphs 合同通过全量；剩余旧 DAG 清单 /tmp/graph-sdk-cutover-failures104.json。测试空行尾部空白已在 Vitest 结束后清理；git diff --check、check:baseline、check:evidence 通过，未提交。

### 原生 HTTP 嵌套组关系与布局稳定性（2026-10-08，进行中）

- 真实 HTTP owner 回归 RED（/tmp/graph-native-http-parent-red.log）：两层声明式子 graph 的 outer/inner 没有返回 parent=outer，服务端布局把两层当作根级并列组。`nativeGraphStructure` 现在从已展开的稳定组路径查找最近祖先，同时用于父组关系与 ELK 层级。没有引入单独可视化执行对象，也没有更改投递语义。
- `m5/graph` 第一项旧 ActionAdapter/模板模拟替换为真实 Pi/HTTP 原生嵌套图：显式映射的返工边从 gate 指到 outer/inner/work；正常产出与审查实际 submit，经 gate 向 main 公开输出。HTTP 图投影显示 judgment 精确 value、未投递 rework 的 null/latest 和空历史、实际模块 input/transition；四次模型请求更新后整个 layout 与执行前一致，图接口及分页 operations 都真实返回成功。父组/节点归属直接检查服务端返回，没有假 HTTP 拦截或编造产物/evidence。
- 四文件 / 19 项通过（/tmp/graph-native-http-layout-siblings.log，3.50 秒），含 m5/graph、m5/http、subgraph 和可执行设计例子；m5/graph 另外两项几何合同仍基于旧模板库，保留至库与布局路径原生替换，不能据此宣布完整可视化验收。该文件四项总量保持，旧 setup/agent/check helper 删除。第一百零五轮完整门禁正在运行；完整退役、三种 verifier、模型分层与默认应用交付仍待完成，未提交。
- 第一百零五轮 TypeScript/lint 通过；250 文件 / 1767 用例通过、22 文件 / 95 用例失败，总量 272 文件 / 1862 用例，153.66 秒（/tmp/graph-v2-full-check-105.log）。新增原生 HTTP 父组/投递/布局稳定性合同通过完整回归，95 项仍因旧 DAG definition 拒绝，清单 /tmp/graph-sdk-cutover-failures105.json。check:baseline、check:evidence 和 git diff --check 通过，验收证据未变。没有运行中的 Vitest；下一完整门禁编号 106。完整门禁仍红，未提交；主 checkout 与默认应用尚未切换。目标仍为完整旧 SDK/DAG 退役与 spec 实现，不以本批通过代替完成。

### 原生审查规则与旧程序适配器实际退役（2026-10-08，进行中）

- 上一目标轮为实际进展：原生嵌套/版本/HTTP 合同迁移五项，修复父组丢失，完整门禁旧 DAG 失败从 100 降至 95。本轮继续完整退役，不缩小目标。
- 新增 review-policy.ts 自包含纯判断代码生成器及 scripts/create-review-module.ts 按需命令，main 用 JSON policy 生成新版本只读 code entry 与普通 command 模块 JSON。subject/report/candidate 都是显式输入名，所有 requiredInputs 收齐才判断；隔离、队列、each/once、transition/outbox 继续由既有 ModuleRuntime 负责。没有新的执行器或常驻工具。模块 code 在真实 Node 24 CLI 中生成，再进入真实 Docker；不仅在 Vitest 转译器中验证 function serialization。
- m2/verification 16 项合同全数迁至真实 Pi/HTTP 的发布、读取和 submit；原用例总量保留。必需失败与建议缺席/失败、多视角返工正文与未覆盖文件、有效反例不能被通过判断抵消、评委硬条件/归一化权重/显式 tieOrder/无合格候选/不合格高分、旧胜者不能证明新吸收产物均实际执行。审查的两个发布版本都真实存在；旧版本不适用当前版本。复用合同实际复跑原 producer：读取并提交同一已发布版本，不重发布、不重跑 reviewer；同一稳定引用仍通过，判断不绑定 execution/activation 身份。最终 commit/独立模型门由现有 graph-final-acceptance 合同负责，纯策略业务输出不取代它。
- 首轮 13/16 通过，评委三项未投递：夹具用 candidateA/B 查已规范化为 candidatea/b 的逻辑产物名，导致 submit 缺失 value；修正为规范逻辑名，未更改发布/判断程序。16 项通过 /tmp/graph-native-review-policies-fixed.log（22.43 秒），转为实际 authoring CLI 后再次 16 项通过 /tmp/graph-native-review-authoring-cli.log（24.85 秒）。未知版本或坏报告输出 invalid_evidence 业务返工，仍正常记录 transition；不伪造运行异常或验收证据。
- 删除旧 program-adapters.ts 的 297 行及唯一 Execution 入口，外部 main executor 不再执行旧独立程序节点。verification.ts 删除无调用的 GraphPlan 验证及仅旧 adapter 调用的 DAG evaluator，共 303 行；保留仍被 main lifecycle 和旧 template 类型引用的少量定义，完整 SDK/DAG 退役仍未完成。准确调用与合同对照见旧内核删除审计的新节。架构导航不再指向已删除文件。
- 删除后六文件 / 53 项相邻合同通过（/tmp/graph-native-policy-and-program-retirement.log，29.04 秒），含真实 main 执行/暂停、宿主命令配置和最终 Git 验收。第一百零六轮在 TypeScript 阶段发现 PublishedSubject interface 缺少 Json 索引兼容性，未运行全量；改为结构化 type alias、对已存在 subject 作非空收窄后运行第一百零七轮。没有降级 Json 类型或构造假 receipts，未提交。
- 第一百零七轮 TypeScript/lint 通过；251 文件 / 1782 用例通过、21 文件 / 80 用例失败，总量保持 272 文件 / 1862 用例，132.21 秒（/tmp/graph-v2-full-check-107.log）。80 项全部为旧 DAG definition 缺失拒绝，清单 /tmp/graph-sdk-cutover-failures107.json；原生 16 项审查策略、旧程序分支删除后的 main/宿主命令/Git/恢复相邻合同通过完整回归。check:baseline、check:evidence、git diff --check 通过，验收证据未变。下一完整门禁编号 108，没有运行中的 Vitest。旧模板库、main lifecycle、其余旧 SDK/DAG 依赖、完整可视化/统计/模型分层及默认应用交付仍待完成，完整门禁仍红，未提交。

### 原生定义库与八种实际执行模式（2026-10-08，进行中）

- 新增 examples/graphs 四份正式 JSON definition：流水线、fanout/once 汇合、两层子 graph 路由、外部 main 派发 worker。没有第二套 builder 格式；公开输入经 graph_send 启动，agent 真正 submit 后由宿主 node --version 运行并保存真实命令 record，graph idle 后由 main 显式完成。命令仅演示连接，不冒充项目 acceptance，docs 明确要求绑定实际配方/模型和验收。
- m2/templates 两项旧 ActionAdapter 合同全数迁移，保留两项总量；覆盖八种模式的真实 Pi/HTTP、发布/读取、生成命令代码和 Docker 隔离判断。评委选优后 once ready 明确汇合 selection 与两个精确产物，absorb 实际读取双方并发布新版本，final reviewer 实际读新产物，final policy 重新检查 absorbed 引用；没有内部 master 或容器执行。旧模板测试 setup、模拟 program evidence 和 dependsOn 构建删除。
- 审查策略新增显式 staleReview=wait 配置，仅在同一产物 ID 的旧版本报告暂存时保留 state、不发输出并显示等待。默认仍 rework；不修改通用路由状态保留或 once 规则。两轮 optimize 实际 worker/reviewer 各六次 HTTP 请求，输出恰为 rework/approved，夹在中间的等待 transition 无输出且 stateBefore=stateAfter，旧版/新版内容均真实可读。旧报告不能额外触发第三次工作。
- 首轮 fanout 夹具共用顺序 HTTP responses，两个并发 agent 抢到对方的 submit/text，诊断确认问题属于夹具；改为每个模型独立实际 HTTP provider 后四种定义通过。随后复用 helper 的 joined 名字修正了路径 join 的词法遮蔽，没有改变运行调度。八模式两项通过 /tmp/graph-native-eight-patterns-fixed.log（11.52 秒）；五文件 / 31 项相邻合同通过 /tmp/graph-native-pattern-review-siblings.log（23.95 秒），TypeScript 通过。旧 templates.ts 目前唯一调用为 m5/graph 的两项几何测试，暂保留，待真实 HTTP 几何合同迁移后整体删除。
- 第一百零八轮完整门禁待运行，完整旧 SDK/DAG 退役、可视化、模型分层和默认应用交付仍未完成。未提交；验收证据不得由普通测试改写。
- 第一百零八轮 TypeScript/lint 通过，251 文件 / 1783 用例通过、21 文件 / 79 用例失败，132.52 秒。78 项是旧 DAG definition，另 1 项为四种真实审查模式合并用例在全量并发下超过默认 15 秒；超时清理关闭 runtime 后，尚在途 fixture 回调造成一项 Runtime is closed 未处理错误（/tmp/graph-v2-full-check-108.log）。未把它误计为旧 DAG 或宣称通过。该合并用例设置 60 秒总上限，单次模块限制仍保持 5 秒，产品执行规则不变；需要第一百零九轮完整复验，未提交。
- 第一百零九轮 TypeScript/lint 通过；252 文件 / 1784 用例通过、20 文件 / 78 用例失败，总量保持 272 文件 / 1862 用例，133.47 秒（/tmp/graph-v2-full-check-109.log）。78 项全部为旧 DAG definition 拒绝，清单 /tmp/graph-sdk-cutover-failures109.json；八模式两项实际执行在全量并发下 20.784 秒通过，无未处理错误，说明合并集成测试的总时间预算修正有效，产品模块超时未改。check:baseline、check:evidence、git diff --check 通过，验收证据未变。下一完整门禁编号 110，没有运行中的 Vitest。完整门禁仍红，未提交；目标继续完整旧 SDK/DAG 退役与 spec，实现范围未缩小。

### 原生几何、实际画布与旧模板库退役（2026-10-08，进行中）

- 上一目标轮是实际进展：八种原生模式通过真实 Pi/HTTP/Docker，完整门禁旧 DAG 失败 80→78。本轮保留完整 SDK/DAG 退役与 spec 目标，迁移布局 owner 合同，不把几何通过当作完整 UI 验收。
- m5/graph 的两项旧模板几何测试迁到真实 HTTP /api/tasks/:id/graph。与 m2 实际执行测试共用正式 review definitions，生成 entry 仍通过真实 Node 24 authoring CLI；四份 JSON 示例直接读取。八模式之外增加自回边与七条同端点连接的合法图，不执行这个几何补充图。HTTP 返回的每条正式边 ID 均核对，不过滤掉反馈；检查节点/端点/折点格点、单一顶部/底部端点、正交、所有节点避让、非共享短连接的通道不重叠、七条路径互不相同。原文件四项总量保留。
- RED /tmp/graph-native-geometry-red.log：pipeline 的 56px 高度只吸附位置，没有统一尺寸。graphNodeSize 改为宽度 32px 倍数（中心落 16px 格点）、高度 64/96；组宽同样按 32px 约束。原生真实 kind=module 直接交给 presentation，不再偷偷转为旧 program 来测另一套尺寸。ELK 固定每对象顶部/底部端点。
- 固定端点后的实际汇合路线重叠（/tmp/graph-native-fixed-ports-grid.log），不是接口投递错误；增加 orthogonal-routes.ts 的有限格点搜索，正式边仍由 ELK 决定节点排列，路线按节点障碍、短端点连接与已占用通道选择。所有短连接先预留，避免后续边与先前通道重合；不同入/出边在短连接不同格点处接入。没有新的执行边类型、loop 标志或调度器。最初嵌套对象因 ELK 子布局默认层距不足导致短连接穿过节点，真实 HTTP 拒绝 500（/tmp/graph-native-grid-routes-diagnostic.log）；对子组明确 DOWN 与统一按连接数量分配层距，未绕过节点避让检查。九场景四项通过 /tmp/graph-native-nested-grid-spacing.log；加到七条并行连接后相邻证明仍通过。
- m5/ui 第一项旧模拟 DAG 用例改为真实 native graph + Chromium：两条同端点边、反馈边、自回边共四条；实际 SVG 的每个坐标严格等于 HTTP 路线，仍 read-only，节点点击打开自身聊天页。RED /tmp/graph-native-ui-self-edge-red.log 页面只有三条边：GraphCanvas 把合法 self edge 与折叠后内部边一起过滤。现在有实际路线的自回边保留，折叠后内部边的空路线仍隐藏。修复后发现节点概览仅显示任务而无稳定 ID；NodeDetail 加入宿主实际 node.id，保留原任务说明。浏览器通过 /tmp/graph-native-ui-routes-and-identity.log（2.57 秒）。该文件预算实时 UI 用例仍使用旧 SDK，待后续迁移，未声称整文件绿。
- 删除无生产调用的旧 src/core/templates.ts（tracked 92 行）；m2/m5 均无旧模板依赖。没有新增生产 builder API：正式 JSON 示例与主 agent 的按需 policy 命令继续是构建路径。test fixture native-patterns.ts 只复用实际执行/HTTP 所消费的同一正式定义，避免两套形状与测试专用 production seam。
- 四文件 / 15 项相邻合同通过 /tmp/graph-native-layout-retirement-proof.log（10.76 秒），含实际八模式执行、HTTP 几何、独立 prompt 窗口、折叠跨组消息和已有 branch 保留合同。TypeScript、check:baseline、check:evidence、git diff --check 通过，272/1862 与验收证据未变。第一百一十轮完整门禁待运行，未提交。布局结构 patch 后复用未变化位置、模块故障/暂停可见状态、完整模型/统计与默认应用交付等仍需完整 spec 审计；旧 main lifecycle/SDK scaffold 仍未退役，完整目标未完成。
- 第一百一十轮 TypeScript/lint 通过；252 文件 / 1785 用例通过、20 文件 / 77 用例失败，总量保持 272 文件 / 1862 用例，134.05 秒（/tmp/graph-v2-full-check-110.log）。77 项全部为旧 DAG definition 拒绝，清单 /tmp/graph-sdk-cutover-failures110.json；原生几何四项、实际自回/反馈/并行 SVG 与稳定身份浏览器用例、抽出的八模式正式 definitions 通过全量，无未处理错误。check:baseline、check:evidence、git diff --check 通过，验收证据未变。完整门禁仍红，未提交；下一完整编号 111，没有运行中的 Vitest。下一批应迁移 m5 预算实时浏览器合同并继续旧 main lifecycle/SDK 退役，随后按完整 spec 审计剩余布局/模块状态/统计/模型分层与默认应用交付，不因模板文件删除宣告目标完成。

### 原生预算用户答复与真实界面续跑（2026-10-08）

- 原生浏览器预算合同 RED：有限额度 1 token 正确阻止模型请求，但没有生成用户预算问题（/tmp/graph-native-budget-ui-red.log）；原答复程序只查旧 instances，不能为原生节点追加。不是迁移假动作后自然消失的测试问题。
- KernelStore 在真实有限预算预留拒绝时生成去重、用户所有的预算问题，引用冻结 execution quota；未知 usage、权限或恢复问题不转换成预算申请。NodeExecutor 保留未提交输入并暂停该节点队列；实际 provider 的额度耗尽也走这条阻塞路径，不消耗自动重试。
- 预算答复验证原生 execution 的 graph/node 身份，以当前授权（无覆盖时用冻结额度）累加正整数并拒绝溢出；授权只影响下一执行，不改历史额度、不释放未知 usage、不自动重放输入。main 显式 retry 仍拒绝已 submit 的原输入；有显式低预算声明时，main 仍须调整该声明。
- m5/ui 第三项替换旧 ActionAdapter/DAG/fake evidence 为真实 HTTP、Pi 与 Chromium：SSE 展示 blocked，调用前无 provider 请求；重复 drive 无重复预算问题；inbox 用户追加 200000 后请求成功，授权为 200001，节点仍不自动发送；main retry 原队列后实际模型收到原输入，界面 succeeded，历史两次额度分别为 1/200001，真实用量非零。文件三项总量保留，不新增测试专用生产入口。
- 聚焦 /tmp/graph-native-budget-boundary-proof.log：5 文件 / 46 项通过，9.76 秒，含完整 m5/ui、kernel-node-budget、node-executor、graph-final-acceptance、question-routing。TypeScript、check:baseline、check:evidence、git diff --check 通过，验收证据未变。完整门禁 111 待执行，尚未提交；旧 main SDK/DAG 退役与完整 spec 验收仍未完成。
- 第一百一十一轮完整门禁终止：TypeScript/lint 通过；253 文件 / 1786 用例通过、19 文件 / 76 用例失败，142.14 秒（/tmp/graph-v2-full-check-111.log）。76 项全部为旧 DAG definition 拒绝，清单 /tmp/graph-sdk-cutover-failures111.json；本批原生预算浏览器合同在全量中通过，失败从 77 降至 76。check:baseline、check:evidence 与 git diff --check 通过，总量 272/1862 保持，无运行中的 Vitest；下一完整门禁编号 112。完整 gate 仍红，未提交，main checkout/default app 未切换；整体旧 SDK/DAG 退役与完整 spec 目标继续。

### 原生额度持久性与 inbox 聚合退役（2026-10-08）

- 上一轮实际进展为原生预算用户答复，完整 gate 旧格式失败 77→76。本轮继续将 console/unlimited 六项与 app/insights-ui 两项迁至正式 graph 定义和实际宿主，不删用例。旧 ActionAdapter 假用量/假 evidence、旧 DAG propose helper、手写重建 v13 库与假百节点 HTTP 响应删除。
- unlimited 六项真实 Pi/HTTP：同一实例两次调用累计 40000002 tokens，越过旧 20M 默认仍不限；有限默认 1 在发送前阻塞、显式无限政策保持当前冻结 1 但允许 main retry 新执行；重启保留有限授权/实例/session/累计 usage；缺失 provider usage 在无限额度下实际估算；有限未知 hold 跨重启保留、加额度与 retry 均不能消除、明确 reconcile 后续跑累计计费 100 且 reserved=0。第六项仍拒绝非法默认值。旧 v14 graph 历史迁移合同按 ADR0030 废弃旧图决定替换为原生额度与会话的真实重启合同，不制造新旧转换器。
- 真正 owner RED /tmp/graph-native-unlimited-red.log：用户直接 setBudget 已更新原生授权，但预算问题仍 open；会阻止成功 graph 完成。原生 setBudget 现在只关闭该节点的预算问题，不解除队列、改冻结额度或释放未知用量。测试其他两个初始失败来自夹具把 100M contextWindow 用在有限模型，超出实际预留上限；仅 20M 累计案例使用大 context，有限案例使用实际 32000，未放宽预算门。修复后六项通过 /tmp/graph-native-unlimited-policy-fixed.log。
- inbox 真正 owner RED /tmp/graph-native-quota-and-inbox-proof.log：两条预算待办答复其一后列表少一条，导航徽标仍 2；原程序只 reload 本地 task view，历史也不刷新。WorkspacePage 显式传递 refreshTasks，Inbox 在答复成功后刷新 task summary 与 /api/inbox history。没有等待固定轮询或放宽严格计数。修复第一次错误遗漏跨组件 callback，TypeScript 提示找不到 refreshTasks；补齐真实 props 后 TypeScript 与浏览器通过。
- app/insights-ui 两项真实 HTTP/Chromium：同一 main 拥有两个独立 graph，各产生原生预算问题，徽标 2→1→消失、两条历史记录与各自授权值均匹配；实际 100-node/99-edge 原生 pipeline 创建、服务端布局和浏览器首屏仍满足 3000ms，99 条真实 grid edges 显示。删除 silent cleanup race，等待真实 server/browser 关闭，不遗留后台作业。
- /tmp/graph-native-quota-and-inbox-fixed2.log：7 文件 / 54 项通过，9.83 秒；含 m5/ui、kernel-node-budget、node-executor、最终验收和问题所有权相邻合同。TypeScript 通过。完整 gate 112 待执行；完整旧 SDK/DAG 退役与 spec 仍未完成，未提交。
- 第一百一十二轮完整门禁终止：TypeScript/lint 通过；255 文件 / 1792 用例通过、17 文件 / 70 用例失败，145.34 秒（/tmp/graph-v2-full-check-112.log）。70 项全部为旧 DAG definition 拒绝（/tmp/graph-sdk-cutover-failures112.json），本批八项实际 owner 合同在全量通过；旧格式失败从 76 降至 70。check:baseline/check:evidence/git diff --check 通过，272/1862 总量保持，无 Vitest 仍在运行。下一完整门禁编号 113。完整 gate 仍红，未提交；main checkout/default app 未切换，旧 main lifecycle/SDK 与完整 spec 验收继续。

### Reviewer 具名输出合同替代旧 router/DAG fixtures（2026-10-08）

- 上一轮为实际进展：预算持久恢复与 inbox owner 修复，112 轮旧格式失败 76→70。本轮继续迁移 console/review-as-router 七项，不删测试数量或缩小完整退役目标。
- 原文件旧 NodeSpec/loops/when/ActionAdapter/假 usage 已删除，改用完整正式定义、三个真实 HTTP provider、常驻 Pi 会话、实际 artifact_publish/read 和 submit。reviewer 具名 approved/rework 输出、requiredAnyOf 二选一；未提交端口默认 disable，边拥有连接，无隐藏 route 字段或程序 gate。初次夹具缺 recipesPath，随后误读 revision/read 返回结构，修正实际 caller 配置与 API 形状；未把这些夹具问题称为生产缺陷。
- 七项独立合同：失败后返回同 worker 实例且真实会话保留；通过只释放正确下游且 rework 无投递；实际 reviewer recipe/model history 独立性与正式 acceptance；验收 source 精确 pin 已发布报告 ID/version/digest/内容；复跑 user prompt 包含 reviewer 原话而首轮不含；失败审查保留真实 rework delivery/queued input 且不通过验收/不启动下游；绑定验收的 reviewer 输出 exact report 引用，下游实际读取同一报告，不因验收处理改写提交。非代码报告 commit=null 明确适用；Git commit 精确验收由原最终验收相邻合同执行。
- 失败反馈用真实 provider beforeReply 触发 main pause worker，再 submit 将反馈进入原队列；没有禁用返工边、编造 session 或删掉反馈以得到 blocked。三个 provider 使用各自计划且记录实际 HTTP prompt，无生产测试专用注入入口。
- /tmp/graph-native-review-output-siblings2.log：4 文件 / 14 项通过，13.28 秒，含真实 loops、模型历史选择与最终 Git/human 验收；TypeScript 通过。新定义七项不再调用旧 model-selection independentReviewReady/loadGraph/legacy-routing，但这些源码仍有 main/旧 lifecycle caller，不能在本批错误删除。完整 gate 113 待执行，未提交，完整 spec/旧 main SDK 仍未完成。
- 第一百一十三轮完整门禁终止：TypeScript/lint 通过；256 文件 / 1799 用例通过、16 文件 / 63 用例失败，146.66 秒（/tmp/graph-v2-full-check-113.log）。63 项全部为旧 DAG definition 拒绝，清单 /tmp/graph-sdk-cutover-failures113.json；本批 reviewer 七项在全量通过，旧格式失败 70→63。check:baseline/check:evidence/git diff --check 通过，272/1862 总量保持。无运行中的 Vitest，下一完整门禁编号 114。完整 gate 仍红，未提交；main checkout/default app 未切换，整体 SDK/DAG 退役与完整 spec 目标继续。

### 旧自动完成/交付与 advance 回调实际退役（2026-10-08）

- 上一轮 reviewer 七项真实合同通过，113 轮旧定义失败 70→63。本轮以源码退役推进完整目标，不把失败数量下降当唯一进度。
- 删除 Execution.readyToComplete/completeTask/deliver/advance：旧 DAG 成功推断、evidence 表扫描、旧审查通行判断、两遍 tryDeliver 与旧节点阻塞兜底不再在 main dispatcher 中执行。旧方法对所有正式 native revision 已明确 early-return，没有原生完成职责；native 完成由 GraphRuntime 显式请求、graphAcceptance、真实 Git finish 承担，保留 restart 的 Git restore 现场核查。
- 删除 Execution.finish 及 task.setBudget/task.answer 后的旧 finish 调用；删 report/reconcile/constructor 的旧 deliver 调用。OperationLifecycleHooks.advance 字段及三个调用删除，不替换成无作用 callback。五个测试文件仅移除已无意义的 advance:()=>undefined fixtures，保留全部原断言/用例数量；实际 before-send 恢复策略 hook 继续保留。
- src/core/model-selection.ts 的 independentReviewReady 已无任何源码/测试 caller，正式删除 22 行：旧 routes 或 graph.verify verdict 不再充当完整验收。isReviewer/implementerModels/pickModel 仍有 main/旧上下文调用，后续继续退役，未冒称整个 model-selection 已删除。版本精确、模型独立、实际产物与用户人工验收都由原生 graphAcceptance 承担。
- 证明：/tmp/graph-native-completion-retirement-proof.log，10 文件 / 81 项通过（9.84 秒），涵盖真实完成通知、显式完成/失败未清空、预算答复、人工验收、operation 恢复与 UI；删除旧审查判断后 /tmp/graph-native-completion-model-proof.log，4 文件 / 11 项通过（12.14 秒），含真实 reviewer 输出、模型历史与 Git/人工验收。TypeScript 通过，删除多余文件尾空行后 diff 校验继续。没有运行中的 Vitest；完整 gate 114 待执行。
- 本批仍不能宣称完整旧 SDK/DAG 退役：main operation lifecycle 的旧结果/路由/上下文处理、剩余旧测试、NodeSpec/GraphState 及完整 UI/spec 审计继续；未提交，默认应用尚未切换。
- 第一百一十四轮完整门禁终止：TypeScript/lint 通过；256 文件 / 1799 用例通过、16 文件 / 63 用例失败，144.75 秒（/tmp/graph-v2-full-check-114.log）。63 项仍全部为旧 DAG definition 拒绝（/tmp/graph-sdk-cutover-failures114.json），旧完成/交付删除没有引入新失败。check:baseline/check:evidence/git diff --check 通过，272/1862 基线保持。无 Vitest 仍在运行，下一完整门禁编号 115。完整 gate 仍红，未提交；本轮源码退役为实际进展，不以失败数量不变判定无进展。main checkout/default app 未切换，完整 SDK/DAG 和 spec 审计继续。

### 原生 worktree 合同与提交身份（2026-10-09）

- tests/m4/worktrees 三项保持数量，移除旧 Proposal/NodeSpec/DAG、假 ActionAdapter 与审查证据，改为正式声明、真实 HTTP/Pi、独立 worktree、workspace_commit、发布代码产物和独立审查。并行 provider barrier 确认两个工作副本同时运行；不相交文件经集成、实际命令检查、精确 commit 审查后合入目标，冲突保留两份现场并暂停失败节点。
- 原生提交身份的实际缺陷：GitIntegration 只从旧 instances join 读取配方，原生节点没有该行，显式提交丢失配方显示名；自动集成未传本轮 recipe，署名退为节点 ID。显式提交按准确配方版本查询定义，自动集成传入当前 execution 的冻结 revision recipe。
- 首次自动提交断言只读到了此前显式提交：聊天执行不执行 settleWorkspace，该绿色不能证明自动提交。已修正为下一次真实接口任务，观察 HEAD 改变和 integration 内容改变，修复前实际 RED 为 work <work@agents.graph.local>，修复后 Native <native@agents.graph.local>。稳定旧产物继续返回原发布内容，未增加重复测试或测试专用生产接口。
- TypeScript 通过；/tmp/graph-native-worktree-complete-proof.log 五文件 / 19 项通过，9.11 秒。第 115 轮完整门禁执行中。完整旧 SDK/DAG 与 spec 未完成，main/default app 未切换，未提交。

- 115 首次命令因 turn 中断丢失 handle，进程检查确认已终止且报告未更新，未把不完整日志当全量结果。115-retry 完整终止：1774 通过 / 88 失败，146.11 秒；60 项旧定义拒绝（较 114 减少三项 worktree），另 28 项为模块相关失败，明确 Docker daemon 不可连接，需恢复后实测归因。TypeScript/lint、272/1862 baseline、evidence、diff check 通过；已依用户此前授权启动 Docker Desktop，尚未宣称这 28 项均已解决。下一完整 gate 116。

- Docker Desktop 启动后 docker info 返回服务版本 29.4.0；六文件 / 48 项模块 owner 合同通过（/tmp/graph-native-module-docker-restored.log，26.16 秒）。随后第 116 轮完整终止：257 文件 / 1802 项通过，15 文件 / 60 项全部为旧定义拒绝，144.56 秒（/tmp/graph-v2-full-check-116.log；/tmp/graph-sdk-cutover-failures116.json other=[]）。115 的额外 28 项恢复后全量均通过，本批三个工作副本合同持续通过。TypeScript/lint、baseline 272/1862、evidence 与 diff check 通过。下一完整 gate 117；全量仍红，未提交，main/default app 未切换。Git 仍有 declaredScope/旧 DAG invalidateChecks 等生产依赖，下轮继续退役，不能宣称完整 spec 达成。

### Git 的旧 DAG 重检查与证据改绑退役（2026-10-09）

- 上一轮实际完成提交身份修复，116 全量 1802/60，无额外原生失败。本轮从 GitIntegration 删除旧图加载、节点 reset、dependent 重置、旧结果 producedPaths/closureProducedPaths 扫描、路径相交判定和 evidence commit 改绑；不再以分支前移推断节点复跑。真正的原生验收已由 graphAcceptance 比较固定回执与当前 commit，重新运行由 main 对模块的明确投递授权。
- tests/console/git-baseline 的六项 DAG predicate 测试与一项直接插入 evidence/关闭外键的改绑测试，改为七项真实原生定义、宿主命令、Git 目标前移和验收查询：原文件修改、无关文件、目录新增、删除、empty commit、无前移、已含验证 commit 的脏 checkout。仍 17 项，不删文件/用例缩小门禁。旧通过回执保留原 commit、source ID；不同 commit 精确 stale，显式新投递后才有新回执；失败命令不产生通过证明；已含 commit 的目标保留用户脏文件且无 checkout 写入。
- 初次夹具用 node -e 被正式权限拒绝，尚未触达测试场景；改为基线中的真实 check.cjs，未放宽沙箱规则。替换合同删除前 17 项通过；源代码删除后 TypeScript 及六文件 / 36 项通过（/tmp/graph-native-git-dag-retirement-proof.log，11.12 秒），含真实节点代码集成与最终精确审查/用户验收交付。新增测试支持无新生产 seam。
- 当前累计 integration.ts 相对 HEAD 7 加 / 186 删（其中上一批身份修复 7 加 / 4 删），本批实删约 182 行；git-baseline 60 加 / 87 删。第 117 轮完整门禁执行中，完整 SDK/DAG 与 spec 未完成，未提交。Git 的 declaredScope/NodeSpec 和 instances 身份 fallback 仍待后续退役。

- 第 117 轮完整门禁终止：257 文件 / 1802 项通过，15 文件 / 60 项仍均为旧定义拒绝，无 Git 删除新增失败，147.68 秒（/tmp/graph-v2-full-check-117.log，/tmp/graph-sdk-cutover-failures117.json other=[]）。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。本批是实际移除旧 DAG 推断，不以失败数量未变否定源代码退役；旧调用尚需继续迁移，整体未完成，未提交。下一完整 gate 118。

### 旧 program-copy 与 Git 实例身份查询退役（2026-10-09）

- 117 全量无新增失败，本轮继续实删代码。src/runtime/program-copy.ts 没有任何生产 caller（program-adapters 已退役），唯一调用者为旧 console/program-copy 测试；76 行旧项目旁 hardlink copy/cache 功能正式删除，不增加第二工作副本模式。正式 operation 使用任务 integration workspace，project-dependencies 为 canonical dependency 授权，原生命令已有真实生产 caller。
- program-copy 六项全部改用正式 JSON 定义、宿主 workspace.command 与真实 Git/磁盘依赖。依赖真的由 require('pkg') 解析，集成 workspace 的实际位置、只读项目安装与原 checkout、准确 verifiedCommit、显式投递后的工作副本复用与新版本、原生准备的初始 baseline 均实测；总数量仍六项，未用假 evidence/关闭外键/ActionAdapter。
- 实际 RED：正式解析器静默保留并接受旧 operation.copy 字段，测试得到成功 graph 而非拒绝。interface-spec 对 operation 已定义七个字段做明确校验；project/somewhere 两种旧 copy 值均被拒绝，不让 main 相信未知字段生效。未提交项目的初次负断言不符合实际准备契约：prepareProject 对无 HEAD 的仓库会建立 baseline，已改为验证执行前 baseline 存在且依赖安装不被提交，保留产品行为。
- GitIntegration.agentIdentity 去掉旧 instances join；显式 commit/自动 integrate 使用传入冻结 recipe 精确读取 definitions。旧 legacy reconcile 仅有 node-ID fallback，不读取旧实例版本；原生署名由 m4/worktrees 与 kernel-git-integration 真实提交继续证明。declaredScope/NodeSpec 和旧 main lifecycle 尚未退役。
- TypeScript 通过；六文件 / 62 项聚焦全通过（/tmp/graph-native-program-copy-fixed2.log，11.74 秒）。118 全量执行中，目标仍未完成，未提交，main/default app 未切换。

- 第 118 轮完整门禁终止：258 文件 / 1806 项通过，14 文件 / 56 项全部为旧定义调用（/tmp/graph-v2-full-check-118.log，151.62 秒；/tmp/graph-sdk-cutover-failures118.json other=[]）。本批四项旧 program 入口退出，六项正式命令合同与身份/精确验收相邻路径全量继续通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。全量仍红，未提交；下一完整 gate 119，旧 NodeSpec/范围和 main/旧 SDK 调用继续退役，完整 spec 尚未完成。

### 原生验收负合同与完成忙循环 owner 修复（2026-10-09）

- 118 全量 1806/56 无额外原生失败；本轮迁移 m4/acceptance 八项，删除旧 Proposal/NodeSpec/dependsOn、withIndependentReview、假 ActionAdapter/evidence/usage。不减少八项数量：正式原生图、独立真实 HTTP/Pi、实际文件检查、真实 published graph.review@1、精确 Git commit、不同 target worktree 与 SDK 人工答复执行。
- 八项保留缺审查声明、reviewer 结束但未发布、明确失败审查、跨 check 模块/禁用结构边的同模型排除、另一工作树脏 target、人工拒绝携带原返工理由、旧人工通过不能验收 target 前移后的新 integration、未知审查用量跨 Git 重检查仍保留且不重跑。旧图依赖推断改为显式输入，副作用/版本与反例保留。
- 实际生产缺陷 RED：review 已因缺少 usage 阻塞且 reserved=200000，后续两条输入 queued，节点 paused=0/status=blocked；完成请求只数 paused，保持 completing，GraphLane 的 completing 分支反复调度，Vitest fork CPU 100% 持续忙循环。只读真实 SQLite、进程状态和固定 handle 确认后，终止该次测试及其两个 resident worker，未在 Vitest 运行时编辑。graph-runtime 完成判断把原生 blocked/failed 节点与 paused 队列一并计为待处理，返回 blocked，保留队列/调用账本/预算占用，避免伪造“排空”。
- 其余初始两个断言问题为夹具：模型不可选在正式路径是 blocked，不是 failed；失败审查 source 不包含通过字段 commit。修正 caller 断言，不改产品行为。TypeScript 通过；五文件 / 71 项全通过（/tmp/graph-native-acceptance-siblings.log，13.94 秒），含完成、预算、执行器、最终独立验收。119 全量执行中。完整 SDK/DAG 与 spec 尚未完成，未提交。

- 119 完整命令未完成，271 文件已输出但 m2/loops 长期未输出；固定 Vitest handle、fork CPU 100% 与缺文件核对证明仍忙循环，不把日志当已完成 gate。首轮 owner 修复把 paused 表 join 到 kernel_nodes，遗漏非 agent 的 module paused 状态；保留旧暂停范围，用 UNION 合并全部 paused 对象与 blocked/failed agent。终止本轮唯一残余 fork 及 Vitest后再编辑。原八项验收 owner 合同和 m2/loops 的模块失败/重启/完成反例同时通过：六文件 / 75 项，15.33 秒（/tmp/graph-native-acceptance-and-module-completion.log）。119 不生成可信全量结果；下一轮完整 120 正在执行。

- 第 120 轮完整门禁正常终止：259 文件 / 1814 项通过，13 文件 / 48 项失败，150.90 秒（/tmp/graph-v2-full-check-120.log）；/tmp/graph-sdk-cutover-failures120.json 显示全部为旧 native-definition 入口拒绝，other=[]。本批八项旧验收 caller 全部退出，未知用量/失败模块完成反例与邻域全量通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。全量仍红，完整 main/SDK 与 spec 未完成，未提交；下一完整 gate 121。

### 原生合并七项合同与共用真实 Git/Pi 夹具（2026-10-09）

- 120 完整 1814/48，上一轮已修真实完成忙循环。本轮 m4/merge 七项正式替换旧 ActionAdapter/NodeSpec/Proposal/dependsOn/checkNode/直接 evidence 生产与假 usage，数量保持。未重新引入旧自动复跑；目标前移或后续原生 worker 投递产新 commit 后，固定旧检查/审查 stale，main withdraw_complete 后明确投递才复查，产物旧版本不改写。
- tests/fixtures/native-git-acceptance.ts 从 m4/acceptance 实际 owner 夹具抽取，两个文件共用临时 Git、两个真实 HTTP/Pi、真实 host command、独立已发布审查。支持可恢复 runtime（固定状态目录/配方/模型与已完成记录）；不增加生产 seam，也不是旧图转换器。
- 七项：脏 active target 保留原文件、显式重试后交付且 reviewer 不重跑；target 前移后的精确回执失效、新结果实际合并双方文件、旧已发布报告保持原 commit；完成请求已持久化且外部已 fast-forward 的恢复写回精确 delivery receipt、无新 provider/check；human 真用户 acknowledge 前不得更新 target；缺独立审查不越权；target 不在 checkout 时条件 ref 更新 main、active other HEAD/文件保留；later worker 原会话真实再执行提交 late.txt，旧 check 不自动重跑，显式新输入更新验收再交付。
- TypeScript 通过；两个文件 / 15 项通过，14.99 秒；六文件 / 24 项相邻合同通过（/tmp/graph-native-merge-siblings.log，18.95 秒）。121 全量执行中，完整旧 SDK/DAG 与 spec 未完成，未提交。

- 第 121 轮完整门禁终止：260 文件 / 1821 项通过，12 文件 / 41 项均为旧定义调用拒绝，164.33 秒（/tmp/graph-v2-full-check-121.log；/tmp/graph-sdk-cutover-failures121.json other=[]）。本批七项 merge 退出旧入口，真实恢复/版本失效/条件更新/人工交付和共用 acceptance 夹具全量均通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。全量仍红，未提交；下一完整 gate 122。完整 SDK/DAG 源码与 main 生命周期、spec 审核尚待继续，main/default app 未切换。

### 显式合并节点合同与旧隐式工厂退役（2026-10-09）

- 121 全量 1821/41，本轮处理旧 merge-resolver 工厂：真实生产 caller 为 task-runtime 自动组装，绕过 operation slot/预算账本且强制 full access/unlimited。依据 ADR 0030，不为新版增加隐式合并节点；删除 src/core/merge-resolver.ts（282 行）与 task-runtime 自动创建分支。旧 Execution 的注入式 MergeResolverChannels/attemptConflictResolution 及 conflict-merge helper 仍有旧 merge-loop 与 lower Git 测试引用，本批未声称已整体退役。
- console/matt-merge-recipe 一项通过正式声明、main 明确投递和真实 Pi 验证实际能力身份正文。console/merge-resolver 七项保留总数，改为正式节点执行：有 high 候选仍实际选择配方 medium；冻结 @1 身份而非最新 @2；标准权限实际拒绝工作区外 write_file；无配置模型保留输入且不发送；缺配方/缺指定版本在执行准入失败不发送；真实用量进入节点账本并重启不重放；有限预算正常准入并记账，不再要求不可计量的无限工厂。
- 夹具初次失败不视为产品 bug：推荐 grade 并非硬性排他，原生目录允许已有候选 fallback，因此无模型反例改为目录空；配方解析发生在执行准入，不是创建时 catalog 验证，按真实阶段核对失败输入。缺模型时队列 retained/节点 blocked，没有旧 questions 行，不用假问题兜底。
- TypeScript 通过；五文件 / 24 项聚焦通过（/tmp/graph-native-explicit-merge-siblings.log，15.17 秒）。旧主执行与冲突回调尚待退役；完整 spec 未完成，未提交。下一完整 gate 122。

- 第 122 轮完整门禁终止：262 文件 / 1825 项通过，10 文件 / 37 项失败，152.57 秒（/tmp/graph-v2-full-check-122.log）。四项原失败入口退出；七项替换合同与真实 Matt identity 均全量通过。37 项均为旧定义拒绝，其中两项 context-model 的 Vitest 比较文本截断旧拒绝说明；按稳定前缀核对分类（/tmp/graph-sdk-cutover-failures122.json other=[]），没有把错误的旧期望算原生回归。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。全量仍红，完整 spec 尚未完成，未提交；下一完整 gate 123。

### 旧冲突回调、合并判断器与文件 scope 推断整体退役（2026-10-09）

- 122 全量 1825/37。本轮 caller 核对：mergeResolvers 唯一剩余使用为旧 merge-loop 夹具，Execution.attemptConflictResolution 为 conflict-merge.ts 唯一生产 caller；contributions 仅供该判断器与私有谓词测试。删除注入式 MergeResolverChannels/MergeUsage、task-runtime options 与 Execution 自动尝试，删除 src/git/conflict-merge.ts（215 行），不把旧判断器另藏进原生模块。冲突返回真实失败并保留工作，正常原生队列/default retry 与 main 控制仍负责后续工作。
- GitIntegration.declaredScope/restoreOutOfScope/outOfScopePaths 只读取旧 nodes.input.files，原生格式不具备此字段。删除旧节点数据库耦合和自动改写 worker commit 的推断（既有原生 workspace/提交授权与验收保持）；Git infrastructure 不再导入 NodeSpec/Operation 类型，只接受实际 Git effect 必需字段。明确提交按 literal pathspec 产生稳定版本，后续修改/提交不改写旧 commit；跨 sibling worktree 的提交遭实际授权拒绝。
- merge-loop 三项换成真实两路 HTTP/Pi、私有 Git worktrees：冲突后该节点下一条输入仍 queued，main cancel 不清掉原失败；磁盘 runtime 重启保留失败输入与集成 tip，不重放 worker、不启动隐式合流；main skip 不产生 check/review 回执也不能交付单侧版本。m4/worktrees 同 owner 夹具抽取 tests/fixtures/native-worktree-graph.ts，原三项保留。
- conflict-merge 七项换成 Git 基础设施 owner 和正式 graph 验收：main 明确进行真实两父 commit resolution，GitIntegration 记录 integration，再由真实 host check + 独立 HTTP/Pi reviewer 发布精确 commit 报告，完成后才更新 target；丢一侧、无关路径修改、残留 markers 三类真实 committed candidate 留在私有副本但 host check 失败阻止 delivery；外部真实 ref 改名使 Git integration 失败而原 tip/checkout 保持；无冲突的真实两路修改无 resolver 即合并；验收后改坏内容使旧 receipt stale，显式新 check 真失败。此层直接测试 Git effect，不假装 worker/model 写出了代码；模型执行/队列归上面的真实 Pi owner。
- merge-lane-conflict 两项与 git-baseline 一项退出 NodeSpec/Proposal/假 operation casts/旧 nodes 插入：保留多次集成后冲突的精确 metadata 与已有 disjoint bytes；显式 publication 只提交文件名 *.txt 而不展开 wildcard、不包含其他已 staged 修改；节点绑定不能在 sibling worktree 提交。共用 tests/fixtures/native-git-conflict.ts，避免复制临时 Git/Pi/检查配置。
- 聚焦五文件 / 32 项通过（/tmp/graph-native-conflict-and-scope.log，12.69 秒），TypeScript 通过。测试总数保持；旧 main/context/handoff/rework 尚待退役，完整 spec 未完成，未提交。下一完整 gate 123。

- 最终相邻聚焦八文件 / 45 项全通过（/tmp/graph-native-conflict-retirement-siblings.log，13.47 秒），Git 恢复、显式 merge recipe/账本、原生 kernel Git integration 同时通过。最终 TypeScript/diff check 通过，123 全量执行中。

- 第 123 轮完整门禁终止：264 文件 / 1830 项通过，8 文件 / 32 项失败，154.71 秒（/tmp/graph-v2-full-check-123.log；/tmp/graph-sdk-cutover-failures123.json：oldDefinition=32、other=[]）。本批旧 merge-loop 三项与 merge-lane 两项退出，lower conflict 七项、Git scope 三合同及相邻恢复全量通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。剩余失败：context-model 8、predecessor-handoff-production 6、schema-upgrade 2、m6/faults 3、m8/conversation 1、rework-ui 1、rework 9、ui-flow 2；这些 caller 与仍存在的旧 main/context/handoff/rework/scaffold 源码继续退役。完整 spec 尚未完成，全量仍红，未提交、main/default app 未切换。下一完整 gate 124。

### 原生显式 handoff 合同与旧节点字段拒绝（2026-10-09）

- 123 全量 1830/32。本批 predecessor-handoff-production 原七项全部退出旧 Proposal/NodeSpec/dependsOn/containers/context.predecessors/submit_result、假 ActionAdapter/evidence/usage、私有 RESULT_HANDOFF_SCHEMA_EXAMPLE 重述；保留七项数量，使用正式 graph_create/send、两个或三个实际 HTTP provider、resident Pi、具名 submit 和明确 join 模块。旧 predecessor-handoff.ts 的 main/旧 context/lifecycle callers 尚未实删，不把测试迁移写作源码整体退役。
- 七项实际合同：模板 bundle 的公开输出直映 bundle/leaf.result，边记录真实叶来源，next 收到 value 而没有源的私有最终回复；两个来源明确提交 summary/evidence，once join 收齐后才触发，私有 transcript 不泄露；worker 再执行生成 V2，边历史 V1 不改写，next 保留原 session/回复；必需输出遗漏获得同 execution 的一次补交 delta，不重复初始任务全文，新 submit 后才投递；无效输入不发送模型、无效输出 objective 字段报错返回正在工作的模型，修正只投递一次；补交仍失败则 execution/queue 已知 failed、provider calls 都 settled，不假装 unknown/成功；实际交给模型的协议声明 string-list/object-list 元素类型，错误列表元素被 submit 拒绝后修正才向下游流动。
- 实际 RED：parseGraphDefinition 静默接受旧 context、dependsOn/when/container 字段，两个 formal schema owner 反例均未抛错（/tmp/graph-native-context-contract-red.log）。NodeDefinition 仅接受已声明 recipe/task/acceptance/inputs/outputs/submission/model/retry/budget/deliverable，未知字段给出具体 node/key 与显式连接修正指引；旧 command 使用原明确错误。context-model 前两项改为真实正式解析边界，不以旧 DAG validation 私有规则继续维持旧语言。schema 文档注释不再声称需要旧历史 reader，遵循 ADR0030。
- 初始夹具断言修正：edge history 公共接口按新到旧返回，V1/V2 核对该顺序；输入拒绝为 work.job 的 AJV required-property 文本，明确 await rejects，不用 catch 吞异常。两个 schema owner 反例已 GREEN（/tmp/graph-native-context-contract-green.log）。TypeScript 通过；五文件 / 75 项全通过（/tmp/graph-native-handoff-siblings-fixed.log，10.62 秒），submit bridge、executor、接口 parser 和八种真实模式同时验证。完整 spec 未完成，未提交；下一完整 gate 124。

- 第 124 轮完整门禁终止：265 文件 / 1838 项通过，7 文件 / 24 项失败，160.17 秒（/tmp/graph-v2-full-check-124.log；/tmp/graph-sdk-cutover-failures124.json oldDefinition=24、other=[]）。本批六个 handoff 旧入口与两个旧 context validation 退出，正式七项 handoff/字段拒绝/真实模块与模式全量通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。剩余失败为 context-model 6、schema-upgrade 2、m6/faults 3、m8/conversation 1、rework-ui 1、rework 9、ui-flow 2；仍需旧 main/context/handoff/rework 源码清理和完整 spec 验收。全量仍红，未提交，main/default app 未切换。下一完整 gate 125。

### 原生凭证排队、执行上限与暂停恢复（2026-10-09）

- 将 m8/rework 原四项并发/暂停合同从 Proposal/NodeSpec/dependsOn/自动 check 迁移到 main.graphCreate 的原生声明及具名 job 接口逐次投递；删除三个虚构 check ActionAdapter 与对应虚构 evidence。保留文件原 13 项和完整套件 272/1862 数量。真实 HTTP SSE provider、真实 daemon/config/startup、实际 resident Pi 和生产 scheduler 执行，未新增生产测试开关。其余五项旧返工/部分执行/未知用量测试与相关源码尚待迁移。
- 已验证：同 secretRef 与不同 secretRef 相同实际值均共享凭证 cap=1，startup 正式返回 alias 映射且不泄露密钥，每个 worker 实际 12 token 入账；A 的十个等待任务释放执行名额，独立 B 的 HTTP 发送与完成不受阻；二十个凭证等待任务恢复时重新取得全局执行名额，实际 HTTP 并发不超过十；二十个 pre-send 等待任务暂停后零发送、零 token、零 reservation，每次 execution blocked 且 retries_used=0，恢复原输入后全部成功。daemon 会实际运行 owner 的一轮请求，因此 alias 合同总计三次 HTTP（owner 加两个 worker），不将 owner 请求漏计。
- 定向三项通过（/tmp/graph-native-rework-admission.log，11.05 秒）、暂停一项通过（/tmp/graph-native-rework-pause.log，4.70 秒）。125 gate 在 TypeScript 阶段发现旧/native 联合类型未都声明 instance.reserved，改用公开 execution.reserved 验证零 reservation 后运行 126；125 未运行完整测试，不计为完成的全量验证。
- 第 126 轮完整门禁终止：265 文件 / 1842 项通过，7 文件 / 20 项失败，166.48 秒（/tmp/graph-v2-full-check-126.log；/tmp/graph-sdk-cutover-failures126.json oldDefinition=20、other=[]）。四项迁移合同均通过全量负载；TypeScript/lint、baseline 272/1862、evidence 与 diff check 通过。剩余旧入口失败：context-model 6、schema-upgrade 2、m6/faults 3、m8/conversation 1、rework-ui 1、rework 5、ui-flow 2。完整 spec、旧 SDK/context/main/scaffold 退役及默认 app 切换仍未完成，未提交。下一完整 gate 127。
- 下一批需保留真实部分写入、会话续用和逐次用量证据，移除旧的“未知用量可不计费释放”约定：有限预算缺失 usage 必须保持 hold，main 明确记录 authoritative usage 后再恢复；旧 test 中 synthetic proof 不应冒充供应商账单。返工通过明确 reviewer/module 接口投递，不能恢复隐式 loop 推断。

### 原生部分执行与明确返工路由（2026-10-09）

- m8/rework 剩余五项退出旧 Proposal/NodeSpec/loops/dependsOn/submit_result、问题式未知用量零释放与虚构 ActionAdapter/check/evidence；删除本文件最后的旧 checkNode/NodeSpec。文件仍是 13 项，未减少任何套件用例。新增两类共用本地夹具只驱动正式 graphCreate/graphSend/graphControl 与实际 HTTP/Pi/文件系统；没有生产专用开关。累计文件 196 行新增 / 465 行删除。
- 部分工作暂停：真实 write_file 已写出 partial.txt，在第二次供应商准入时暂停；原 execution blocked、零 reservation、retries_used=0，首调用实际 usage 50；恢复沿原 execution/instance/session 读到原写入及工具历史，第二调用累计 100，未重放写入。有限预算未知响应不会执行其 write_file，初次夹具假定未知工具仍写入而 ENOENT；改为先已知写入、再未知工具响应，核对缺失用量期间 unmetered.txt 确实不存在。缺失 usage 的 reconcile 请求明确拒绝，普通 resume 不解 hold；具体 call usage 核对两次只入账一次，再显式 node resume 回原会话/执行。混合两次真实写入后未知第三调用，已知 100 立即保留、核对至 150、续跑至 200，两份文件和 session/execution 身份不变。
- 明确返工：独立 reviewer 通过 submit 提交 passed:false 与真实 reason，each 路由模块将 $review 投递给 work.job；第二轮仅注入失败 delta，原任务和初始输入不重复，worker 保留自己的 PRIVATE_FIRST_WORKER_REPLY 而没有 reviewer 私有回复。两次 worker 结果分别形成不可变边投递，模块通过结果交公开 approved。未知用量发生在第二轮真实 fix.txt 写入之后，第一 execution 已完成、第二 blocked，审查只收到第一结果，公开通过输出为空；核对实际 call 后原第二 execution 继续 submit 第二结果，独立 reviewer 再执行后才产生 approved，无第一轮成功复用或已提交输出重发。
- 定向三项部分执行/用量通过（/tmp/graph-native-rework-partial.log，2.82 秒）；完整 rework 文件 13 项通过（/tmp/graph-native-rework-all.log，22.35 秒）；TypeScript 通过（/tmp/graph-native-rework-typecheck2.log）。新 fixture 不把 usage proof 文本当供应商账单，实际 provider 未报告的 usage 保持 unknown，测试只通过 main 明确写入该 call 的核对值。运行完整 gate 127。旧 execution/context/handoff/main scaffold 源码仍有活跃引用，未声称已实删；完整 spec/默认 app 仍未完成。

- 第 127 轮完整门禁终止：266 文件 / 1847 项通过，6 文件 / 15 项失败，162.91 秒（/tmp/graph-v2-full-check-127.log；/tmp/graph-sdk-cutover-failures127.json oldDefinition=15、other=[]）。m8/rework 全部 13 项在全量负载下通过（45.449 秒），本批五项旧图入口已退出。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。剩余失败：context-model 6、schema-upgrade 2、m6/faults 3、m8/conversation 1、rework-ui 1、ui-flow 2。旧 execution/context/handoff/briefing 仍有生产 main/operation-lifecycle/pi-adapter 与其他测试引用，源码实删须随这些入口迁移后执行，不保留兼容转换器。完整 spec 尚未完成，全量仍红，未提交或切换默认应用；下一完整 gate 128。

### 原生实时图与浏览器流程入口（2026-10-09）

- rework-ui 原一项及 ui-flow 原两项退出 Proposal/NodeSpec/containers/loops/dependsOn、虚构 Agent/check ActionAdapter、虚构 usage/evidence 和 withIndependentReview fixture；保留两文件全部四项数量（包含不变 cursor 合同）。本批测试净减少 43 行：71 新增 / 114 删除，未新增生产开关或修改图执行规则。遵循 test-audit 与 e2e-race-conditions：只等目标状态/元素，未加入固定延迟。
- 实时图：实际 HTTP provider/resident Pi submit LIVE_RESULT_VALUE，显式边触发实际 node --version operation 模块，浏览器已打开的同一 URL 从 Agent idle 更新到 Agent/模块 succeeded，不导航、不 load more；正式 edge history 核对真实投递，正式 operation 核对 ok=true / result code=0 passed=true。初次断言误用 exitCode 字段，按正式 operation 输出结构修正，未伪造 operation 成功。
- 项目流程：A 的原生 graph 通过真实 submit 和宿主 command 完成后由 main 显式 complete；浏览器打开 Agent 独立 tab，再关闭仍保留图状态。B 为另一个 project 的独立原生 graph，仍 idle，B owner inspect A 明确 permission 拒绝；图 tab 的 A/B 名称分离，直达 A URL 重载后恢复节点。此测试证明控制台流程/项目分离，不声称无审查的 UI fixture 证明 Git 交付；真正精确 Git/check/独立 review 交付由 nativeGitAcceptance 与 final-acceptance/m7 等主合同覆盖。
- 复杂结构：可复用 branches@1 子 graph 实例 grp 内两 Agent、once join 模块、两个具名输入、显式 feedback 边和公开输入/输出映射；浏览器核对真实 grp/feedback 直角路径、容器实际包围 grp/left，折叠后 leaf DOM 消失、展开恢复。保留未知 task 与实际 HTTP 500 注入后明确错误显示，未保持旧 loop: ID 或旧扁平 container 伪模型。
- 定向两文件 / 四项通过（/tmp/graph-native-ui-flow.log，6.93 秒），TypeScript 通过（/tmp/graph-native-ui-typecheck.log），diff check 通过；正在运行完整 gate 128。此批退出三个旧入口失败，仍有旧 context/history/fault/main scaffold 代码引用；完整 spec 和默认 app 切换未完成，未提交。

- 第 128 轮完整门禁终止：268 文件 / 1850 项通过，4 文件 / 12 项失败，162.06 秒（/tmp/graph-v2-full-check-128.log；/tmp/graph-sdk-cutover-failures128.json oldDefinition=12、other=[]）。ui-flow 全部三项与 rework-ui 一项均在全量负载下通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。剩余失败：context-model 6、schema-upgrade 2、m6/faults 3、m8/conversation 1。下一批 worker 非合规结果应以原生 required outputs/submit 协议失败、系统通知与 main 明确 retry/人工处理实现，不能恢复隐式前驱 handoff 修补回路。源码旧 execution/context/handoff/main scaffold 退役及完整 spec/默认 app 切换未完成；全量仍红，未提交。下一完整 gate 129。

### 原生交付失败、main 通知定位与用户决定回投（2026-10-09）

- m8/conversation 最后一项旧 graph 入口退出 Proposal/NodeSpec/dependsOn/context.predecessors/result_handoff/非合规隐式修补问题；替换旧 scripted worker/next/master、虚构 usage/check/evidence，使用四个实际 HTTP provider（main、worker、next、composer suggestion）、真实 Pi、具名 submit 和 main 管理控制。文件保留 41 项，未减少用例。旧 result_noncompliant/noncompliance_decision 源码还有 operation-lifecycle 等引用，尚未实删。
- 非合规 result 缺少协议要求 objective，实际 submit 工具返回 output_protocol_mismatch/objective 拒绝；一次自动补交仍无有效输出，原 execution failed、resubmits_used=1，三个真实 worker 请求、零 next 请求、零边投递。main 实际 model turn 收到失败通知，向用户说明缺失目标；用户通过 conversation.chat 提供决定，main 实际请求读到该内容。main 明确 skip 保留的失败 queue，然后 graphSend 将用户决定和修复理由投递原 work.job；沿原 instance/session 新 execution 提交合法结果，只有 FIXED_AFTER_ESCALATION 通过边进入 next，BROKEN_HANDOFF_SENTINEL 没有泄露给 next，新输入不重复顶层 TASK_REQUEST_SENTINEL。
- 初次夹具错误已查清：控制台的 composer suggestion 会在每轮 main 回复后选独立较小模型，本 fixture 的 worker 首条 provider plan 被建议请求消耗，导致后续 script 不对齐。供应商请求实读 lastUserMessage/assistantReply 确认，未把此事误报内核错误。按生产模型目录配置单独 low-grade suggestion provider，真实请求正常完成，未添加测试禁用开关或从 fixture 隐藏内部请求。
- 真正 RED：失败通知写 Node work 与 reason，但没有完整 graph ID，main 请求中只有状态摘要缩写 ID，无法可靠调用 graph_inspect。/tmp/graph-native-conversation-failure.log 直接实际 main model 请求未包含完整 graphId。修复 wakeForBlockedNode 持久 intent data 包含 graphId，renderWakes 同时显示节点、完整 graph 与原因，沿现有去重/消费机制，不发业务输出或重建旧 handoff 问题。正式 notify owner 反例 GREEN（/tmp/graph-native-conversation-failure-green.log，3.44 秒）。TypeScript 与 diff check 通过，正在运行完整 gate 129；完整 spec 和默认 app 切换仍未完成，未提交。

- 第 129 轮完整门禁终止：269 文件 / 1851 项通过，3 文件 / 11 项失败，177.22 秒（/tmp/graph-v2-full-check-129.log；/tmp/graph-sdk-cutover-failures129.json oldDefinition=11、other=[]）。conversation 全部 41 项、wake-ledger 全部 13 项通过，真实 main 通知 graph ID 修复和用户决定回投通过全量负载。TypeScript/lint、272/1862 baseline、evidence 与 diff check 通过。剩余旧入口失败：context-model 6、schema-upgrade 2、m6/faults 3。源码两行替换，测试 57 新增 / 111 删除；没有兼容转换器或删除原用例数量。完整 spec、旧 execution/context/handoff/scaffold 实删及默认 app 切换仍未完成，全量仍红，未提交。下一完整 gate 130。

### 原生 Git 副作用、未知用量与硬进程恢复（2026-10-09）

- m6/faults 原三项完全退出旧 Proposal/NodeSpec/dependsOn/ActionAdapter/withIndependentReview、虚构 Agent usage、手写 sandbox check evidence、旧 host.report/reconcile 回调。tests/fixtures/m6/crash-git.ts 改为实际 HTTP/Pi/原生 graph 的子进程 fixture，不保留兼容层；只有 faults 一个 caller，已核对。nativeGitAcceptance fixture 增加 workPlans 自定义真实 provider 响应序列，供这批共享现有真实 Git/check/独立 review setup，不增加生产测试开关。三项数量不变。
- 幂等：真实 worker write_file 后 submit 同一结果两次、再 submit 不同结果，前两次同 execution 的同内容 replay、第三次收到 already_submitted，磁盘 kernel_submissions 恰一项、原 execution completed；真实 command 检查和独立读取/已发布 commit review 通过，main complete 两次、重启后均只有一项 kernel_completion_delivery，target HEAD 仍为最初验证的 commit，worker 五请求/reviewer 三请求不重跑。初次断言用了不存在的 submission_conflict 名，按实际工具 refusal code already_submitted 修正，没有放宽一项正式提交约束。
- 未知用量：真实 write_file 与 workspace_commit 已完成、第三响应没有 usage，worker used=100、hold 保留，真实 HEAD 含 feature.txt 而目标仍 baseline。重启后无新供应商请求/新 Git commit；main 明确核对第三 call 50、resume 原节点，沿原 execution/session/instance 完成 submit 与最终回复，累计 250、原 worktree HEAD 不变；实际宿主 check 与独立 reviewer 通过后才交付 target，写/commit 不重放。
- 硬崩溃：子进程使用生产 native runtime，在真实 worktree 已 commit 后第三 HTTP send inflight 时回报观察到的正式执行/call 身份，父测试确认供应商已看到第三请求后 SIGKILL 整个 runtime owner（没有模拟 killed 标志）；晚到响应不能恢复已死 owner 的落账。重新获得 owner lock 后原 execution blocked、原两调用已知 100、第三 call unknown、无自动派发，commit 字节仍可 Git show。main 核对实际 call 并 resume 原 execution/session，worker 总五请求，原 HEAD 不变；首次真实 check/review 后 target 独立推进，complete blocked、两项 stale。明确 withdraw_complete 与第二次 check/review 才产生新验证 commit，最终同时保留 feature.txt/extra.txt；实际 module operation 两次、独立 reviewer 六请求，worker 不重放。
- 故障与相邻验收/合并三文件 / 18 项通过（/tmp/graph-native-git-faults-siblings.log，16.51 秒），TypeScript 与 diff check 通过。正在运行完整 gate 130；旧 SDK/context/main/history 源码和完整 spec 尚未完成，未提交。真实进程 fixture 不接受手写 reconcile result/evidence 作为恢复证明。


### 原生启动废弃旧 graph 与同库升级（2026-10-09）

- 完整门禁 130 已终止：270 文件 / 1854 项通过，2 文件 / 8 项失败，168.07 秒；/tmp/graph-v2-full-check-130.log、/tmp/graph-sdk-cutover-failures130.json。8 项均为旧定义入口拒绝，context-model 6、schema-upgrade 2。272/1862 baseline、evidence、diff check 均通过，m6 真实硬崩溃/Git 副作用三项通过全量。
- schema-upgrade 两项旧 DAG 流水线改为真实 v13/v17 SQLite 启动、HTTP、热配置、原生 Pi/submit 和重启测试；第三项 v23 schema 迁移暂保留，不作为旧图历史 reader。原文件仍 3 项，不使用 ActionAdapter、虚构 check evidence 或旧 graph 转换。
- 实际 RED：旧 graph HTTP 返回 200，仍占用 legacy-model 配置绑定；/tmp/graph-native-upgrade-red.log。ADR0030 明确旧图丢弃，因此修复 runtime 启动：KernelStore 建表后、恢复前，原子删除没有原生 revision 的旧节点/提案所属任务和其调用、实例、预算、上下文、问题、Git/产物元数据及幂等回执。保留 project/catalog/config 基础设施、conversation anchor 和 native graph owner；native graph 不参与删除。事务 deferred FK 在 COMMIT 检查，失败释放 owner lock，不禁用外键，不转换旧定义。
- GREEN：旧图 HTTP 返回正式 not_found（现有 HTTP 错误约定 400），列表无旧 ID、模型配置无需保留 legacy-model 即能热更新；旧实例/invocation 消失。同一个 SQLite inode 运行真实 Pi submit，将 upgraded:true 交给公开出口；关闭重开后外部 main 能读取相同 results/executions，供应商只有两请求，无重跑，PRAGMA foreign_key_check 空。
- 升级及相邻 m6 故障/m1 恢复 3 文件 / 11 项通过，9.66 秒，/tmp/graph-native-upgrade-siblings.log。TypeScript/diff check 通过。旧 graph 私有目录/不可达 object bytes 没有被此元数据事务盲删；旧源码 scaffold、上下文路径、schema 迁移旧表、完整 spec 审计及默认 app 切换仍未完成。下一完整 gate 131；未提交。

- 第 131 轮完整门禁终止：271 文件 / 1856 项通过，1 文件 / 6 项失败，178.91 秒；/tmp/graph-v2-full-check-131.log 与 /tmp/graph-sdk-cutover-failures131.json。6 项均为 context-model 旧定义入口拒绝；没有其它故障。schema-upgrade 三项、m6 硬崩溃恢复、原生队列/返工重启、main conversation 与 HTTP 配置全量通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。启动旧图元数据废弃已经通过完整负载；context/Fork/predecessor/main scaffold 及完整 spec/默认 app 交付仍未完成，未提交。下一完整 gate 132。


### 原生上下文主边界与旧 graph Fork 解析退役（2026-10-09）

- context-model 保留 14 项，整份退出 NodeSpec/Proposal/dependsOn、context.predecessors/Fresh/Fork、手写 operations/handoffs/artifacts/预算 SQL、虚构 program check/evidence/usage；改为真实 HTTP provider、Pi、原生具名 submit、发布/read 工具、显式 router projection、graphPatch 和重启。删去旧私有 parser/recovery/source graph/context binding 测试，不用新旧转换器补测。
- 原生独立 instance/session/预算：source 第一次 50、peer 50，source 复跑累计 100，peer 仍 50；本节点续用自己的历史，peer 不读 source 私聊。接收节点实际 model 请求包含具体任务/验收/逻辑接口/协议字段/激活 value/图节点，发送者完成私聊不进入接收上下文。
- 显式 router 只映射 source.evidence，接收者看见实际证据而看不到 source summary/private transcript；artifact reference 缺少 version 由 submit 返回 output_protocol_mismatch，自动补交仍不满足则保留失败输入，零下游请求/边投递。未发布私有文件的接口 value 原样保留，不编造 digest/absolute path/artifact；实际文件经相对路径发布后，digest 匹配真实字节，接收者 artifact_read 读到稳定版本而不继承发布者私聊。
- 同一 logical publication 发布 v2 后，接收者再次按原 v1 引用读取仍读 v1。真实 workspace 外文件发布被拒绝，没有共享产物或下游工作。两次 subgraph template 实例的聊天历史/预算独立；一个实例复跑不读另一实例聊天。重启后原节点续跑保留 instance/session/累计用量与原 briefing，仅新 input delta 不重复初始任务和验收。
- 配方改变在下一 execution 明确生效，供应商实际 developer/system identity 包含新规则，实例身份及原聊天历史/累计额度保留；复用 ADR0011/0030 已确认的能力重绑机制，session 文件/ID 会分支而不会丢聊天历史。初始测试错误限定 system role 和固定 session ID，实际 OpenAI 请求使用 developer role，且 session inspect 明确 rebind，已按真实 spec 边界更正断言，没有报成产品缺陷或修改机制。
- 两项其他夹具错误也记录：字段映射用 source.evidence 而非 $source.evidence（后者代表整个具名输入）；未请求 Git worktree 的 graph 节点 workspace 是 project，因此 workspace 外发布反例文件必须放在 project 之外，而非项目内。没有放宽生产发布边界。
- context.ts 删除旧 graph context request validator、跨节点 transcript/fork 判定、共享 budget/parent instance 设置、fork constraints 校验与 branch_created 路径；正式 resolver 只服务外部 main 的 fresh/continue，不接收 graph node/context。graph 节点仍走 resident/native input/session 路径，未迁移到旧 resolver。删除无任何 caller 的 recoverResultHandoffDraft wrapper，并移除旧 Execution 向 main resolver 传 reviewer/model exclusion 的参数。旧主会话 context/handoff 表和其它前驱 parser/settlement/scaffold 仍待退役，不能视为全部源码退出。
- context/handoff 与 main/conversation capability 四文件 / 72 项通过（/tmp/graph-native-context-main.log，27.39 秒）；全原生 context/handoff 两文件 21 项此前通过（/tmp/graph-native-context-all-green.log，12.82 秒）。最终 TypeScript、diff check 通过。下一完整 gate 132；完整 spec 和默认应用交付尚未完成，未提交。


### 真实配置快照时序与设置页生效版本回退（2026-10-09）

- 第132轮完整门禁结束：271 文件 / 1861 项通过，1 文件 / 1 项失败，181.61秒；/tmp/graph-v2-full-check-132.log、/tmp/graph-sdk-cutover-failures132.json oldDefinition=[]、other=设置页 autosave 生效版本未清除“正在同步”。context-model 14 项及所有旧定义入口迁移测试全量通过；这是新的 UI 配置时序失败，不计为旧 graph 入口失败。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。
- 隔离原用例通过（/tmp/graph-native-settings-single.log，5.96秒），没有把“单独绿”当作产品正确。按 e2e-race-conditions 技能读取 Settings/load/startup/persistDraft 和真实 /api/config GET/POST；GET 已经提供同一响应的 revision/effectiveRevision，客户端只读前者，启动 snapshot 则无条件覆盖有效版本。
- 稳定 RED：在原 settings autosave 主合同内延迟真实 /api/startup 响应，等待服务端取出旧快照；通过实际 HTTP POST 对磁盘现有精确配置热保存得到新 revision（不改变模型/凭据/限额），浏览器 config GET 再读真实新 pair，随后释放旧 startup。等待由该 startup handler 渲染的 source-root，确保旧快照确实被处理；运行版本低于新 saved revision，/tmp/graph-settings-stale-startup-red.log，20.73秒。同一个10项测试文件，无新增计数、伪造响应 body、固定 sleep 或放宽断言。
- 修复 Settings 读取 config response 的 effectiveRevision，启动 GET、config GET、POST receipts 只允许推进已知生效版本，不允许晚到旧快照回退。保留保存/生效不同的真实状态，不把未知或未应用当已应用。两次早期夹具尝试也如实记录：延迟所有初始 startup 后又有后续 save，会冲掉反例；只有明确控制同一次设置页面的启动/配置响应与实际热保存顺序才形成稳定 RED。
- Settings 全部10项 GREEN（/tmp/graph-settings-stale-startup-green.log，20.14秒），TypeScript/diff check 通过；仍需相同全量负载验证，下一完整 gate133。源代码 Fork/predecessor/main/SDK scaffold、模型small/medium/frontier目录、统计与完整spec/默认app交付仍未完成，未提交。

- 第133轮完整门禁终止：272 文件 / 1862 项全部通过，178.81秒；/tmp/graph-v2-full-check-133.log、/tmp/graph-sdk-cutover-failures133.json failures=[]。TypeScript/lint、原始272/1862 baseline与tracked evidence检查通过，diff check通过。旧上下文测试已完整退出旧定义/私有上下文 SQL，旧 graph Fork resolver 删除以及真实设置快照回退反例在全量负载下通过。当前并未完成完整目标：Pi adapter 旧 graph Fork/审查分支、predecessor parser/settlement/history/main/ActionAdapter scripted scaffold、旧 GraphPlan/GraphState/types/layout 投影、模型 small/medium/frontier 目录、当前/下一配置展示、统计、规范/术语/使用文档和默认 app 交付仍需逐项实证；不能据全绿认定 spec 完整或旧SDK全部删除。尚未提交，下一门禁134。


### 冻结执行配置展示、旧 Fork 适配器与脚本执行路径退役（2026-10-09）

- 第 134 轮完整门禁通过：272 文件 / 1862 项，176.74 秒；TypeScript/lint/baseline/evidence 全过，日志 /tmp/graph-v2-full-check-134.log。旧 graph 的 AgentContextMode 已删除 fork，Pi adapter 的跨节点 Fork 校验/创建分支已删除；通用 Pi session API 的自身历史分支不冒充 graph Fork，仍供合法会话重绑使用。
- 扩展现有真实 Pi/MCP 用例，在旧 worker@1 的供应商响应进行中发布并 graphPatch 为 worker@2：修复前 nodeRun.instance 错报 worker@2，红证据 /tmp/graph-frozen-config-red.log；修复后当前执行配置取 execution.revision_version，下一次配置取最新声明。prompt 身份取实际 recorded execution 的 revision，模型取该 execution 的实际 provider call，不把新配方标到旧 prompt 上。
- 原生 prompt/run 提供 configurations.current/next/pending；只比较节点声明与 defaults，不因其它节点变更的 revision 数字不同而标成待生效。未执行没有 current，移除节点没有 next。界面显示当前与下一次配方，待生效时可查看下一次声明，实际 prompt 字节保持独立。
- 聊天的现有 SSE 刷新补收 graph.* 原生事件；graphPatch 在同一事务中记录 graph.patched。详情沿聊天刷新实际 prompt，并用请求序号拒绝旧请求覆盖新结果。真实 Chromium 保持窗口打开，验证 coder@1 当前、coder@2 下一次及原始发送 prompt；未添加轮询。3 文件 52 项运行时用例通过，浏览器 3 项通过，均纳入 gate134。
- 删除 task-runtime 的 options.actions → scriptedTurn 桥、kernel-graph-lane 的 scriptedHost、processId=0、自动生成 submit output 与 0 usage 执行替身。操作模块仍无需模型，agent 节点走配置模型的实际常驻 Pi。旧测试文件 scripted-lane.test.ts 迁移为 native-repair-freeze.test.ts，保持一项主验收，不维护生产中的测试专用执行路径。
- 迁移用例真实 HTTP/Pi 完成 5 次模型发送：缺少必需输出后补交一次，当前 task/recipe 不随执行中的 patch 改变，下一 execution 才使用新身份/任务；公开结果实际产生两次，原 instance 保留，用量分别累计 150/250。定向用例与主/Web TypeScript 通过，日志 /tmp/graph-scripted-retirement-test.log、/tmp/graph-scripted-retirement-types.log。删除路径后的完整 gate135 正在运行，不提前宣称全量通过。
- 完整 spec、旧 main/SDK/DAG scaffold 全部移除与默认 app 交付仍未完成；此批未提交。


### 无 Pi 的旧脚本执行替身：剩余夹具迁移（2026-10-09）

- gate135 完整结果为 266 文件 / 1841 项通过，6 文件 / 21 项失败，174.83 秒；日志 /tmp/graph-v2-full-check-135.log、分类 /tmp/graph-sdk-cutover-failures135.json。全部来自残留的无模型 graph ActionAdapter 夹具：console/git-admission 4、m2/revision 2、m3/planning 1、m4/command-check 11、m5/http 1、m8/v2-completion 2；没有恢复已删除的生产 scriptedTurn/scriptedHost。
- 上述六份夹具逐个改为真实 HTTP provider、Pi、submit、文件工具、工作副本、正式 API。main planning 用真实 propose_graph，不以回调直接替代主 agent 的提案工具；真实请求确认 main 读到私聊 marker，worker 只读显式任务/验收与投递值。revision 仍保留四项原有行为；completion 三项仍区分成功节点、确认的人类验收与缺少必需输出。
- Git 准入以真实 provider 请求数证明 dirty baseline 拒绝时没有发送，明确基线后才发送；工作副本通过公共 worktrees 元数据检查，并保留文件字节/项目目录隔离断言。公共 worktree path 是 Git 根；有 projectSubdir 时实际工作位置要加该子目录，不能误把投影字段改成会话 cwd。
- 初次迁移误用 Pi 通用工具名 write，原生图实际工具为 write_file。真实工具结果明确 Tool write not found；旧脚本直接宿主写文件绕过了这个边界。纠正后要求 worker 工具结果无 isError，避免空的 node --test 偶然通过掩盖根本没有写测试文件的情况。所有原有 TMPDIR、loopback/子进程守卫、依赖解析、检查失败、命令拒绝及固定版本断言保留。
- submit 成功立即投递，而代码集成在执行结束时结算，两者按 spec 分开。command-check 夹具不再假定 submit 已完成集成：结构中的自动检查边明确禁用，main 在真实 worker 成功并集成后显式投递 check.job；命令仍严格验证最终集成 commit、stdout 和 receipt，不伪造证据或延迟生产 submit。
- HTTP 暂停用例以真实进行中的 provider 响应作为并发边界，恢复后补交必需输出。不能用旧 ActionAdapter 无条件自动提交，也不能在已经成功 submit 的执行上以恢复为由重复发送。定向用例已通过，并补充单 execution、一次补交/零自动重试、三次真实请求和累计 150 token 的断言；这些新增断言纳入 gate136。
- 迁移定向：m2/revision、m8/completion、native-repair-freeze 与 m3/planning 通过；m4/command-check 12、git-admission 10、m5/http 其余 5 通过，最后暂停定向也通过。主/Web TypeScript 与 diff check 通过。gate136 正在运行；完整退役/spec/default app 未完成，未提交。


### 外部 main 执行器退役旧 DAG 调度与前驱组装（2026-10-09）

- gate136 已终止并全绿：272 文件 / 1862 项，190.09 秒；TypeScript/lint/baseline/evidence 通过，日志 /tmp/graph-v2-full-check-136.log。删除 scriptedTurn/scriptedHost 后剩余六份真实合同夹具均完成迁移，没有为绿灯恢复生产替身。
- Execution.readyNodesFor 只接受 chatting/discussing 的外部 master；删除 running 旧 graph loadGraph/readiness/skip/activation 调度循环。执行前明确校验 role=master/kind=agent。原生内部节点通过独立 native lane，不能重新落入旧扫描器。
- 删除 main 准备阶段的 loadGraph inputs/sources/inputVersions、graph.verify 隐式审查说明、旧 reworkDelta、Fresh predecessor handoff、result_handoff schema/repair 拼装、依赖 artifact 自动 reader 记录及 review.independence_checked。main 的自身消息/原始需求、提案摘要、能力、RSI/暂停恢复、wake、决策与自己会话继续保留；旧 context 账本的自身 fresh/continue 尚未全面更名/移除。
- model-selection 删除旧 implementerModels 的 GraphPlan containers/leaves/dependencies 遍历及 isReviewer/context 推断。此模块的唯一生产入口是外部 main 的 pickModel；原生 graph reviewer 的模型独立性仍由 kernel-graph-lane 的实际 provider 历史约束，不能用 main 的旧图遍历补造历史。
- 删除 main Execution 内重复的 graph declaredDeliverable/publish/withDeliverableArtifact、dependsOn 集成锁、agent 结果隐式代码合并和旧 reconciliation integrate。原生 node-executor/Git/module acceptance 的真实交付路径保留。main 仍通过明确的图管理与 workspace 工具管理工作，不能由结束一轮聊天隐式交付 graph。
- 定向 6 文件 / 75 项通过，日志 /tmp/graph-main-dag-retirement-targeted.log，涵盖真实 main 对话/提案、队列、能力与 RSI 恢复。进一步清理后主/Web TypeScript 再通过；第137轮完整门禁进行中。diff check 通过。仍需退役 OperationLifecycle 的旧 result_handoff/路由/验收/返工分支、GraphPlan/types/read views，以及完整 spec/default app 交付；未提交。


### main 生命周期停止隐式旧图路由、返工与验收（2026-10-09）

- gate137 完整通过：272 文件 / 1862 项，183.64 秒；TypeScript/lint/baseline/evidence 全过，日志 /tmp/graph-v2-full-check-137.log。main Execution/model-selection 的旧 DAG 调度及上下文/Git/产物结算分支退役已通过完整负载。
- 将原 OperationLifecycle 的旧 graph.verify 三轮停滞夹具改成外部 main 普通结构化 review 内容的主边界反例。修复前 lifecycle 因 output.kind=verification/outcome=rework 进入 handleRework → backEdges → loadGraph，main 没有旧 graph revision 导致 Cannot read properties of undefined (reading spec)；/tmp/graph-main-implicit-rework-red.log。不是运行失败重试，而是普通业务内容被隐式当控制指令。
- 删除 OperationLifecycle 的 resolveRouteCase/backEdges/routeSourceOf、handleRework 三轮停滞与节点重激活、clearStaleHandoffRejections、settleResultHandoff/结果修复控制、旧 graph evidence 生成/验证/落账与 route 返工分支；删除旧 answer 的 rework/stalled 跨节点 reactivate。原生 graph 问题答复仍在独立 kernel 入口处理，不能借 main lifecycle 重新计算旧依赖。
- main 普通结果仍按 outcome 结算、保留原 output、用量/未知 usage/预算/瞬时错误重试/排队/恢复；不按其业务内容自动创建循环、验收证据或停滞问题。反例修复后 succeeded，原 stall_count=2 未变，零 open questions。图的返工和审查通过显式原生模块/接口表达。
- 5 文件 / 69 项定向通过，含 main lifecycle、真实 main conversation/planning、HTTP pause 与真实 Git final acceptance；主/Web TypeScript、diff check 通过。/tmp/graph-main-lifecycle-retirement-targeted.log、/tmp/graph-main-lifecycle-retirement-types.log。gate138 已启动，尚未宣称完整通过。
- legacy-routing.ts 已没有生产入口，但仍有旧单元测试引用，尚未删文件；router-action/briefing、GraphPlan/types/read projections、旧 main context SQL 等待继续退役；完整 spec/default app 未完成，未提交。

### 旧路由生命周期夹具迁移与真实请求读取（2026-10-09）

- gate138 完整终止：270 文件 / 1855 项通过，2 文件 / 7 项失败，184.60 秒；6 项旧 router-action-e2e 夹具仍依赖已删除的生命周期结算器，另 1 项 completion 夹具把两个节点并行发送给同一按序响应的 provider，结果分配不确定。日志 /tmp/graph-v2-full-check-138.log、分类 /tmp/graph-sdk-cutover-failures138.json。
- router-action-e2e 六项全部改为正式 graph API、真实 Pi/HTTP、实际 command 模块和显式 router：成功检查只启动通过分支，失败业务结论与真实非零退出只启动返工分支并保留理由；无匹配规则不编造分支，缺少协议必需字段在判断前拒绝，未声明输出的 patch 原子拒绝。没有恢复旧 resolveRouteCase/OperationLifecycle 路由。
- 迁移中 node -e 被正常命令准入拒绝，改为允许的 node --test missing.test.js，实际 code=1；规则缺少可选字段原本就按无匹配处理，不能误断言它是模块执行失败，缺字段负例改用必需协议字段。completion 先确认第一个节点执行完成，再投递缺输出节点，避免 provider 响应分配歧义。
- gate139 完整终止：271 文件 / 1861 项通过，1 文件 / 1 项失败，184.76 秒；唯一失败是夹具把整份请求再次 JSON.stringify 后检查未转义的消息片段，实际返工路由与 code=1 均通过。日志 /tmp/graph-v2-full-check-139.log、分类 /tmp/graph-sdk-cutover-failures139.json，oldDefinition=[]。此前定向已出现该断言失败，仍误启动全量，不能称那次定向为通过。
- 修正 helper 读取真实 messages.content 文本及文本块，保留 failed verdict 的原断言。两文件 / 9 项定向通过，4.91 秒，/tmp/graph-native-router-migration-final.log；gate140 已启动，结果待终止后记录。旧源码整体退役、完整 spec 与默认应用交付仍未完成，未提交。

- gate140 完整终止并全绿：272 文件 / 1862 项，191.30 秒；TypeScript/lint/baseline/evidence 通过，/tmp/graph-v2-full-check-140.log。完成夹具的响应顺序及全部真实 router 合同在全量负载下通过。

### 启动时清理仅剩修订历史的旧图（2026-10-09）

- 启动清理原来只识别非 master 节点或旧提案；如果节点/提案已删除、graph_revisions 尚在，旧图仍会出现在 HTTP 任务列表。扩展现有 v13/v17 真实数据库升级用例，明确插入只有旧修订的 task；未修复时两个版本均在 HTTP 列表断言失败，/tmp/graph-history-retirement-red-final.log，2.60 秒。
- 首次夹具用 INSERT SELECT 从旧 fixture 的空 graph_revisions 表复制，未实际建立修订；该次失败不能证明目标反例，日志 /tmp/graph-history-retirement-red.log 与 /tmp/graph-history-retirement-green.log 不算有效 RED/GREEN。核对真实 fixture 表后改为明确 INSERT，恢复旧生产条件重新取得上述有效 RED。
- retireLegacyGraphs 将 graph_revisions 纳入旧图识别，仍优先排除原生 kernel revision、conversation anchor 和 kernel graph owner。沿同一事务删除 task 归属历史，不新建数据库、不转换旧定义。扩展用例继续验证 HTTP not_found、配置热保存、真实 Pi 输出、原生结果重启不重放、inode 与 foreign_key_check；并检查旧历史 task 与修订均消失。定向与全量结果待完成后补记。

- 两文件 / 44 项定向通过（/tmp/graph-history-retirement-green-final.log，22.86 秒），包括真实数据库升级、原生 Pi 执行/重启和外部 main conversation 合同；第141轮完整 gate 正在运行。规范副本第11/13节同步 ADR0030 已确认决策，删除过时的只读兼容、归档/转换与等待旧运行措辞；本次没有改变产品契约，也未更新远端 Issue。
- 后续必须完成的已核对缺口：kernel-views 的 operation/timing.runMs 和 waitingMs 仍为 null，NodeDetail “实际工作时段之和”因此未实现，不能用 elapsedMs 伪装运行时间；catalog/models.ModelGrade 仍为 low/medium/high/highest，small/medium/frontier 目录及旧配方的明确别名尚未实现；NodeDefinition 未提供节点自己的工作位置声明，需核对共享项目/私有 worktree 的实际边界。旧 graph.ts/types/read views、briefing/router-action、Pi submit_result 与前驱 parser 的剩余生产引用也未全部退出，默认 app 构建、交付和全规格逐项验收未完成。未提交。

### 设置快照反例隔离先前自动保存（2026-10-09）

- gate141 完整终止：271 文件 / 1861 项通过，1 文件 / 1 项失败，187.82 秒；/tmp/graph-v2-full-check-141.log、/tmp/graph-sdk-cutover-failures141.json。新增的两个旧历史图升级反例在全量通过；失败是 settings-ui 的外部热保存返回400，未取得预期200，oldDefinition=[]。不是历史图清理失败。
- 核对 Settings.persistDraft/unmount 与配置 store.save 的真实并发控制：前面模型已经出现在列表、默认模型已保存，并不能证明最后的 grade/context/maxTokens 自动保存结束。测试随后独立 GET revision、再读磁盘 document、再 POST，期间尚有浏览器保存时可产生 config_conflict。gate141 没有打印错误正文，故具体错误码仍是基于调用时序的推断；新断言补充正文，避免下次只看到400。并发写入拒绝是正确行为，不能去掉 expectedRevision 或让服务端默认接受覆盖。
- 改为等待真实 config 字段全部持久化，以及界面“正在保存/等待自动保存”均消失；之后才建立 startup/config 延迟顺序。外部热保存从同一次磁盘读取取得 revision/document，仍严格要求200、版本推进、延迟旧startup被处理后有效版本不回退；响应错误正文保留在失败诊断中。不加固定 sleep、不重试冲突掩盖错误。
- 设置文件全部10项通过，/tmp/graph-settings-hot-save-order-final.log，19.38秒；首次编辑与同用例后半段 document 重名导致 transform 拒绝，已修正命名，不计为行为测试结果。第142轮完整门禁进行中，尚未宣称最终全绿；完整 spec/默认应用交付仍未完成，未提交。

- gate142 完整终止并通过：272 文件 / 1862 项，185.96 秒；TypeScript/lint/baseline/evidence 均通过，日志 /tmp/graph-v2-full-check-142.log，分类 /tmp/graph-sdk-cutover-failures142.json failures=[]。设置并发保存顺序及两个旧历史图清理反例均在完整负载通过，diff check 通过。本轮源码变更为旧历史图候选条件补齐，另完成路由/完成/设置夹具的真实边界修正及规格切换文案对齐；完整旧源码退役、模型目录、节点工作位置/统计、默认应用交付及逐项 spec 验收仍需继续。未提交，下一完整门禁143。

### 原生节点运行与名额等待时间（2026-10-09）

- 上一目标轮为实际进展：旧历史图识别补齐、有效数据库反例与完整 gate142 通过。本轮针对 spec 节点运行统计缺口，原 kernelNodeRun.operation/timing.runMs、waitingMs 均常量 null。扩展现有真实 Pi node-run 主用例，要求真实执行时长、零名额等待、重启后的精确投影；未修复时 waitingMs=null 失败，/tmp/graph-native-timing-red.log，1.98 秒。
- kernel_executions 添加 nullable run_ms/waiting_ms/run_since/waiting_since；旧记录保持未知，新执行从实际 start 边界记录0并打开工作段，blocked 恢复打开新段但延续已累计计数。凭据 acquire 与再次取得全局 Agent 名额之间为等待段，结束/阻塞关闭实际段，与 terminal state 同事务结算。名额等待的更新及 graph.execution.waiting 事件同事务、重复同状态不重复累计；现有聊天 SSE 可刷新状态，无新增轮询。
- kernelNodeRun 从该账本投影单执行与累计的工作/名额等待，包括仍打开的段；任何执行的时间未知，累计完整值也保持未知。计量覆盖执行准备、Pi turn、重试/补交和结算工作，名额等待不计为工作，节点空闲和已阻塞期间不累计工作。elapsed/total 保留执行历时语义，不能拿它冒充 runMs。
- 硬 owner 死亡没有可信结束边界：recovery 清空该执行的完整 run/wait 计量与开放段，保留 unknown，而不是把宿主离线时间算成工作。后续恢复剩余工作也不追溯补出未知时段。扩展现有 m6 真实 SIGKILL 用例，原实例/会话/Git commit/未知usage仍保留，同时确认恢复前后 timing 为null。
- 原 credential-slot 主用例继续保留两个外部 main 的验证，再创建真实原生双节点共用1个凭据名额：等待中 runMs不增长、waitingMs正数，完成后工作/等待合计等于本次历时；后续同节点第二投递仅累加两次执行。主 Pi run 用例重启后计量完全一致。没有生产测试专用 seam 或伪造时间/usage。
- NodeDetail 显示运行与等待名额，历时提示改为“已结算执行的历时之和”；浏览器既有真实流程确认运行值已记录且说明不含名额等待。三文件14项通过，/tmp/graph-native-timing-events.log，9.48秒；另含原生暂停的三文件16项通过，/tmp/graph-native-timing-boundaries.log，10.19秒；主/Web TypeScript 已通过。早期两处 inProgress 联合类型断言改为外观匹配，未放宽行为合同。第143轮完整 gate进行中，完整退役/spec/default app仍未完成，未提交。

### 删除旧路由模块与旧节点简报分支（2026-10-09）

- gate143 完整终止：271 文件/1860 项通过，1 文件/2 项失败，191.64秒；/tmp/graph-v2-full-check-143.log、/tmp/graph-sdk-cutover-failures143.json。原生运行时间、凭据等待、SIGKILL、浏览器显示全部通过；两项失败在 node-executor 的 unknown usage 场景仍期待 run/wait=null。实际宿主观察到执行结束，时间计量与 token 未知相互独立，更新为 waiting=0/run>=0，保留未知usage hold、有效submit不可重放等原断言。
- test-audit 完整核对源码、所有调用、测试与 git历史。legacy-routing 仅自己的5项旧解析测试调用；router-action 只有 briefing 的已退出生产使用的旧节点分支和自己的8项旧决策测试。briefing 的 graph/focus/review/依赖闭包/rework helpers 没有生产调用，Execution 只为外部 main 传自身消息、附件、验收、catalog、能力与状态。没有删除 main 的仍活跃简报功能。
- 删除 legacy-routing.ts 62行、router-action.ts 98行；briefing 删除191行、增加6行，去除旧 graph/agent/program router 指令、submit_result 输出要求、隐式前驱 artifact 注入、deliverable/检查闭包和 reworkBriefing。正式原生节点任务/具名输入/输出要求、公开产物引用、自己的初次/后续 prompt 和显式模块仍由 native host/kernel 承担。
- 删除24项已废弃机制专用断言（legacy5/router8/briefing11），保留 main briefing 3项，主 requirement/message/acceptance 用例仍校验真正使用的字段。剩余真实 router E2E、模块 each/once、附件、main planning、原生配置补交冻结、deliverable/context 均执行验证。精确候选/历史/风险/保留证明记在 issue-1-old-kernel-removal-audit.md。本次不为凑数量生成重复或无关测试。
- 原生模块与node-executor四文件43项通过（/tmp/graph-legacy-routing-retirement.log，4.25秒）；main briefing/附件/planning/native-repair/router五文件18项通过（/tmp/graph-main-briefing-retirement.log，5.01秒）；原生deliverable/context三文件26项通过（/tmp/graph-native-briefing-owners.log，13.53秒）。主/Web TypeScript通过，删除符号在src/tests无调用，diff check通过。
- 第144轮完整检查明确使用 GRAPH_UPDATE_BASELINE=1，按仓库脚本允许的有意退役记录真实新基线，预期270文件/1838项；不是隐藏减少测试或降低通过标准。全量结果待终止，完整旧 graph/types/Pi scaffold 退役、模型目录、节点工作位置和默认app交付仍未完成，未提交。

- gate144 已完整终止并通过：270 文件/1838 项，182.41秒；TypeScript/lint、真实全量测试、显式基线调整与 evidence检查全部通过。/tmp/graph-v2-full-check-144.log、/tmp/graph-sdk-cutover-failures144.json failures=[]。基线从272/1862到270/1838的24项减少与删除审计一致；不带更新开关再次运行 check:baseline，必须按新基线严格通过。diff check通过，未提交。下一完整门禁145。
- 已定位下一退役批次：task-runtime.nodeRun 的旧 container 兜底、task.view 与 inspect 的 loadGraph/graph_revisions/containers/loops 读取仍在；layout.ts 还有无显式 edges 时 dependsOn/loop/branch 推断。它们不是原生 subgraph semantics，需清除这些旧读取/布局分支并保留外部 main 自身视图及原生 nested 图。GraphPlan/types、前驱 parser/Pi 旧提交、模型small/medium/frontier、节点工作位置、默认app构建/交付和全spec逐项验收仍未完成，goal保持active。

## 2026-10-09：原生边 ID 与 task-runtime 旧读取兜底

- 实际浏览器证明 `loop:feedback` 被旧画布 ID 推断错画；修复前 `/tmp/graph-opaque-edge-red.log` 的 SVG 路线与实际 HTTP layout 不同。删除 GridLoopEdge/loopChannels/旧 ID 推断，所有显式边按服务器路线绘制；现有子 graph、反馈与折叠/展开用例同步保留。
- 删除 `tests/console/loop-channels.test.ts` 的3项私有旧通道断言及唯一生产 owner，完整删除审计见 old-kernel-removal-audit；预期完整基线269文件/1835项，不为数量补测试。
- task-runtime 不再 loadGraph；原生节点走 kernelNodeRun，外部 main 自身节点继续 nodeRunView，缺失节点返回真实 not_found。外部 main 的 inspect 不读取旧 graph_revisions。原生修订、模块、接口继续保留。
- `/tmp/graph-opaque-edge-green.log` 两文件12项，6.95秒；`/tmp/graph-native-read-retirement.log` 三文件58项，24.49秒。完整 gate145 通过：269文件/1835项，179.87秒，TypeScript/lint/baseline/evidence 全通过（/tmp/graph-v2-full-check-145.log）。
- 下一批：server/app 的旧 draft/run graph fallback、layout 的 dependsOn/loops 推断及旧 branchEdges；graphMessages 尚有实际原生聊天合同，不能和旧 handoff 一并粗删。main 外部会话的旧「任务图」链接需按真实入口检查后处理。默认 app 交付及完整 spec 验收仍待完成。

## 2026-10-09：原生布局与 main 外部身份、聊天投影

- 从 app 删除旧 draft/run graph fallback，缺少 native definition 的旧 draft 明确拒绝；外部 main 的 graph 页面返回空结构，自己的聊天/节点详情依旧保留，不再把 main 画为内部 agent。
- layoutGraph 使用自有窄类型、必需显式 edges 与真实子 graph 分组，不再依赖旧 NodeSpec/ContainerSpec/LoopSpec 或 dependsOn/when/loops。删除被原生正交路线覆盖的 ELK edge section 二次解析，保留 ELK 格点节点布局和跨组正交路线。
- 删除 branchEdges/isBranchEdge、唯一 layout caller、画布 branchCase/context policy 和旧 graphHandoffs reader。删除5项旧私有 when 投影测试（完整审计见 old-kernel-removal-audit），预计268文件/1830项。
- 保留原生 graphMessages 并真正送到运行图 HTTP：此前 node_entries 中有聊天，native HTTP 却固定返回 messages:[]。既有真实浏览器子 graph 用例扩充实际 peer message，确认连线显示、点击可见线段后展示原消息。RED 同时证明 main 被伪装成内部节点、原生聊天在画布消失（/tmp/graph-native-only-layout-red.log）。
- 定向5文件19项通过（/tmp/graph-native-only-layout-green.log，7.66秒）；浏览器点击最初取整条曲线包围盒/中点，会命中途经的 join 节点；观察真实 hit target 后改为点击可见曲线线段，不用强制点击或固定 sleep。最终浏览器3项通过（/tmp/graph-native-chat-click-final.log，7.08秒）。路由真实 E2E 与 module-router 的13项在点击失败那次仍全部通过。
- 完整 gate146 通过268文件/1830项（184.90秒，/tmp/graph-v2-full-check-146.log）；TypeScript/lint/baseline/evidence 同时通过，普通模式基线复核与 diff 检查通过。默认 app 交付、全 spec 审计及 graph.ts/旧 predecessor parser/types 仍未完成。

交付实况核对：`/Users/macmini/.graph/app-root` 当前为 `/Users/macmini/workspace/graph-rsi`，不是本实施工作树；本工作树 dist/app/mac-arm64/Graph.app 尚不存在，/Applications 和 ~/Applications 下也没有 Graph.app。由此不能把本工作树的绿色检查解释为默认桌面 app 已交付。后续应构建并验证真实 bundle 与来源/默认服务进程，保留实际用户配置和数据库，不能只写状态标记。

## 2026-10-09：GraphPlan/GraphState 与旧前驱冻结退役

- graph.ts 的 GraphPlan/GraphState/loadGraph/resetIdleNode/reactivate 无产品 caller，旧 DAG 推断文件整体删除。main 的 createActivation/hasLockedQuestion 原 SQL 与额度规则迁到 main-node-state.ts，继续用于外部 main，而非伪装原生图节点。
- predecessor-handoff.ts 从旧 policies/依赖默认值/GraphPlan closure/build/settle/冻结表/格式化/无调用返工修复缩为仍被实际 Pi adapter 使用的提交检查、自己 write ledger 与准确共享产物身份绑定。旧前驱自动解析全部去除；Pi 可选 result_handoff schema 支路与共享 types 仍需下一批审计，不宣称 SDK 整体完成。
- 删除 question-routing 的旧 resetIdleNode 直接测试1项，以及 artifact-workspace 的旧 settleResultHandoff/result_handoffs 私有测试1项；其余问题归属/预算/唤醒、产物不可变内容/权限与真实 manifest-vs-disk 安全合同保持。完整删除依据见 old-kernel-removal-audit。
- 类型检查通过；6文件33项通过（/tmp/graph-plan-retirement-green.log，3.50秒），涵盖 question-routing/artifact-workspace/manifest-vs-disk/node-deliverable/graph-final-acceptance/实际 main planning。GraphPlan/GraphState/settleResultHandoff/buildPredecessorHandoffs/resetIdleNode/reactivate 在 src/tests 无余引用。
- 完整 gate147 未通过：267文件/1827项通过，settings-ui 1项 config_conflict（expected revision 3, found 4），189.81秒（/tmp/graph-v2-full-check-147.log）。旧 DAG 退役边界均通过，不将这次全量写成绿色。预期退役基线268文件/1828项，尚待成功报告更新。默认桌面 app 与完整 spec 要求逐项验收仍未完成。

### gate147 暴露的实际重复 autosave 修复

此前 model 页面等待「正在保存/等待自动保存」不存在，不能证明停稳，因为两提示只在常规页显示。真实 root cause 是 persistDraft 成功将 editVersion 设0，finally 却用0 != 本次version 安排第二次保存；revision 因无新编辑的重复 POST 增加，制造与外部热保存的 CAS 冲突。新增回归在原真实设置浏览器用例里记录成功的实际配置 POST，收到保存回执后推进浏览器 debounce 时钟，严格拒绝相邻相同文档再次成功保存。首次自然时间单跑未复现，虚拟时钟的 /tmp/graph-settings-redundant-save-red-final.log 稳定 RED 为重复成功文档，不是泛化延迟。

修复：无编辑版本不保存，finally 仅对尚有编辑的 pending/version变化补存；load 的 pricingChanged 也产生非零编辑版本，保留真实定价同步。原设置10项完整通过（/tmp/graph-settings-redundant-save-green.log，19.97秒），涵盖真实价格同步、凭据、模型、CAS、旧 startup/config 快照及保密合同。删除模型页两个恒为空的提示缺席断言，用实际成功回执和 POST 序列验证。完整 gate148 通过：268文件/1828项，183.00秒（/tmp/graph-v2-full-check-148.log），TypeScript/lint/baseline/evidence 全通过；普通模式基线复核与 diff 检查通过。不关闭目标。

### 全范围完成审阅补充（仍未满足）

- §10 EdgeExplanation 与 GraphCanvas 目前只提供 delivery ID/value/protocol/revision/time；来源 execution、目标接收状态与产物链接尚未展示，大 value/投递历史分页尚未证明。kernel-explain.ts 的 EdgeExplanation 字段和画布面板是实际证据，不用「已有边详情」代替完整验收。
- §10 app 的 graphLayouts 按整个 topology 缓存，结构改变会重新完整 layoutGraph；尚未证明 patch 复用未变位置并仅调整受影响区域，状态叠加的稳定布局测试不能证明结构修改的布局合同。
- 原始需求的节点工作路径/权限声明和分层模型目录仍需与实际 NodeDefinition/model grades 对照；不能把当前宿主默认 worktree 或 low/medium/high 配置直接声称覆盖用户的声明能力。
- 整体 SDK 退役仍有 Pi 可选 result_handoff、旧共享类型和 main context 空 predecessor 字段；实际正式 main 的 execution 只生成 agent_result。graph.ts 删除不等于上述全部退役。
- 默认 app-root 指向 /Users/macmini/workspace/graph-rsi，本实施工作树尚无实际构建 bundle；部署/默认进程及完整 spec 逐项实证仍必需。

### Pi 旧提交 SDK 收尾（2026-10-09）

- 正式 main 的 context 只声明 agent_result；submit_result 旧工具仅向旧 worker 暴露，原生 host 原来过滤它。删除该工具声明、执行器与 onSubmit/validateSubmission 回调；原生 submit 仍由 resident node tools 提供，无需过滤旧声明。
- 删除 Pi 的 result_handoff 解析/附加结果及整份 predecessor-handoff.ts；删除共享 ResultHandoff/PredecessorHandoff 类型、main context 空前驱字段及 UI 的旧 predecessors 展示。保留历史数据库的可选列、自己会话绑定/历史、预算与真实回复，不破坏旧历史数据。
- manifest-vs-disk 的5项直接旧 parser 测试随被退役合同删除，依据与风险在 removal-audit 中逐项列明；不能把 native submit 的协议验证声称等同于旧隐式文件 manifest。真实 write ledger、产物路径/不可变版本/Git验收继续覆盖。
- 共享工具目录现有用例先禁止 submit_result，修改前 RED（/tmp/graph-old-submit-tool-red.log），实际原生 Pi/submit/补交/main对话定向6文件33项 GREEN（/tmp/graph-old-submit-tool-green.log）。旧解析退役定向8文件53项 GREEN（/tmp/graph-pi-handoff-retirement-green.log）。prompt/UI 收尾4文件23项 GREEN（/tmp/graph-pi-retirement-prompts-green.log）；主/Web TypeScript 通过。
- runtime/worker.md 可编辑槽位保留，默认指令改为 submit。完整历史默认仅用于精确迁移匹配，不改用户自定义文本或 reset 默认。第149轮完整门禁运行中，预期267文件/1823项；不宣称全范围 spec/default app 已完成。

- gate149 未通过：266文件/1822项通过，草稿抽屉旧 handoff 标题断言1项失败，176.20秒（/tmp/graph-v2-full-check-149.log）。改为真实 job/result/data 具名协议检查，原抽屉/聊天/版本独立合同完整保留，定向1项通过（/tmp/graph-retired-handoff-drawer-green.log）。
- gate150 未通过：草稿抽屉31项全过，但 pre-push/peer install/runtime extension 临时可执行程序滞留。/tmp/graph-gate150-env-sample.txt、graph-gate150-sh-sample.txt 与 graph-gate150-runtime-probe-sample.txt 保存采样；前两者只有 _dyld_start、96K footprint，未进入脚本。精确终止本轮4个停滞测试子进程后门禁退出1；未重启 live gate、未延长超时、未写成绿色。分类 /tmp/graph-sdk-cutover-failures150.json。仍需受影响真实测试复验和完整绿色门禁，正式基线仍268/1828，预期退役后267/1823。

- 单独复验3个受影响文件仍失败（/tmp/graph-gate150-host-recheck.log），未通过全量检查，不更新267/1823正式基线。进一步最小宿主探针：相同临时脚本，以 /bin/sh 显式解释运行成功，直接执行 chmod755 的 shebang 脚本3秒超时；/bin/sh -c printf 同样成功。可独立于 Graph/Pi/Vitest 复现，范围明确为宿主直接执行脚本启动路径，原因尚未知，不能以跳过测试/包装假接口解决。复验残留4个本轮测试子进程已精确终止；没有 live test 进程。待下一步诊断宿主、复验全量，并继续边详情/动态布局/节点workspace与权限/模型目录/实际app交付等 spec 缺项。

### §10 边详情来源与接收状态（2026-10-09）

- 原生 EdgeExplanation 增加 source/sourceExecutionId 和 receiver(kind/state/operationId/reason)，从同 graph 的 submission、queue、module inbox 与 operation 账本读取；队列失败/错误原因保留，模块实际 settled/uncertain 等操作状态不等于隐含业务通过，没有处理记录仅报告 accepted/unknown。
- GraphCanvas 展示来源执行与实际接收状态；Conversation 原生草稿的空投递仍兼容，不伪造执行来源。UI-flow 已有真实 provider/Pi submit/检查模块/浏览器主流程扩展，无新增测试专用接口。修改前缺少 sourceExecutionId 失败（/tmp/graph-edge-progress-red.log）；类型检查通过（/tmp/graph-edge-progress-types.log）。首次绿色验证因点击透明 interaction path 被 Playwright 判定不可见而失败；改用真实可见路径采样+elementFromPoint确认用户可点击位置，未force click。最终2文件12项通过，7.29秒（/tmp/graph-edge-progress-green-final.log）。
- 来源执行/接收状态缺口已补齐，其余 §10 产物链接、大value/历史分页、动态结构局部布局等仍未完成。数据投影目前逐delivery查询且历史未限页，后续分页需同时控制查询和响应量，不能只在DOM折叠。
- 宿主直接执行 shebang 脚本最小探针再次成功。原3个受影响文件19项全部通过，8.42秒（/tmp/graph-gate150-host-recheck-recovered.log），无需延长超时或修改测试/产品执行语义。gate150仍保留失败证据；第151轮完整门禁继续验证，未提交、未交付默认app、不关闭目标。

- gate151 未通过：266文件/1822项通过，1项 graphs 重启投影整对象比较失败，173.68秒（/tmp/graph-v2-full-check-151.log）；新接收字段真实 queued→done，已修正原测试只将动态 receiver 从不可变投递比较中排除，并分别严格断言 queued/done，所有value/版本/来源字段仍精确相等。实际4项定向通过（/tmp/graph-edge-restart-progress-green.log，4.16秒）。
- gate152 完整通过：267文件/1823项，171.31秒（/tmp/graph-v2-full-check-152.log）；TypeScript、lint、真实Pi/浏览器/Git/恢复/扩展安装/pre-push 全过，按已记录5项旧 parser测试退役明确更新基线，evidence unchanged。无旧definition失败（/tmp/graph-sdk-cutover-failures152.json）。普通基线与diff检查随后复核；未提交，完整spec与默认app仍未完成。

### §10 边详情精确产物引用链接（2026-10-09）

- EdgeExplanation 提取 value 嵌套对象/数组中明确 artifactId + 正整数version 引用，去重后附当前顶层graph taskId/digest。不从文本猜ID、不将无版本名称指向最新版。GraphCanvas 使用既有 ArtifactDetail 路由，显示版本与引用digest；目标页面继续执行真实产物读取/权限/版本检查。引用仅用于导航，不新授予读取权限、不宣称该digest已被投影重新验证。
- 扩展 ui-flow 的正式 worker 先真实 artifact_publish 发布plans/candidate，再submit嵌套subject引用；HTTP来源/接收检查保留，并实际点击v1链接读取 PROJECT_A_VERSION_ONE。缺少link的修改前回归失败（/tmp/graph-edge-artifact-link-red.log）。主/Web类型通过（/tmp/graph-edge-artifact-link-types.log）。首次运行已通过link和内容验证，但新增artifact标签仍保留影响原关闭node后默认回到graph的上下文；在返回原流程前明确关闭该artifact标签，保留原窗口交互合同。
- 最终定向3文件16项通过，7.09秒（/tmp/graph-edge-artifact-link-green-final.log）；diff通过。剩余边value/历史分页与lazy读取、结构局部布局、节点权限/工作位置、模型分层目录以及实际默认app/完整spec审阅仍未完成；第153轮完整门禁待验证，未提交。

- gate153 完整通过：267文件/1823项，173.46秒（/tmp/graph-v2-full-check-153.log）；TypeScript/lint/baseline/evidence全过，未降低门禁或更改基线。分类 /tmp/graph-sdk-cutover-failures153.json 零失败。精确版本产物链接通过实际发布/投递/浏览器读取及全量负载；未提交、未交付默认app、未完成全范围目标。

### §10 边投递历史分页与大value lazy读取（2026-10-09）

- explainEdge 按seq新到旧，默认20条/上限200，nextBefore用于下一页；图概览每边只读最新1条。SQLite SELECT/CASE直接省略>4096 bytes value，仅512字符预览与真实字节数，不先读取全部history或完整value再DOM折叠。valueTruncated/latestTruncated区分尚未加载与业务null；下一页latest仍取真正最新投递而非该页首条。
- 新HTTP边历史与精确单delivery完整读取接口、TaskRuntime.graphEdge以及main graph_inspect edge_delivery都是真实生产入口；deliveryId强约束task/edge，非法页大小/游标拒绝。main普通edge查询的after使用nextBefore，文档与工具说明同步。
- GraphCanvas选中正式边时取20条，明确按钮补取更早记录和大value；请求取消绑定选中对象，历史去重，完整读取后展示value与已确认精确版本artifact链接。未确认草稿不调用运行历史。图/API中module输入/transition大值仍可能完整传送，未把边分页声称成所有graph大型payload已完成。
- kernel-explain历史owner扩展正式submit25次、20+5不丢/重复、旧页最新标志、单条精确完整读取及错边/非法游标；修改前25条未分页失败（/tmp/graph-edge-history-red.log）。首次实现TypeScript exactOptional下一页字段和测试预览marker布置问题已修正：正文12KB尾部marker，在边interfaces摘要中不得出现，不把module当前值通道误作为边分页证据。
- 类型通过（/tmp/graph-edge-history-types-complete.log），3文件16项通过，7.12秒（/tmp/graph-edge-history-green-complete.log）。进一步扩展既有真实复杂图browser owner，用each路由真实生成25次投递，paused目标保留排队语义，不伪造SQLite记录、不调用LLM替身；HTTP20条页，UI点击再5条，错边读取/201条页拒绝。全部3项browser通过（/tmp/graph-edge-history-browser-green.log，7.12秒），不新增测试数量。完整gate154待验证。module历史/大值、结构局部布局、节点声明/模型目录、真实app交付与全spec审阅仍未完成；未提交。

- gate154 完整通过：267文件/1823项，179.86秒（/tmp/graph-v2-full-check-154.log）；主/Web TypeScript、lint、全套真实HTTP/Pi/browser/Git/恢复、baseline/evidence通过。分类 /tmp/graph-sdk-cutover-failures154.json 零失败。边查询分页/lazyvalue与main读取工具通过真实系统负载；仍不等于module历史分页/大值及其余完整spec已完成。未提交、默认app未交付，目标保持active。

### §10 模块判断分页及输入/状态/判断payload lazy读取（2026-10-09）

- explainModule不再读取整个module state/input value/全部transition。SQLite CASE限制每个JSON字段4096 bytes，摘要显示truncated、真实bytes、短preview，输入delivered/missing与业务null独立；transition有payloadTruncated，不能把尚未加载字段当作业务null/空emit。正式模块语义、once/each、重开与实际状态未变。
- 模块历史按rowid发生顺序默认20条、上限200、nextAfter翻页；概览不带历史，仅latestTransition+当前输入/state摘要。新增(task_id,module_id)历史索引。模块输入/state完整读取和单条transition精确读取分别通过真实TaskRuntime/HTTP/main graph_inspect module_values/module_transition；错module/非法cursor拒绝。main工具文档同步，当前值读取不会引发判断。
- GraphCanvas选择模块后lazy获取20条历史；明确按钮追加历史/读取完整输入与状态/读取单条完整判断。真实浏览器发现原边与模块两个重叠aside挡住模块分页：节点选择清除edge selection，边选择时隐藏module面板，保持单个选中对象详情，不force点击。不把UI测试失败写成green。
- 作者审计见removal-audit。旧实现实际module概览包含12KB输入尾部marker，/tmp/graph-module-history-red-final.log RED；此前首次probe提前因canonicalJSON先排appendix、短preview不含DELIVERY_25而失败，修正真实点击边完整value后才继续，非旧实现证明。第一次实现类型通过，但UI被旧edge aside截获指针失败（/tmp/graph-module-history-green.log）；上述真实选择修复后4文件21项通过（/tmp/graph-module-history-green-final.log，11.47秒）。
- 进一步既有kernel-explain V4 state owner用正式recordModuleTransition写12KB持久state，验证state/transition均截断及两条独立精确读取；浏览器真实module25条判断20+5、完整输入/末条payload以及HTTP错误cursor/错module验证。main/Web类型和diff通过，最终4文件21项通过（/tmp/graph-module-history-green-complete.log，12.16秒；/tmp/graph-module-history-types-complete.log）。没有新增测试数量，没有跳过旧合同。
- 第155轮完整门禁待验证。动态结构复用布局、节点workspace/权限声明、模型目录、真实app与完整spec逐项审阅仍未完成；未提交/未交付默认app/不关闭目标。

- gate155 未通过：266文件/1822项通过，HTTP graph.test 1项仍要求概览完整transition，181.49秒（/tmp/graph-v2-full-check-155.log）。模块当前输入/布局/真实输出未失败；lazy历史收尾将原HTTP合同改为概览零历史+正式module endpoint严格读取原passed输出。未删输出断言、未改路由语义。另ModuleHistory把当前input摘要作为更新依赖，输入先更新而判断尚在执行时也刷新，不等latestTransition才刷新。实际HTTP/browser 2文件7项通过（/tmp/graph-module-history-http-green.log，7.51秒）。diff通过。第156轮完整门禁待验证，不提前宣称全绿。

- gate156 完整通过：267文件/1823项，184.50秒（/tmp/graph-v2-full-check-156.log）；主/Web TypeScript、lint、全套实际HTTP/Pi/browser/Git/恢复、baseline/evidence通过。分类 /tmp/graph-sdk-cutover-failures156.json 零失败，普通baseline/diff随后复核。边与模块历史分页/大JSON lazy当前通过正式传输和读取路径；不把此证据扩成所有运行日志/全部spec已完成。运行中结构位置复用、workspace/权限/模型目录、实际默认app与完整spec仍未完成；未提交、不关闭目标。

### §10 结构修改的位置复用与显式重新布局（2026-10-09）

- 按graph修订保存布局，节点/组位置不再由全局拓扑缓存决定；每graph串行计算，未改变的父子关系复用锚点，新增/重挂对象及容器增长导致的邻近冲突自动避让，保持16px格点，按实际新坐标重走正交边。ELK仍生成候选位置，输出只局部调整受影响对象；不声称候选计算也只局部执行。删除成员不重新压缩已有容器。
- `graph_control relayout` 与实际“重新布局”按钮丢弃历史位置，允许重新排列，不修改队列/执行/路由状态。reset事件游标作为布局epoch，异步ELK计算若跨过reset不得写回旧结果；布局跨daemon重启保留。schema升级自动建立独立布局表，正式graph/实例身份不变。
- 既有m5实际HTTP/Pi owner修改前RED：增加顶层extra导致outer高度288→320、y208→240（/tmp/graph-incremental-layout-red.log）。实现首次两轮失败暴露不应强制规范化旧padding和对象JSON键序比较错误；改为逐坐标比较且只处理实际增长/冲突，未放宽原锚点断言。4项几何owner通过（/tmp/graph-incremental-layout-green3.log）。进一步嵌套新增成员验证原成员锚点、父组锚点/包含范围、所有叶节点无重叠且每条边不穿节点；真实浏览器按钮返回layout_reset并保持队列/模块账本；重启后精确读回布局。类型检查通过，4文件19项定向通过（/tmp/graph-incremental-layout-targeted.log，8.41秒）。无新增case、作者审计见removal-audit。
- gate157完整通过：267文件/1823项，184.81秒（/tmp/graph-v2-full-check-157.log），主/Web类型、lint、真实HTTP/Pi/browser/Git/恢复、baseline/evidence通过；分类/tmp/graph-sdk-cutover-failures157.json零失败。工作位置/权限声明、模型分层、默认桌面app与完整spec审阅仍未完成。开始构建真实桌面产物；暂不切换app-root、不提交、不关闭目标。

- 首次真实app构建成功并完成包标记核对（/tmp/graph-v2-app-build-157.log），生成arm64 Graph.app与203MiB DMG；但包内Node/Pi probe失败，0个模型请求，队列因Expected an unchanged canonical grant path连续3次失败（/tmp/graph-v2-packaged-probe-157-diagnostic.log）。不把包存在写成运行成功。根因是可信宿主为read/write解析了workspace真实路径，但cwd仍用项目symlink别名；测试setup统一TMPDIR曾遮住这条实际入口。
- 在既有m5真实HTTP/Pi owner使用真实项目symlink，RED严格复现同一拒绝（/tmp/graph-project-alias-red.log）。residentLauncher捕获workspace真实路径，统一cwd/read/write授权；不修改低层canonicalGrant或权限规则。主/Web类型检查通过，4文件40项实际HTTP/Pi/受限进程/常驻worker通过（/tmp/graph-project-alias-green.log，5.59秒）。
- gate158完整通过：267文件/1823项，186.85秒（/tmp/graph-v2-full-check-158.log），baseline/evidence/type/lint全过；分类/tmp/graph-sdk-cutover-failures158.json零失败。重新构建并用原失败probe核对最终包；首包尚不是此修复的交付证据。默认app-root仍graph-rsi，用户配置/数据库未动，完整目标保持active。

- 修复后重新app:build成功、包核对通过（/tmp/graph-v2-app-build-158.log）。未修改原失败probe，使用包内runtime/node和包内host/interface/resident代码、独立临时state/project、真实受控HTTP provider，GREEN（/tmp/graph-v2-packaged-probe-158.log）：2次实际provider请求、submit正式公开结果packaged:true、HTTP返回包内Web、结构patch保留原节点、relayout回执正确。包内resident-launcher与当前源码逐字相同。probe收尾关闭own server/provider并删除own临时数据。没有启动默认用户数据库，没有切换app-root；Graph.app/DMG产物可运行的范围证据不等于默认桌面窗口已验收，也不等于完整spec已完成。
- 下一步仍需节点声明工作位置/权限、small/medium/frontier模型目录、完整spec逐项对照及默认app真实切换/窗口验收；大value传输已lazy，但规范§3的内容引用存储与全部日志lazy仍需独立审阅。没有live Vitest/build/probe进程，未提交，目标保持active。


### §2 节点工作位置、权限与实际环境快照（2026-10-09）

- 正式 NodeDefinition 接受可选 workspace（auto/project/worktree + 根内相对 path）与 access（现有 AccessPolicy）。默认位置/宿主权限沿用；实际目录 canonicalize，显式 worktree 要求 graph 已准备，拒绝缺失目录、词法或 symlink 越界。节点请求不得扩大宿主授权，保留 protectedPaths 与实际 graphHome。
- 按 execution revision 冻结环境，缺项补交继续旧配置；下一执行配置重绑使用现有 allowWorkspaceChange，保留实例、历史、累计预算。真实工作目录和解析权限进入 Pi 的工具/进程授权，不只写在 prompt；环境快照持久到 kernel_node_bindings，并由 system prompt/API/节点窗口公开，base 显示实际 project/worktree。项目目录节点不暴露私有 worktree 专属 commit 工具。
- 权限与目录拒绝在准入时保留输入、暂停节点，execution blocked、不扣自动重试、不占预算、不调用供应商。原 queue 合同保留 queued，而不是把可恢复输入改成终态；原因记录 graph.node.blocked。首次负向断言误把 queued 期待成 blocked，已按真实公共合同纠正，未改变产品行为。
- RED schema拒绝workspace、实际下一执行cwd identity mismatch均已捕获；通过可信宿主已有受控重绑修复。主/Web类型通过 /tmp/graph-node-environment-types-final.log；7文件74项定向通过，8.44秒 /tmp/graph-node-environment-targeted-complete.log。包括真实Pi目录/读权限/补交冻结/历史延续，负向配置，真实Git子目录commit/稳定产物/独立审查/最终集成，真实浏览器环境投影。未新增case、未改变门禁基线。
- 完整 gate159 已开始，尚未完成；当前打包产物仍为 gate158，不能声称包含此轮配置。模型 small/medium/frontier、工具调用汇总、完整spec逐条审阅、实际默认应用交付及旧基础术语收尾仍待完成，目标active，未提交。

- gate159 完整通过：267文件/1823项，详见 /tmp/graph-v2-full-check-159.log；主/Web类型、lint、baseline/evidence通过，/tmp/graph-sdk-cutover-failures159.json 零失败。未提交，实际默认应用与完整spec验收仍未完成。


### §2 节点工具调用累计统计（2026-10-09）

- kernelNodeRun 直接在 SQLite 聚合真实 node_entries 的 tool/call 事件，以实际工具启动条目计数，不按供应商工具调用ID去重。结果独立于聊天分页，包含失败调用，不把 result 当作再次调用，后续执行同名ID仍计新调用。不新增独立计数账本。
- 节点概览显示工具调用累计次数。已有 ui-flow 实际Pi先 artifact_publish 再 submit，HTTP limit=1 仍显示2次、浏览器显示2次；native-repair-freeze 含权限拒绝read/补交submit，第一执行3次、第二执行累计6次。旧实现缺字段的 RED /tmp/graph-node-tool-count-red.log，修复后主/Web TypeScript通过 /tmp/graph-node-tool-count-types.log，3文件5项真实Pi/browser回归通过 /tmp/graph-node-tool-count-green.log，7.71秒。原调用失败原因记录合同保留。
- gate160 待验证；模型分层目录、完整spec逐项核对和实际默认应用交付仍未完成，未提交。

- gate160 完整通过：267文件1823项，175.95秒；/tmp/graph-v2-full-check-160.log 与 /tmp/graph-sdk-cutover-failures160.json。随后继续纠正工具调用ID复用时的计数边界，gate160不是这项后续修正的证据。

- 工具ID复用边界的实际RED：同一Pi执行先artifact_publish再submit，provider复用ID，实际两次工具执行但初版聚合仅1次（/tmp/graph-node-tool-count-reused-id-red.log）。修复为直接COUNT实际call条目，无第二套身份、无需读取完整payload。修复后类型通过 /tmp/graph-node-tool-count-types-final.log，3文件5项通过 /tmp/graph-node-tool-count-green-final.log，7.76秒。gate161待验证。


下一项只读定位：模型目录仍为 low/medium/high/highest。受影响的生产入口包括 catalog/models 的选择，catalog/catalog 与 agent-combinations 的配方校验，capability-library 的 grade 筛选，server/config 的条目/preferences 解析，runtime/kernel-graph-lane 的配方选模，web/Settings、Setup、ResourceLibrary 与 provider-form，以及 prompt-suggestion/sediment 的候选选择。正式规格要求 small/medium/frontier 并明确不默默改变已有配方；不能只改UI标签或直接删除旧 high/highest。真实回归 owner 可继续扩展 m3/models 的原生fallback/独立审查合同、m8/settings-ui 的实际配置保存合同与配置/配方解析owner，不新增第二套模型配置格式或常驻配置工具。

- gate161 最终完整通过：267文件/1823项，177.28秒（/tmp/graph-v2-full-check-161.log）；主/Web TypeScript、lint、baseline/evidence全过，/tmp/graph-sdk-cutover-failures161.json 零失败。包含工具ID复用修正；未减少测试/门禁基线，未提交。节点环境与调用汇总已验证，旧SDK剩余清理、模型分层、完整spec审阅及实际默认应用仍待交付；gate158的app打包产物尚不包含本轮改动，目标继续active。


### 模型 small/medium/frontier 分层及实际偏好选模（2026-10-09）

- 同一grade字段接受三层及low/high/highest历史选择；派生tier是只读视图，不增加第二套配置。small选择small/low，frontier按frontier/highest/high；旧high优先high、不扩成highest，旧等级不读取新frontier偏好。现有配置/发布配方不重写。目录与配置/system capabilities公开tier，设置页可按层筛选，设置/首次配置/配方编辑选择器共享分层与历史选项。
- 接入模型条目/preferences解析、配方保存编译/发布、main配方发现筛选、原生车道与普通main selectModel、辅助prompt suggestion/sediment候选；复用独立审查model identity排除。厂商模板默认不变，不增加常驻配置工具。
- 真实模型owner证明frontier→highest、small→low、旧high→high以及供应商请求身份；新内核漏接既有preferences被真实Pi RED捕获（/tmp/graph-model-tiers-preference-red.log），接入live/static getter后偏好生效。额外真实执行证明frontier偏好不改变旧high选择。main实际库工具按frontier找到旧high审查配方；recipe公开save编译frontier；真实browser保存frontier、筛选与重启持久化。
- 首次RED /tmp/graph-model-tiers-red.log 旧发布/工具不接受分层；主/Web类型最终通过 /tmp/graph-model-tiers-types-final2.log。10文件128项定向通过 /tmp/graph-model-tiers-targeted-complete.log，20.90秒；最终偏好兼容补充4项通过 /tmp/graph-model-tiers-preferences-green.log，5.93秒。未新增case/更改baseline。settings既有账户编辑断言等待真实字段更新，保留严格值，待全量负载验证。
- gate162待验证，未提交。默认应用仍未切换、现有gate158打包不含本轮，旧SDK/完整spec逐条审计与领域文档收尾仍待完成，目标active。

- gate162 完整通过：267文件/1823项（/tmp/graph-v2-full-check-162.log），主/Web TypeScript、lint、baseline/evidence全过；/tmp/graph-sdk-cutover-failures162.json 零失败。模型分层、原生偏好选模、旧配方兼容与账户编辑字段等待已在完整并行负载验证；未提交、默认应用未切换。下一轮删除旧SDK草稿类型/退休revise签名及草稿依赖投影，清单在removal-audit；完整spec逐条审阅和实际默认应用仍未完成。


### 旧 SDK 草稿类型与退休 revise 入口整体删除（2026-10-09）

- 删除 types.ts 的旧 Proposal、ContainerSpec、LoopSpec；生产草稿读写/确认/执行briefing/Git acceptance全部统一 NativeProposal，definition必需，不再将旧nodes数组声明为正式SDK格式。validateProposal保持整次校验与旧nodes/loops/containers拒绝。
- 删除 supervisor.revise 及agentTools/Pi adapter的旧supervisor签名；新SDK只通过graphPatch修改图。m7真实Pi+Git生产owner检查旧方法不再存在，其原native执行/验收/交付合同完整保留。旧格式负向用例按unknown断言进入正式校验，保留invalid_proposal/零节点创建/禁止确认合同；工具测试移除无调用的退休stub，不删测试。
- 初次类型检查发现旧测试stub与误替换ProposalRow，以及未按NativeProposal构造的negative，均已修正。主/Web类型 /tmp/graph-native-proposal-types-final.log 通过；7文件78项定向 /tmp/graph-native-proposal-targeted-final.log 通过，24.03秒。初次targeted未设置MediaBookmarks路径导致m7项目cwd不存在，原真实场景未运行（/tmp/graph-native-proposal-targeted.log）；加入标准完整门禁同一环境后通过，未绕过Git检查。
- gate163待验证；NodeSpec/旧依赖详情、领域文档、全spec逐项审阅与真实默认应用交付仍待完成，未提交，目标active。

- gate163 完整通过：267文件/1823项，184.90秒（/tmp/graph-v2-full-check-163.log）；主/Web类型、lint、baseline/evidence全过，/tmp/graph-sdk-cutover-failures163.json 零失败。草稿正式类型与退休SDK方法删除已在全量真实Pi/HTTP/Git/恢复链路验证。未提交，默认应用仍指向旧graph-rsi、打包仍gate158；NodeSpec与旧草稿UI字段、领域文档、完整spec逐条审阅及真实默认交付仍待完成，目标active。


### 原生草稿UI与旧NodeSpec/verifier残留清理（2026-10-09）

- Conversation/App的草稿类型直接使用NativeProposal，definition必需，删除旧nodes计数fallback。草稿节点删除dependsOn/旧context声明与依赖占位，职责提示“独立会话”并展示实际任务与接口；不把未运行节点默认猜作Fresh/Fork，不展示无生产者的继承事实。状态提示使用具名接口投递与精确产物版本。
- graphNodeVisualKind以正式kind=agent优先，删除human名称猜测；graphNodeSuffix不再从退休context推测继承/独立上下文。真实第二项目节点human-worker此前渲染human已RED，修复为agent；草稿独立会话/依赖清理在原browser owner修前失败。RED /tmp/graph-native-draft-ui-red.log；主/Web类型通过 /tmp/graph-native-draft-ui-types.log，5文件45项定向通过 /tmp/graph-native-draft-ui-green.log，41.69秒，原layout/窗口/具名接口/重启合同保留。
- 删除NodeSpec已退休DAG字段dependsOn/container/routes/when/optional/verifier/replaces，保留外部main身份/会话/预算记录。删除无生产行为调用的verification.ts和无人引用的review-gate夹具；正式原生review-policy/check/review/final-acceptance与Git模块不删。类型检查发现main lifecycle读optional分支，清除旧可选节点语义并保留main失败处理/skipped拒绝。删除夹具未影响case数量。
- 最终主/Web类型 /tmp/graph-node-spec-retirement-types-final.log通过；原生验收/Git/main结算定向 /tmp/graph-node-spec-retirement-targeted.log进行中。gate164待验证。领域文档/全spec逐项审阅/实际默认应用交付仍未完成，未提交，目标active。

- 原生验收/Git/main结算定向5文件36项通过，16.65秒（/tmp/graph-node-spec-retirement-targeted.log）。gate164完整通过：267文件/1823项，186.45秒（/tmp/graph-v2-full-check-164.log）；主/Web类型、lint、baseline/evidence全过，/tmp/graph-sdk-cutover-failures164.json 零失败。未减少测试case；未提交，默认app仍旧目录/旧打包。只读全spec核对确认大value内容引用存储未完成、日志lazy未全范围验收、折叠子graph公开接口待证明；边/module分页不是这些要求的完成证据，下一轮继续补齐，目标active。


### 大型 value 不可变引用存储（完整门禁 166 GREEN）

- 新增 src/core/kernel-content.ts：共享数据库内不可变 SHA-256 JSON 正文，记录 bytes/preview；大于 4096 字节的字段写引用，小值保留 inline。内容存储随原业务事务提交/回滚，原有 inline 可读。
- submit/delivery/queue/模块输入、状态、transition/graph result 的实际执行与恢复读取已接入；提交摘要改为 SHA-256，仍识别既有 canonical JSON 摘要，重复提交不重复发送。
- 边/module 概览 SQL 只读内容长度与预览，按需完整读取保持原协议；公开结果 SSE 携带 resultId，main 通过显式结果查询读取完整业务值。
- RED：既有 V6 投递历史 owner 存储断言失败 11,018 字节；GREEN：6 文件/46 用例，浏览器大值按需读取保留。新增模块复用与磁盘 restart/queue/replay 断言后 kernel-explain 9/9；TypeScript 主/Web 通过。
- gate165：267 文件，39 失败/228 通过；1823 用例，112 失败/1711 通过。根因是新构造器使用 Node strip-only 不支持的参数属性；已修正，实际 recovery/pricing/main conversation 3 文件/8 用例通过。完整 gate166 正在复验，未以 focused GREEN 代替完整门禁。
- 本轮未完成大日志 lazy、operation request/result 存储、折叠子graph 公共接口视觉验收、默认用户应用切换；整体目标保持 active。

- gate166 最终：267 文件 / 1823 用例全部通过，189.54 秒；baseline 与验收证据未改变。日志 /tmp/graph-v2-full-check-166.log；分类 /tmp/graph-sdk-cutover-failures166.json failures=[]。gate165 的 Node strip-only 回归已在相同完整门禁消除，未删减用例。


### Operation 内容引用与大日志按需读取（gate167 GREEN）

- workspace.command prepared 请求、settled 结果统一 KernelContent；内容与引用同 SQLite transaction。重开数据库后的 settled replay 解引用而不重跑命令；graph_inspect operations 与最终 acceptance 读取同样还原原值、精确参数与 commit。
- nodeRun 默认页继续使用原前后游标，在 SQL 边界给大 text/data 返回摘要与 contentBytes/contentTruncated；entryId 只读取所属 task/node 的单条完整记录。node.entry SSE 含 entry ID/seq 与文本摘要，已有游标恢复协议保留；session 和 node_entries 的完整记录仍保存。
- 独立聊天窗口提供“读取完整记录”，显式读取历史回复立即显示全文；后台分页刷新保留已加载正文。文案删去聊天自动返工“后续依赖”的旧 DAG 推断，明确继续原会话。
- Operation RED（15,290 字节 request 内嵌）→4 文件/12 用例 GREEN；日志默认 HTTP 页泄漏完整正文 RED→真实 browser 3/3 GREEN。主/Web typecheck 通过，完整 gate167 运行中。
- 剩余范围：折叠可复用子 graph 的公开接口与跨组边完整可视化验收；旧上下文 SDK/权威 domain 文档退役核对；全 spec 逐项完成审计；当前包构建与默认用户应用切换/窗口验收。没有用本轮 GREEN 宣布完整目标已达成。

- gate167 最终 GREEN：267 文件 / 1823 用例全通过，184.94 秒，baseline 与验收证据未改变。/tmp/graph-v2-full-check-167.log，/tmp/graph-sdk-cutover-failures167.json failures=[]。Operation 与大日志改动已经完整门禁复验。


### 折叠子 graph 公开接口与嵌套聊天（gate168 GREEN）

正式容器投影公开输入、输出、协议版本与内部映射；折叠跨组边使用共享纯格点路由，保留真实端点与投递历史。嵌套折叠后的跨组聊天按可见节点汇总，详情仍显示实际发送者与接收者，不丢消息、不改变队列或模块状态。扩展原 ui-flow 真实 HTTP/Pi/browser owner，验证公开接口、16 格点直角避障、点击边读取第 25 次大值、嵌套聊天和展开状态。旧实现先因缺失公开接口和折叠消息 RED；最终 browser 3/3，相关 4 文件/43 项通过，无新增 case 或测试专用入口。完整 gate168：267 文件/1823 项 GREEN，184.95 秒；/tmp/graph-v2-full-check-168.log 与 /tmp/graph-sdk-cutover-failures168.json（failures=[]）。

CONTEXT、产品范围、架构和实施计划按已确认 spec/ADR0030 更新；历史 ADR 与报告保留为历史证据。实现计划重新对应 spec§13 八个阶段，并明确默认用户应用仍未交付。未提交；完整规格逐条审计、旧上下文类型退役及最新默认应用交付继续进行。


### 旧上下文 SDK 与当前 Agent 指南（gate169 GREEN）

删除公开 ContextRequest 与 NodeSpec.context；main resolver 仍拒绝存储中的旧 context，保留自身 fresh/continue 恢复与精确 lineage。两个异常处理点不再从退休请求声称有效事实或独立性，记录现有 main 的空 facts/none 及真实错误。原生 context negative、实际 Pi 自身历史/重绑与 main lifecycle 定向2文件33项通过；主/Web类型通过。完整 gate169：267文件1823项 GREEN，185.83秒；/tmp/graph-v2-full-check-169.log，分类 failures=[]。

逐项核对发现 Agent 当前执行/概述/产物说明仍引导旧 Fork、每轮汇合及 program node。已更新实际使用文档与 INDEX 触发条件，保留精确产物/权限/Git门和独立的大工具结果协议；新增 [规格验收对应表](issue-1-spec-acceptance-matrix.md)，将 spec 每组契约映射到生产职责和行为 owner。默认用户应用交付未验，正在构建最新包；未提交，整体目标继续。


### 默认桌面首次启动的真实数据量回归（gate170 待验）

最新 gate169 包构建及包内真实 Pi 提交通过，但默认 Electron 首次启动先在60秒、后在300秒等待窗口失败；没有把正在启动当交付成功。保留原配置与 SQLite 的快照后，定位实际18个旧 graph 的21,195条 operation 删除卡顿。诊断脚本在真实备份上逐条执行既有清理 SQL；DELETE operations 卡住。仅倒序删除不能消除保留 main 的 context_handoffs 外键扫描，继续补 context_handoffs.operation_id 与 context_resolutions.handoff_id 索引；同一整次事务、主会话保留与旧图丢弃规则不变。修复后真实备份总清理5,061ms，原两份旧数据库迁移/实际native执行 owner 3项通过。未写以时间阈值绑定机器速度的重复单元测试，保留实际规模复验与数据保留检查。

已安装 /Applications/Graph.app，持久 app-root 指向当前 graph-v2-complete 工作树；默认 userData 未重置。实际 Electron packaged=true、窗口可见、daemon 使用当前源码及原用户 state；首次截图仍是加载中，不能将该截图称为完整 UI 验收，正在追加正文加载检查。默认数据库136→118任务，18个旧graph丢弃；117个main conversation/node/instance/budget逐行保持，110个context binding保持，配置/凭据字节相同，foreign_key_check零错误。快照在 ~/.graph/cutover-backup-169。源码新索引尚需gate170完整门禁与新包复建；整体交付仍待闭合。


旧 lane 夹具删除审计：tests/fixtures/lane.ts 的 laneResult/laneUsage/scriptedLane/ScriptedLane/settle 在 src/tests/scripts/examples 中均无外部调用，仅 checks 文档残留指针；git历史06dbc58用于旧 DAG handoff，旧执行器已退役。删除该未参与测试的夹具（没有删除case），checks 改指原生 Pi/Git 夹具；正式真实 submit、队列、产物及验收 owner 全保留。NodeSpec.deliverable 无生产属性读者，移除外部main记录中的过时产物承诺；原生 NodeDefinition.deliverable 及node-deliverable/node-turn-driver 的真实文件发布职责保留。主/Web类型和完整门禁核查残余typed用法，不添加测试专用出口。

gate170完整GREEN：267文件1823项，178.99秒，baseline/evidence不变。默认Electron正文已完整加载（2739字符，无pageerror），截图不再是加载占位；实际包与原用户state/source root已核对。最后上述SDK/fixture清理需要gate171，再重建包含新迁移索引的包。


gate171 提交前完整门禁GREEN：267文件/1823项，181.64秒，baseline/evidence不变，failures=[]。已清除无调用旧lane夹具及NodeSpec旧交付声明，正式原生文件发布保留。完整当前docs链接核查零缺失，git diff --check通过。默认Electron已加载原会话正文、无pageerror；最新包复建与安装复验接续，不将未执行步骤写成已通过。


### 最终源码、包与默认入口交付（2026-10-09）

- gate171完整门禁：267文件/1823用例通过，181.64秒，TypeScript/lint/baseline/evidence通过，failures=[]。旧lane夹具删除未减少case；全规格对应见 issue-1-spec-acceptance-matrix.md。
- 最新 app:build 及 app:verify 通过（/tmp/graph-v2-app-build-171.log）。实际使用包内 runtime/node 加载bundle，真实Pi发起两次受控provider请求，submit→正式公开结果、动态patch、稳定布局/显式relayout及Web成功（/tmp/graph-v2-packaged-probe-171.log）。
- 安装 /Applications/Graph.app，核对关键内核/类型/内容/broker/Web字节与最终bundle一致；持久app-root指向当前managed checkout。无 GRAPH_APP_USER_DATA 或 GRAPH_RSI_ROOT 覆盖，实际默认Electron再次打开原会话正文2739字符，无pageerror，daemon使用原用户state与当前源码（/tmp/graph-desktop-default-171.log）。
- 原main会话/身份/预算/上下文保持，配置和凭据字节仍未变。原状态快照保留在权限0700的 ~/.graph/cutover-backup-169；仅诊断用临时SQLite副本已清理。未修改原业务项目checkout；其中原有untracked规格/历史报告不动。
- 恢复边界仍如规格：不声称任意命令副作用恰好一次、不把未知usage/资源状态当零或已完成。自定义代码需预置固定Docker镜像，不退回宿主执行。受限宿主命令硬崩溃缺少可验证清理凭证时保留未知资源占位；该限制在当前管理文档与验收对应表明确披露。
- 本次完整变更待保存为本地提交；没有推送或远程关闭Issue。
