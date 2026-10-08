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
