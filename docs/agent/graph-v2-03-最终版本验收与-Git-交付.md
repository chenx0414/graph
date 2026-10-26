# 最终版本验收与 Git 交付

## 最终版本验收与 Git 交付

顶层 definition.acceptance 声明最终证据，与节点任务中的 acceptance 文本及路由 passed 状态分开：

```json
[
  {"id":"tests","description":"约定检查通过","kind":"check","module":"checks"},
  {"id":"review","description":"独立审查当前提交","kind":"review","node":"reviewer"},
  {"id":"human","description":"检查最终产物","kind":"human"}
]
```

check 引用 operation 模块，采用最新的真实宿主操作记录；成功退出但没有 verifiedCommit 的结果不能证明当前代码版本。操作配置改变后，旧记录不再证明新配置。Git graph 必须声明宿主检查，有代码变更还必须声明独立审查。

review 引用 agent 节点。该节点发布 schema 为 graph.review@1 的不可变 application/json 报告，内容为 {commit,passed,reason}；commit 是实际审查的完整提交，非代码图使用 null。验收读取完成执行发布的最新报告，核验实际文件 digest，并核对精确提交、实际调用的配方身份和模型独立性。不采信产物的 trust 标签或可改写的 metadata。首次 briefing 会给相关 reviewer 说明报告要求。

旧 through/pass 状态保留不影响此规则；旧 commit 的报告显示 stale，不悄悄改成新 commit 的审查。缺失实际调用身份的历史保持未知，不能补造独立性证明。

human 在其他证据齐备后形成用户验收问题，绑定 acceptanceId 和 commitSha。main 预审不代替用户回答；拒绝保留返工问题。集成 commit 改变后，旧的开放验收问题保留在历史中并标记 superseded，不记为用户批准；新 commit 的其他证据齐备后建立新问题。验收项一旦声明，普通 graph_patch 不能删除或改变它们；已有确认需求也不能通过改成另一种证据来绕过。

query:"acceptance" 返回各验收项的实际状态、原因和来源，以及持久 Git 交付 commit；ready 表示证据与待处理工作已满足，Git 交付仍是独立步骤。complete 先请求完成，再由宿主检查证据并交付相同的干净 commit。目标工作树脏、集成版本偏移或 Git 竞争均保留 blocked 和完成意图，main 检查时间线后可以处理问题并再次 complete；需要新增输入时先 withdraw_complete。图不会因节点均成功而隐式完成。

节点也可声明 deliverable: {path,namespace,name,schema}。例如审查文件使用 schema: "graph.review@1"；执行结束后自动发布，缺失或空文件使执行失败。相同内容且相同 schema 复用已发布版本；schema 改变即使字节相同也产生新版本，旧版本保持不变。初始任务说明包含交付路径和 schema，运行中修改在下一次执行生效。

确认带有正式 definition 的草稿，只建立节点、模块和连接，不推断入口、不向 root 或循环图的首节点发送空对象。Git 准备完成后，系统以 graph_ready 通知 main；main 查看声明并通过 graph_send 发送首个合法输入。重复确认重放原 receipt，不产生第二次通知。没有工作时保持空闲，不能据此推断图已完成。

stop 后节点和模块不能产生新投递；已经成功的 submit 重放仍返回原 receipt，不撤回旧投递、不重复发送。complete 请求期间仍允许内部输出流动并清空工作。

宿主 operation 与其他程序执行共用全局 4 个程序名额。等待名额的 operation 保持 prepared；名额取得后才允许跨越 dispatched 边界，实际 runner 结束后释放。operations 检查中的 worker_active 表示资源占位，不能据此声称 PID 存活或副作用已完成。等待期间 stop 不派发命令、不留下占位。恢复只自动释放未派发 prepared 的占位；已派发且不确定的占位保留，未核实终止前拒绝 cancel_operation。硬崩溃后的资源凭证核查见下一节；没有可验证凭证时保留未知占位。

## 宿主命令崩溃后的资源占位

`sandbox:false` 的操作由独立监督进程执行；宿主死亡时终止命令组。监督进程记录本次操作的清理凭证，恢复和 `cancel_operation` 核对凭证后释放程序名额。凭证缺失或不匹配时继续保留占位，不能仅根据宿主已经退出就认定命令已经清理。

释放资源不会证明副作用或检查结果：操作仍为 `uncertain`、模块暂停，不自动重跑，不产生业务输出。main 核查后明确取消已有操作，再通过新的合法输入启动后续工作。受限执行器尚未接通同等凭证，不能将上述清理保证解释为所有运行方式均已完成。

durable 宿主关闭时结束当前工具与模型的控制流，持久会话和输入收据留在共享 SQLite；重启先装回冻结配置，再由 durable 处理 checkpoint。副作用未知时交 main 核查，不自动重跑原输入。已提交输出仍保持不可撤回，崩溃执行和未知用量仍按持久账本由 main 处理，不将进程退出当作任务成功。

不限 token 额度的原生执行在成功模型响应缺少 usage 时使用已有本地估算，provider_calls 中保留 usageSource:"estimated"；费用仍取决于已配置价格。是否允许估算取自本次执行冻结的额度，不采用执行途中改写的配置。有限额度不以估算替代可核算用量，保留 unknown 记录和输入并等待 main 核对；不限额度仍无法估算时保持 usage:null / usageSource:"unknown" 和未知费用，允许后续请求及 workspace_commit；未知调用的占位继续保留，不补造零用量。若下次执行改为有限额度，旧的未知 provider 用量必须先显式核对；执行前暂停队列，不消耗自动重试次数。


确认任务共享项目集成的活动名额。当前任务真正 completed 或 stopped 后才释放名额，最早排队的确认任务随后进入 running；completing / stopping 期间仍保留名额。直接管理创建的 graph 不占用或释放其他确认任务的名额。用户 abandon 对原生 graph 表示停止请求，沿 stopping → stopped 取消待运行输入并等待活动工作停稳；重复 requestId 重放同一 receipt。


SDK 的原生草稿类型是 `NativeProposal`（backend/internal/graph/core_types.go），必须包含 `definition`，只声明 requirementVersion、summary、acceptance、decisions；不需要旧 nodes / containers / loops。`supervisor.propose` 与 `validateProposal` 接受原生对象，main 的 Pi 工具通道也使用这一类型。旧 Proposal 及旧 SDK 调用仍在退役，尚不能据此宣称旧内核已删除。


原生节点聊天（runtime.sendNodeMessage）与内部 peer 聊天（runtime.sendPeerMessage、send_to_peer）均一次消息对应一次队列项；忙碌时排队，空闲时由宿主启动回复，保留原会话，不隐含重跑后继节点。requestId 按目标节点与发送者区分，同内容重放原 receipt，改变内容报 idempotency_conflict；已接受消息在 graph 停止后仍可重放 receipt，新消息关闭。peer 来源记入目标节点聊天记录，可视化消息弧读取该持久记录；用户消息不画成 peer 弧。跨 graph、无效发送者/目标和 self 消息拒绝。


配置保存不能移除活动 graph 声明的模型，或当前执行冻结使用的模型。热修改模型时，当前 turn 保留旧连接，下一次使用新声明；旧 turn 结束后，不再保护已过时的空闲绑定。按配方选出的实际模型也受保护，直到相应节点退役或 graph 结束。未配置的偏好 ID 不会阻止无关配置保存；“移除”只判断本次确实从当前目录删除的连接。


节点通过 send_to_peer 向 main 发送聊天时，消息进入顶层 graph 所属的 main 会话，并记录 graphId、nodeId 和 requestId；main 位于 graph 外部。Pi 工具和 SDK sendPeerMessage 使用同一持久回执规则：同一发送者向同一目标重放同内容只投递一次，改变内容拒绝。graph 停止或完成后不接受内部 agent 的新聊天，但旧回执可重放，main 自己的会话继续服务。graph 没有所属会话时，向 main 发送明确报错。


main 所属会话的任务卡片包含原生 agent 节点，不再依赖旧 nodes / instances。卡片状态与累计已知用量来自原生账本，模型来自实际绑定，预算来自最近一次执行保存的额度；运行后仅修改下次额度不会改写这段执行历史。操作模块通过 graph_inspect 的定义和模块查询查看，节点列表只表示 agent。

确认任务的节点首次执行收到草稿确认时冻结的决策与约束；读取该任务的快照，不从 main 最新聊天重新拼装。切换项目不带入前一项目的约束，草稿之后的聊天不改变已确认快照；草稿显式声明 decisions: [] 表示没有约束，不回退到聊天。后续执行沿用节点会话，不重复初始约束全文，也不注入 main 的会话监控状态。


原生执行开始或从 blocked 恢复时，节点状态同步变为 running，并记录 graph.execution.started 事件；模型请求等待期间仍显示正在执行。执行结算后按实际结果显示 succeeded、blocked 或 failed。main 的会话状态摘要读取原生节点账本；确认后未投递的节点显示 idle，不把确认当作已执行。


main 使用 artifact_publish 的可选 graphId，在自己拥有的原生 graph 中发布或修改产物；修改时保持 namespace/name，并用 expectedVersion 指定已读的版本。省略 graphId 仍发布到 main 自己的任务。内部 agent 的工具不声明该参数，指定它会被拒绝。权限由实际 main operation、节点、实例、activation 和 graph 所有权共同核对；确认产生的 graph 与直接创建的 graph 使用同样的规则。main 的新版记录 main 为修改者，原作者仍以最早发布版本确定；旧版本字节和引用不会改变。

main 使用 artifact_retire({artifactId,version,reason,requestId}) 撤回已被替代或取消的精确版本；不需要再指定 graphId。宿主根据已发布产物的实际 graph 归属和本次 main 执行身份校验所有权，外部会话的读取权限不等于修改权限。撤回事件归属该 graph；重复调用不重复写事件，旧版本字节仍可按精确引用读取，其他版本不受影响。

确认草稿必须声明非空 definition.acceptance，并在外层 acceptance 摘要中完整列出同一组 ID 和描述；check 的 checkNode 对应 module，review 的 checkNode 对应 node。数量、ID、描述或检查对象不一致时，validate_proposal 和 propose_graph 都会在创建草稿前拒绝，不把无法执行或与用户展示矛盾的验收留到完成时才发现。human 仍使用用户验收流程，不从路由 passed 推断人工批准。

脚本化 ActionAdapter 用于无模型的确定性宿主测试，其 operation.input 来自当前已 claim 的投递 value（聊天 / 控制输入保留对应 payload），context.briefing 是该次实际组装的 prompt；不再读取旧 proposal.nodes 的 input/context。正式节点通过共享 durable Harness 的独立持久会话执行。原生节点详情的 elapsedMs / timing.totalMs 记录实际执行墙钟时间并可在重启后查看；未记录的 runMs / waitingMs 分项保持 null。


原生节点详情的 timing.pauseMs 来自持久暂停账本：用户 task.pause/resume 和 main 的 graph_control pause/resume 都记录实际边界。整个 graph 与单节点暂停重叠时只累计一次，恢复其中一层不会结束另一层暂停；重复操作不重复累计。记录跨后台重启保留，新增节点继承已记录的 graph 暂停。创建 worktree 的内部准备锁、执行失败后的队列保持不会被补造为用户暂停。graph 停止、完成或节点退役会关闭尚未结束的暂停区间；从未记录暂停时仍返回 null。人工等待 userWaitMs 尚无原生实际边界记录，保持 null。


公开 sendNodeMessage / sendPeerMessage 与 Pi peer channel 已统一到原生消息队列，要求目标具有正式原生 graph 定义。graph 内忙碌节点的消息排队为下一次执行，空闲节点回复时沿用同一 session 与累计用量；不根据旧 DAG 自动失效后继，也不通过消息重开已结束 graph。旧 node-messages 分派模块已删除，main 会话自身的 steering 仍保留。声明 deliverable 的文件由执行结算自动发布；需要其他节点读取时，显式向它的具名输入投递精确 artifactId / version，接收节点使用 artifact_read，不依赖旧 dependencySources 或私有文件路径。

原生常驻 Pi 使用模型窗口配置启用自动压缩；摘要请求同样经过宿主预算和暂停门禁。节点详情分别展示 completion / compaction 请求、实际用量和费用，摘要作为独立 compaction 条目保存，原聊天条目仍可查看。请求派发时冻结价格，重启或修改模型价格不重新计算历史费用；无法核算用量时费用保持未知。暂停后不允许发起新的摘要请求，已在途请求仍可结算。

每条边必须显式声明 enabled:true 或 enabled:false；缺失、null、数字和字符串不会被当作开关。创建和局部修改在写入图版本前统一校验，因此无效声明不会留下部分 graph 或新 revision。连接启用状态仍与投递 value 中的业务 passed 判断分离。

模型请求被原生宿主拒绝时，事件流保存 graph.provider.refused，包含 nodeId、callId、purpose、code 和 reason；拒绝事件不表示实际发送，也不创建计费调用。Pi 对外层错误的泛化描述不能替代这条宿主诊断。自动压缩的请求同样受冻结预算控制；有限预算的摘要用量未知时保留输入与占位，main 显式核对用量并处理队列后才继续。

用户通过 task.setBudget 为原生 agent 节点设置独立授权额度（正整数，或 null 明确不限额度）。授权持久化在原生节点账本，不依赖旧 instances；没有显式授权时继承已配置默认额度。graph 的节点 / defaults budget 是使用声明，不能突破该授权。当前执行与恢复继续使用其已冻结额度，下一次新执行读取新授权；节点详情 instance.authorizedBudget 单独展示用户政策，instance.budget 仍表示最近执行的实际额度。预算调整不改写历史用量、不清除未知用量、不自动恢复或重发排队输入；需要继续时 main 显式处理队列。结束 graph 拒绝新调整，已有命令回执仍可幂等重放。

实际有限额度预留不足会生成一条用户预算问题，inbox 可用 add_budget 追加正整数；重复观察同一阻塞不会产生重复问题。答复增加当前用户授权，保留原执行冻结额度与原输入；main 用 graph_control retry 显式开始下一执行。已有 submit 的输入禁止重放，未知用量仍须独立核对。有显式节点预算声明时，授权增额不自动更改声明，main 需要按新授权调整声明。追加拒绝整数溢出或没有合法冻结执行来源的问题。

用户直接 setBudget 的明确政策变更也会关闭该节点已有的预算问题，保留当前 execution 的冻结额度和队列暂停。未知 usage 的 hold 与其他类型问题继续保留；节点恢复仍由 main 显式 retry。inbox 答复后同时刷新导航待办数量与已处理历史。

main 修改原生节点预算只用 graph_patch 的节点 budget 声明，仍受用户授权约束；旧 control_task set_budget 在原生 graph 上明确拒绝并指向 graph_patch。节点窗口分别显示最近执行预算与用户授权额度，后者调整后下次执行重新校验。

agent 节点必须使用配置的模型与自身常驻 Pi 进程；无模型的旧 ActionAdapter / scriptedTurn 执行替身已移除。操作模块仍可不依赖模型运行。修改任务后，当前执行及补交继续采用 execution.revisionVersion 冻结的配置，下一条输入触发的新执行才采用新配置；补交只接收缺项提示，不重复初始 graph 概述。

原生 propose 草稿的结构只放在 definition 内。顶层 nodes / loops / containers 属于旧 SDK 格式，即使是空数组或 null 也拒绝；不能与 definition 混用，否则调用者可能误以为被忽略的旧字段已生效。原生声明内部的 nodes 具名 map、模块、普通边和子图实例照常使用。

Git 冲突由 main 明确处理：系统保留双方私有 commit/工作副本和失败输入，不隐式创建合并 Agent，也不依据旧 input.files 自动改写 commit。可声明普通合并辅助节点；其模型、权限、名额和用量走正常原生准入。解决后的 commit 仍需要声明的检查与独立审查；跳过失败输入本身不提供验收证据。
