# Graph v2 管理入口

本页描述当前源码中的原生内核 API。源码入口已统一采用该内核；默认桌面启动已独立核对当前源码和原用户状态，完整证据见 逐项验收对应（该文档已删除）。完整契约见 [已确认规格](../specs/graph-rebuild-v2.md)。

代码修改需要 worktree、宿主检查与独立审查时，参阅 [完整代码交付示例](code-delivery.md)及其可执行 JSON。

## 创建与启动

需要用户确认的草稿使用 `propose_graph({proposal:{requirementVersion,summary,definition,acceptance,decisions?},requestId})`。definition 使用本文同一 JSON 格式；无需旧 nodes 数组。外层 acceptance 暂用 `{id,description,checkNode}`，指向定义中的实际节点或模块；定义同时声明正式 acceptance 时，两者需一致。main 位于定义外部。确认后收到 graph_ready 通知，再显式 graph_send，不自动运行根节点。主 agent 的 propose_graph 只接收此结构化对象，已关闭旧 proposalJson 字符串别名；运行中修改使用 graph_patch，旧 revise_graph 工具已移除。SDK 也要求原生 definition；旧 revise SDK 方法也已删除，使用 graph_patch 修订。正式 SDK 草稿只接收 NativeProposal，definition 必需；不再暴露旧 nodes/containers/loops 草稿类型。旧节点上下文继承、依赖调度和草稿格式不再是正式 SDK；默认应用切换证据见实施进度。

同一个功能任务沿用同一个 graph。`propose_graph` 默认原地更新当前需求下尚未确认的草稿，保持 `proposalVersion`，并返回新的 `draftRevision`。main 自行决定是否另存里程碑或比较版本：需要时传 `newVersion:true`，无需为是否另存版本请求用户许可。已确认的任务继续用 `graph_patch` 修改原 graph；另一个任务才另建 graph。执行内核的 revision 审计与用户看到的草稿版本分开。

确认前重新读取草稿。`confirm_draft({proposalVersion,draftRevision,targetBranch,instruction,requestId})` 必须携带当前内容的 `draftRevision`，由 briefing 或会话视图取得，并遵守用户明确授权确认与指定目标分支的要求。原地修改后，旧修订标识会被拒绝；不得替用户确认尚未查看的新内容。直接任务 accept 接口也要求此标识，可从任务视图或提案回执读取。

草稿版本不提供归档、恢复或删除：`archive_draft`、`restore_draft`、`delete_draft` 三个工具与对应 HTTP 路由已删除（2026-11-07）。会话视图的 `proposalHistory` 列出全部草稿卡片；历史版本号不复用，已确认草稿对应的正式 graph、任务、聊天、执行记录与验收事实不受影响。用 `withdraw_draft` 撤回未确认草稿，用 `confirm_draft` 确认；不要让模型替用户批量清理历史草稿。

提交草稿前可调用 `validate_proposal({proposal})`，传入与 `propose_graph` 完全相同的原生对象；返回 `valid:true` 或 `valid:false` 与错误，不创建草稿、不启动节点。预检不接收旧 `proposalJson` 字符串。

`graph_create({definition,targetBranch?})` 接收完整 JSON 定义，返回 graphId、验证后的定义和 revision。节点等待投递；创建不自动执行根节点。targetBranch 用于需要 Git 工作副本与交付合并的任务。graph 由当前 main agent 拥有。

定义包含 schemaVersion:2、name、protocols、nodes、modules、edges，以及公开 inputs/outputs。Agent 节点声明 recipe、task、instructions、acceptance、inputs、outputs、submission。协议是 JSON schema；连接的两端必须引用相同 protocol 与 version。完整示例和限制见规格第 4 节。

`graph_send({graphId,nodeId,input,value})` 向节点或模块的具名输入投递；省略 nodeId 时，input 指向 graph 的公开输入。系统持久保存 direct delivery 并与 landing 一起提交；value 必须满足输入协议。

`graph_send({graphId,nodeId,text})` 发送直接聊天。聊天与接口投递共用节点的串行队列；聊天可以只回复，不提交工作流输出。

## 节点执行指令

新节点由 main 使用已绑定的 writing-for-agents skill 填写非空 `instructions`：按顺序说明任务步骤、上游 plan 的精确产物引用、需要使用的 skills 与触发条件、可检查的完成标准。先核对这些 skills 已绑定到节点使用的 recipe；缺失时补全能力装配再派发。`task` 保持简短摘要，正式验收与必需输出仍分别声明在 acceptance 与 submission 中。指令文本不授予工具或权限。

历史定义可省略 instructions；声明时只接受非空字符串。首次说明包发送本节点完整指令，其他节点的概览不复制指令。用 `graph_patch` 更新 `nodes.<id>.instructions`，当前 execution 与补交保持冻结内容，下一次 execution 使用完整的新配置。现有节点 prompt/config 查看入口区分实际执行与下一轮配置，聊天记录保留每轮实际说明。

## 节点的 harness 覆盖

节点可以声明 `harness`：一个「提示键 → 文本」的映射，替换该节点运行时读到的提示文本。键只能是可编辑库的提示文件：`agents/<definition-id>.md`、`rules/{common,main,worker,reviewer}.md`、`tools/{common,main,worker,reviewer}.md` 之外的角色文件、`runtime/node.md`；值必须是非空文本。

`harness` 改变的是"这个 Agent 被告知什么"，不改变宿主强制的权限与闸门，也不改变该节点能调用哪些工具。同一张图里两个节点声明同一个任务、不同的 `harness`，就是同一任务在两个 harness 下各跑一次——这正是对比 harness 改动的实验形状。要跑这样的实验，用 `probe_harness`：宿主会建图、派发、等待并直接给出行为对比。

## 节点工作目录与权限

节点可选声明 `workspace:{base:"auto"|"project"|"worktree",path?:"相对目录"}`。省略时使用项目目录；工作目录在已准备 Git 的 graph 中使用节点自己的 worktree，否则使用项目目录。`project` 明确选择项目；`worktree` 要求创建 graph 时已指定 targetBranch。path 必须是所选根下已存在的目录，禁止绝对路径、父目录越界与指向根外的符号链接。

例如 `workspace:{base:"worktree",path:"packages/api"}`。节点不再声明权限：Graph 只有一种执行姿态，节点的工作目录由 `workspace` 决定。受理定义不等于命令一定成功：宿主拒绝时保留输入、暂停节点并通知 main，不消耗自动重试次数。

执行及缺项补交使用启动时冻结的环境。main 修改 workspace/access 后，下一次执行才重绑，保留实例身份、聊天历史和累计用量；成功重绑记录 graph.node.rebound。节点的 system prompt、node_run 与独立聊天窗口显示实际规范工作目录、实际 project/worktree 基础及已解析权限快照，不把下一版本配置当作当前执行环境。选择项目目录的节点不获得只适用于私有 worktree 的 workspace_commit 工具。

node_run 的 toolCallCount 是节点所有执行累计的实际工具启动次数，包含失败调用；不受聊天记录分页影响。按真实 Pi 工具启动事件计数；供应商复用工具调用 ID 仍计为新调用，工具返回记录不增加次数。节点概览同步显示累计次数。

## 修改与观察

`graph_patch({graphId,baseRevision,changes:{definition,reason,retire?}})` 发布新 revision。baseRevision 过期时不写入。删除节点必须明确列在 retire 中；存在运行、排队或失败待处理工作时，先处理工作。当前执行保留原配置，后续 submit 使用届时的连接。

局部修改使用 `changes:{reason,patch,retire?}`，与 definition 二选一。例如 `patch:{nodes:{work:{task:"处理新增边界"}},edges:{review:{enabled:false}}}`。对象字段递归合并，数组整体替换，null 删除字段；未指定内容保留。结果仍按同一正式 graph 定义整体验证，不增加第二套 graph 格式。删除节点仍要显式 retire 并先处理待办工作；有连接时同时在 patch 中删除对应边。

`graph_inspect({graphId,query,id?,after?,limit?,deliveryId?})` 支持 summary（默认）、revision、nodes、results、edge、edge_delivery、module、module_values、module_transition、operations、provider_calls、queue、executions、acceptance、limitations。limitations 是这张图已记录的全部收口限制（按记录顺序，含 acceptanceId、理由、证据、actor、commit、版本与 requestId），与 acceptance 里各项的 waived/limitation 字段是同一批记录。edge/module 查询要求对应对象的 id。results 是公开输出收到的业务结果；运行失败与完成通知单独记录。

edge 历史按新到旧分页，默认20条，limit范围1–200；返回nextBefore，下一页将它作为after传入。图概览每条边只带最新1条摘要。超过4096 bytes的value返回valueTruncated=true、valueBytes与短预览，value=null表示尚未加载；latestTruncated同样区分最新值未加载与真实null。精确读取使用 `graph_inspect({graphId,query:"edge_delivery",id:"边ID",deliveryId:"投递ID"})`，只返回属于该graph和该边的一条完整记录。来源execution、接收处理状态、版本、时间与具名端点保留；接收状态会随处理变化，不是不可变投递value的一部分。

用户界面选中边按需读取历史，「加载更早投递」翻页，「读取完整 value」明确获取完整值；artifactId+version引用连接到精确版本页面。HTTP对应GET `/api/tasks/:taskId/graph/edges/:edgeId?before=&limit=` 与 `/api/tasks/:taskId/graph/edges/:edgeId/deliveries/:deliveryId`。

module 判断历史按发生顺序分页，默认20条，上限200；下一页将 nextAfter 作为 after。图概览提供输入、state摘要和latestTransition，不加载判断历史；选中模块后开始读取。超过4096 bytes的输入/state标记valueTruncated/stateTruncated；transition中任一JSON字段过大标记payloadTruncated，未加载不能当作业务null或空输出。`graph_inspect({graphId,query:"module_values",id:"模块ID"})` 明确读取完整当前输入与状态；`graph_inspect({graphId,query:"module_transition",id:"模块ID",transitionId:"记录ID"})` 读取一条完整判断。输入、state和历史相互独立，读取当前状态不会重跑模块。HTTP入口为 `/api/tasks/:taskId/graph/modules/:moduleId?after=&limit=`、其 `/values` 和 `/transitions/:transitionId`。

## 控制

`graph_control({graphId,action,nodeId?,moduleId?,seq?,operationId?})`：

- pause/resume：nodeId 控制 agent 队列，moduleId 控制模块待处理输入；两者只能指定一个。都不指定时控制整个 graph 的派发。局部恢复不会解除 graph 的暂停。
- retry/skip/cancel：指定 seq 处理待执行队列项。仍在运行的项不能被这些操作重新领取；已成功提交的原输入不能重发。
- cancel_operation：指定 operationId，取消 uncertain/failed 操作的原输入；不撤销已产生的副作用，也不生成成功结果。dispatched 操作必须先停止。取消可以重放；恢复后如需重做，由 main 显式重新投递。
- reopen：指定 moduleId，等待已经开始的模块判断结束后清除一次汇合的触发锁存，保留输入，等待下一次投递再判断。
- complete：关闭外部新输入，等待内部工作清空后完成；空闲不等于完成。
- complete_with_limitations：只对 blocked 图生效，显式收口。必须给 limitations 数组（每项 acceptanceId、reason、evidence），且未满足的验收项要全部被覆盖（漏项会点名）；唯一例外是没有任何未满足项（全部 passed 或已被用户豁免）时列表可以为空，此时记录只有用户先前的豁免；failed、stale、kind=human（除非用户本人）和 Git 交付不匹配都拒绝，拒绝路径不写任何记录。同 requestId 重放返回同一份收口结果，不重复记录；回执里 `replayed` 只在命中已写记录时为 true，`records` 是这次真正写入的限制条数——空 limitations 的收口不写记录，所以对已完成图再发一次只回 `records:0, replayed:false`（「无可写项」），不冒充重放。它不改 complete 的硬门禁，也不改 ready 的含义。
- withdraw_complete：撤销完成请求，恢复外部输入。
- stop：关闭派发并取消待处理工作，等待运行中的工作收尾。

用户本人的豁免走 HTTP `POST /api/tasks/{taskId}/graph/acceptance/waive`（acceptanceId、reason、evidence、requestId），记录 actor=user，并同时了结该项已打开的 human_check 问题；Agent 的 graph_control 无法签名用户验收，service 按 actor 拒绝，读取请求体里的 actor 无效。

一次有效 submit 可以包含多个具名输出；未出现的输出等价于 enable:false。整次输出校验通过后才广播。业务“不通过”应发送 enable:true 和 passed:false；禁用连接是独立的 graph 管理操作。

提交成功不可撤回。执行随后失败时应处理剩余工作，不能再次发送原输出。模块保留每个输入最新有效值；each 每次到达判断，once 满足条件后锁存，显式 reopen 后才允许再次触发。

## 自定义模块运行环境

纯判断代码运行在 Docker 的 Linux cgroup 中，默认进程内存 256 MiB、禁止 swap、CPU 1、最多 32 个进程/线程、单次 5 秒，输入/输出各 1 MiB。网络关闭，根文件系统与代码挂载只读，Node permission 禁止文件访问及启动子进程。生产运行不拉镜像、不静默降级。

启动 Docker 后预先准备固定镜像：`docker pull node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`。无法启动或镜像不存在时，模块保留输入并报告错误，等待 main 处理。进程级内存限制已用 64 MiB cgroup + 200 MiB Buffer 分配验证，内核终止、退出 137、OOMKilled=true。


## 按需生成审查模块

需要多视角、对抗式或评委式判断时，main 可在 Graph 源码目录运行 `dist/graphd review-module --policy <policy.json> --entry <新的-entry.mjs> [--version <n>] [--protocol <name>]`（`dist/graphd` 是 Go 后端的二进制，可用 `go -C backend run ./cmd/graphbuild backend --if-missing` 构建）。这不是常驻工具或另一种 graph 格式：命令生成纯判断代码，并把普通 command 模块 JSON 写到 stdout；将该对象放入 definition.modules，连接显式输入即可。代码文件不能覆盖，修订用新路径和版本。默认 version=1、各接口 protocol=data；graph 必须声明该协议。连接到已有不同协议的端点时，按端点的协议 ID/版本调整生成对象中的接口声明，或显式映射；不绕过连接校验。

例如 policy.json：

```json
{
  "kind": "multiview",
  "subject": "implementation",
  "reports": ["review"],
  "dimensions": [{"id": "correctness", "required": true, "report": "review"}],
  "owned": ["src/"]
}
```

subject/reports 是模块输入名，不是隐式节点依赖。subject 输入值为 `{artifactId,version,digest}`；review 输入为 `{schemaVersion:1,subject:{artifactId,version,digest},body:{kind:"multiview",dimensions:{correctness:{verdict:"pass",reason:"实测理由",evidence:[{artifactId,version,digest}],files:["src/example.ts"]}}}}`。verdict 可为 pass/fail/unresolved，理由与已发布证据必需；files 可省略。所有声明的 subject 和 report 输入收齐后才判断。必需维度全部通过；建议维度可缺席、不阻止通过。owned 是 main 显式配置的文件范围，仅用于报告未被覆盖的返工文件。

adversarial 使用 `{kind:"adversarial",subject,reports,criteria:["验收项ID"]}`。报告 body 包含 checks 和 counterexamples。每个反例声明 id、acceptanceId、validity=valid/invalid/unresolved、impactsAcceptance、resolution=open/resolved 与 judgment；有验收影响的有效或未解决反例仍 open 时必须返工，不能用其他通过结论抵消。

jury 使用 `{kind:"jury",reports,candidates:[{id,subject}],hard:["builds"],ranking:[{id,weight,min,max}],tieOrder:["排名维度ID"]}`。每个 candidate 的 subject 对应自己的模块输入；报告 body.candidates 逐项包含 id、artifact、hard 判断和 scores（value、reason、evidence）。先检查所有硬性条件，再按归一化加权得分排名，平分按 tieOrder 的原始得分及候选 ID 顺序决定；全部不合格时输出返工，不产生 winner。吸收其他候选之后，另一个模块用相同规则检查新产物：将候选 subject 显式连到新产物，旧胜者引用不能证明新产物。

模块在 approved 或 rework 具名输出传递 decision（subjects、reports、blockers、reviewText，评委式另有 ranking/winner），并把最后 decision 保存为可解释状态。业务返工正常结束判断，不伪装成进程错误；格式或版本不符输出 invalid_evidence 返工。代码仍在上述 Docker 隔离与资源上限中运行。此配方比较输入中的内容与精确版本；引用对应的发布是否存在、内容是否真实，由宿主产物接口及最终验收核实。它不替代宿主检查、独立模型证明、人类验收或 Git 最终完成门；这些继续由正式 acceptance 声明验证。

返工环可显式配置 `staleReview: "wait"`：如果当前 subject 与暂存报告引用同一 artifactId，但报告版本更旧，模块保留上一判断状态、记录等待诊断，不发送 approved/rework；下一条有效投递再判断。默认 `staleReview: "rework"`，旧版本报告仍输出 invalid_evidence。不同产物 ID、同版本不同 digest、格式错误仍返工。这个选择属于所生成审查规则，不改变通用路由保留最新输入、通过状态或 once 锁存的语义。最终验收始终核对实际版本。
