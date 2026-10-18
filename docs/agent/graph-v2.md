# Graph v2 管理入口

本页描述当前源码中的原生内核 API。源码入口已统一采用该内核；默认桌面启动已独立核对当前源码和原用户状态，完整证据见 [逐项验收对应](issue-1-spec-acceptance-matrix.md)。完整契约见 [已确认规格](../specs/graph-rebuild-v2.md)。

代码修改需要 worktree、宿主检查与独立审查时，参阅 [完整代码交付示例](code-delivery.md)及其可执行 JSON。

## 创建与启动

需要用户确认的草稿使用 `propose_graph({proposal:{requirementVersion,summary,definition,acceptance,decisions?},requestId})`。definition 使用本文同一 JSON 格式；无需旧 nodes 数组。外层 acceptance 暂用 `{id,description,checkNode}`，指向定义中的实际节点或模块；定义同时声明正式 acceptance 时，两者需一致。main 位于定义外部。确认后收到 graph_ready 通知，再显式 graph_send，不自动运行根节点。主 agent 的 propose_graph 只接收此结构化对象，已关闭旧 proposalJson 字符串别名；运行中修改使用 graph_patch，旧 revise_graph 工具已移除。SDK 也要求原生 definition；旧 revise SDK 方法也已删除，使用 graph_patch 修订。正式 SDK 草稿只接收 NativeProposal，definition 必需；不再暴露旧 nodes/containers/loops 草稿类型。旧节点上下文继承、依赖调度和草稿格式不再是正式 SDK；默认应用切换证据见实施进度。

同一个功能任务沿用同一个 graph。`propose_graph` 默认原地更新当前需求下尚未确认的草稿，保持 `proposalVersion`，并返回新的 `draftRevision`。main 自行决定是否另存里程碑或比较版本：需要时传 `newVersion:true`，无需为是否另存版本请求用户许可。已确认的任务继续用 `graph_patch` 修改原 graph；另一个任务才另建 graph。执行内核的 revision 审计与用户看到的草稿版本分开。

确认前重新读取草稿。`confirm_draft({proposalVersion,draftRevision,targetBranch,instruction,requestId})` 必须携带当前内容的 `draftRevision`，由 briefing 或会话视图取得，并遵守用户明确授权确认与指定目标分支的要求。原地修改后，旧修订标识会被拒绝；不得替用户确认尚未查看的新内容。直接任务 accept 接口也要求此标识，可从任务视图或提案回执读取。

main 使用 `archive_draft({proposalVersion,requestId})`、`restore_draft({proposalVersion,requestId})`、`delete_draft({proposalVersion,requestId})` 管理本会话中的指定草稿版本。会话视图的 `proposalHistory` 只列未归档、未删除的卡片，`archivedProposals` 列归档卡片。归档版本可按版本读取、恢复或删除；删除版本不能读取或恢复，版本号不复用。归档或删除已确认的源草稿不会删除正式 graph、任务、聊天、执行记录或验收事实；不要自动批量清理用户的历史草稿。

提交草稿前可调用 `validate_proposal({proposal})`，传入与 `propose_graph` 完全相同的原生对象；返回 `valid:true` 或 `valid:false` 与错误，不创建草稿、不启动节点。预检不接收旧 `proposalJson` 字符串。

`graph_create({definition,targetBranch?})` 接收完整 JSON 定义，返回 graphId、验证后的定义和 revision。节点等待投递；创建不自动执行根节点。targetBranch 用于需要 Git 工作副本与交付合并的任务。graph 由当前 main agent 拥有。

定义包含 schemaVersion:2、name、protocols、nodes、modules、edges，以及公开 inputs/outputs。Agent 节点声明 recipe、task、instructions、acceptance、inputs、outputs、submission。协议是 JSON schema；连接的两端必须引用相同 protocol 与 version。完整示例和限制见规格第 4 节。

`graph_send({graphId,nodeId,input,value})` 向节点或模块的具名输入投递；省略 nodeId 时，input 指向 graph 的公开输入。系统持久保存 direct delivery 并与 landing 一起提交；value 必须满足输入协议。

`graph_send({graphId,nodeId,text})` 发送直接聊天。聊天与接口投递共用节点的串行队列；聊天可以只回复，不提交工作流输出。

## 节点执行指令

新节点由 main 使用已绑定的 writing-for-agents skill 填写非空 `instructions`：按顺序说明任务步骤、上游 plan 的精确产物引用、需要使用的 skills 与触发条件、可检查的完成标准。先核对这些 skills 已绑定到节点使用的 recipe；缺失时补全能力装配再派发。`task` 保持简短摘要，正式验收与必需输出仍分别声明在 acceptance 与 submission 中。指令文本不授予工具或权限。

历史定义可省略 instructions；声明时只接受非空字符串。首次说明包发送本节点完整指令，其他节点的概览不复制指令。用 `graph_patch` 更新 `nodes.<id>.instructions`，当前 execution 与补交保持冻结内容，下一次 execution 使用完整的新配置。现有节点 prompt/config 查看入口区分实际执行与下一轮配置，聊天记录保留每轮实际说明。

## 节点工作目录与权限

节点可选声明 `workspace:{base:"auto"|"project"|"worktree",path?:"相对目录"}` 与 `access:{mode:"standard"|"full",...}`。省略时沿用宿主权限，工作目录在已准备 Git 的 graph 中使用节点自己的 worktree，否则使用项目目录。`project` 明确选择项目；`worktree` 要求创建 graph 时已指定 targetBranch。path 必须是所选根下已存在的目录，禁止绝对路径、父目录越界与指向根外的符号链接。

例如 `workspace:{base:"worktree",path:"packages/api"},access:{mode:"standard",network:"declared"}`。access 复用现有 AccessPolicy 的字段与默认值，不允许超过宿主已经授权的范围；protectedPaths 继续保留。受理定义不等于权限已经获准：启动时校验实际宿主授权，拒绝时保留输入、暂停节点并通知 main，不消耗自动重试次数。

执行及缺项补交使用启动时冻结的环境。main 修改 workspace/access 后，下一次执行才重绑，保留实例身份、聊天历史和累计预算；成功重绑记录 graph.node.rebound。节点的 system prompt、node_run 与独立聊天窗口显示实际规范工作目录、实际 project/worktree 基础及已解析权限快照，不把下一版本配置当作当前执行环境。选择项目目录的节点不获得只适用于私有 worktree 的 workspace_commit 工具。

node_run 的 toolCallCount 是节点所有执行累计的实际工具启动次数，包含失败调用；不受聊天记录分页影响。按真实 Pi 工具启动事件计数；供应商复用工具调用 ID 仍计为新调用，工具返回记录不增加次数。节点概览同步显示累计次数。

## 修改与观察

`graph_patch({graphId,baseRevision,changes:{definition,reason,retire?}})` 发布新 revision。baseRevision 过期时不写入。删除节点必须明确列在 retire 中；存在运行、排队或失败待处理工作时，先处理工作。当前执行保留原配置，后续 submit 使用届时的连接。

局部修改使用 `changes:{reason,patch,retire?}`，与 definition 二选一。例如 `patch:{nodes:{work:{task:"处理新增边界"}},edges:{review:{enabled:false}}}`。对象字段递归合并，数组整体替换，null 删除字段；未指定内容保留。结果仍按同一正式 graph 定义整体验证，不增加第二套 graph 格式。删除节点仍要显式 retire 并先处理待办工作；有连接时同时在 patch 中删除对应边。

`graph_inspect({graphId,query,id?,after?,limit?,deliveryId?})` 支持 summary（默认）、revision、nodes、results、edge、edge_delivery、module、module_values、module_transition、operations、provider_calls、queue、executions。edge/module 查询要求对应对象的 id。results 是公开输出收到的业务结果；运行失败与完成通知单独记录。

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
- withdraw_complete：撤销完成请求，恢复外部输入。
- stop：关闭派发并取消待处理工作，等待运行中的工作收尾。

一次有效 submit 可以包含多个具名输出；未出现的输出等价于 enable:false。整次输出校验通过后才广播。业务“不通过”应发送 enable:true 和 passed:false；禁用连接是独立的 graph 管理操作。

提交成功不可撤回。执行随后失败时应处理剩余工作，不能再次发送原输出。模块保留每个输入最新有效值；each 每次到达判断，once 满足条件后锁存，显式 reopen 后才允许再次触发。

## 自定义模块运行环境

纯判断代码运行在 Docker 的 Linux cgroup 中，默认进程内存 256 MiB、禁止 swap、CPU 1、最多 32 个进程/线程、单次 5 秒，输入/输出各 1 MiB。网络关闭，根文件系统与代码挂载只读，Node permission 禁止文件访问及启动子进程。生产运行不拉镜像、不静默降级。

启动 Docker 后预先准备固定镜像：`docker pull node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`。无法启动或镜像不存在时，模块保留输入并报告错误，等待 main 处理。进程级内存限制已用 64 MiB cgroup + 200 MiB Buffer 分配验证，内核终止、退出 137、OOMKilled=true。


## 按需生成审查模块

需要多视角、对抗式或评委式判断时，main 可在 Graph 源码目录运行 `node scripts/create-review-module.ts <policy.json> <新的-entry.mjs> [version] [protocol]`。这不是常驻工具或另一种 graph 格式：命令生成纯判断代码，并把普通 command 模块 JSON 写到 stdout；将该对象放入 definition.modules，连接显式输入即可。代码文件不能覆盖，修订用新路径和版本。默认 version=1、各接口 protocol=data；graph 必须声明该协议。连接到已有不同协议的端点时，按端点的协议 ID/版本调整生成对象中的接口声明，或显式映射；不绕过连接校验。

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

## 原生定义示例

需要流水线、分支汇合、嵌套路由或 main 派发 worker 时，读取 Graph 源码 `examples/graphs/{pipeline,fanout,router,supervisor-workers}.json`。文件就是正式 JSON definition，不需要旧模板函数或转换器。使用前替换节点的 coder@1 配方与 work/left/right/text/json 模型连接 ID，并按任务明确填写 task、acceptance、协议及输出要求；再把完整对象交给 graph_create。首次工作由 main 向公开 job 输入投递，完成由 main 显式请求。

示例 check 仅运行 node --version 来展示宿主命令连接，不能证明项目验收；实际任务必须换成项目检查并声明正式 acceptance。fanout 和 supervisor-workers 的 join 明确等待 left/right，成功后锁存一次；下一批工作需要显式重开 join。supervisor-workers 中的 main 位于图外，没有内部 master 节点。router 用两层子 graph 的公开映射连出两个分支，仅选中的接口投递，下游 check 每次收到一个结果就执行，不隐含等待另一个分支。

需要按 ask-matt 复用规划、实现、双轴审查与原节点返工团队时，读取 [Matt 团队装配](matt-team.md)。装配入口写出实际编译配方版本的普通 JSON definition，可保存或作为下述子 graph 模板使用。

## 子 graph 定义与实例

JSON 定义可含 `templates: {build: {version: 7, definition: {...}}}` 与 `instances: {first: {template: "build", version: 7}, second: {template: "build", version: 7}}`。父级连接和公开接口可引用 `first.job`、`second.result` 等子 graph 公开接口。系统将它们展开成 `first/work` 等稳定路径，并固定模板版本、隔离节点配置和内部边 ID。实例仅组织和复用结构，不增加执行或等待。

模块可声明 `control: {reopen: "control"}`，control 必须是已声明输入，且不属于 requiredInputs。该入口的一次有效投递只清除锁存，不替换审查输入，也不立即触发。

模块可在 limits 中显式配置 timeoutMs、memoryMb、inputBytes、outputBytes、stateBytes；修改经 graph_patch 产生可追溯 revision。memoryMb 在 64–16384 范围内。

## 图的端点与路线

原生图的节点位置、尺寸、端点和边折点使用统一 16px 格点。具名逻辑接口在概览上汇为顶部入口、底部出口；前向边、反馈边和自回边都来自正式连接，并使用正交路线避开节点。多条同端点连接只在视觉端点附近共享短线段，之后使用不同通道。运行投递和状态更新沿用同一结构的布局；选中边查看实际具名接口、协议和投递，不根据画面位置推断执行顺序。

## Provider 用量与恢复

生产 resident worker 经 IPC 请求宿主执行模型调用，配置文件不含 provider 凭据。每次实际发送分别受预算与共享凭据名额约束；等待凭据释放全局执行名额，获得凭据后重新取得执行名额。

`graph_inspect({graphId,query:"provider_calls",id?})` 返回实际模型发送记录，id 可限定节点。每条记录包含调用 ID、执行 ID、固定的连接/上游模型身份、状态、预留及已知用量。未知用量保持 null，不按零结算；使用返回的调用 ID 做 reconcile_usage。节点详情的调用历史与 modelsUsed 来自这些记录，旧记录缺少身份时保持未知。

运行时重启会保留输入、提交和尝试计数；无法证明用量或副作用的执行暂停等待处理。`graph_control({graphId,action:"reconcile_usage",callId,usage:{input,output,cacheRead,cacheWrite}})` 显式结算未知 provider 调用；相同结算可重放，不同结算被拒绝。结算不自动恢复节点，之后由 main 明确 resume。已成功提交的输入不能通过 retry 重发。

## 宿主命令模块

需要运行项目检查等外部命令时，声明 operation 模块，由宿主权限边界执行；纯判断代码继续使用隔离环境。例：

```json
{
  "type": "operation",
  "trigger": "each",
  "inputs": {"start": {"protocol": "check-start"}},
  "outputs": {"result": {"protocol": "check-result"}},
  "operation": {
    "action": "workspace.command", "version": 1,
    "command": "node", "args": ["--run", "check"],
    "output": "result", "timeoutMs": 120000
  }
}
```

结果包含 passed、code、commit、operationId、record、stdout/stderr 摘要和耗时；record 指向完整命令记录。非零退出码产生 passed:false。commit 记录实际派发前的 HEAD。verifiedCommit 只在退出码为零、派发前与结束后工作树均干净且 HEAD 相同时记录；完整结果文件包含 commitAfter、cleanBefore、cleanAfter。宿主检查与受管理的 Git 集成共用排他锁。该记录不替代审查、human acceptance 或最终交付条件，也不声称任意外部程序的副作用恰好一次。sandbox 默认启用；sandbox:false 仅允许 full access。宿主 program 配置提供环境和依赖目录，未指定时使用项目自身 node_modules；沙箱检查允许受限回环测试，非回环监听仍被拒绝。最终验收检查的 operation 配置不可通过 graph_patch 修改。

`graph_inspect({graphId,query:"operations"})` 查看持久操作记录。已保存结果在恢复时用于继续投递，不重新执行命令；派发后中断且没有可靠结果的操作标记 uncertain，暂停模块等待 main 检查。停止会终止命令进程组。

## 节点按需读取图定义

节点首轮只接收有限概览：最多 20 个节点、20 个模块、40 条边，任务描述预览为 240 字符；本节点任务、验收、接口及自身协议保留完整内容。未在预览出现不代表对象不存在。

内部 agent 可调用只读 `read_graph({section,id?,after?,limit?})`，section 为 nodes、modules、edges、protocols、acceptance、inputs 或 outputs。id 获取完整具名对象；省略 id 时按当前定义的稳定对象顺序分页，after 默认 0，limit 默认 20、最大 50。返回 revision、total、items 和 nextAfter；nextAfter 为 null 表示本节读完。该工具只读取本 graph，不能修改或启动工作。

查询始终使用当前执行冻结的 revision；运行中 patch 不改变本次读取结果。下一次执行采用新 revision，沿用常驻 Pi 与聊天历史，不因普通任务修改重启会话。

## 节点身份与可编辑提示

recipe 的 review 标记决定审查身份及规则；节点名称和任务文字不参与身份推断。节点运行指导使用可编辑的 runtime/node.md，描述实际 submit、具名输出、聊天和稳定产物引用，不注入旧 submit_result 指令。

配方引用绑定明确版本；发布新版不会自动替换现有节点。升级时用 graph_patch 修改 recipe，下一次执行采用新版并保留历史。

工具失败保留可读原因和结构化 message；失败工具调用可在同一轮继续修正。图请求暂停后，尚有 Agent 执行或宿主命令时显示暂停中，停止后才显示已暂停。

身份、通用规则、相应角色规则/工具指导及节点运行指导修改后，从下一次执行生效；受控重绑保留原会话历史。节点视图显示实际绑定角色，尚未绑定时保持未知。

## 发布稳定代码版本

已准备 Git 工作副本的 worker 可调用 `workspace_commit({paths:["src/feature.ts"],message:"实现异常处理"})`，只提交自己的工作副本中明确指定的路径，返回 repository、worktree 和完整 commit。reviewer 不提供该工具。它不发布产物，也不把改动交付目标分支。

随后调用 `artifact_publish` 发布文件，并使用 `metadata:{kind:"code"}` 标记扩展名无法识别的代码文件。系统记录该文件所属 commit，并核对文件内容与 commit 中的字节一致；尚未提交的修改会被拒绝。将返回的产物 ID 和具体版本通过 submit 传给下游。发布后的内容保持稳定，工作副本后续编辑不会改变已发布版本。代码集成仍在任务执行结束时单独结算。


## 独立审查模型

review 配方从声明连接与已受理投递追溯上游实现节点，排除其实际调用记录中的连接 ID 与上游模型身份；路由模块、返工环和禁用连接不抹掉历史。同一上游模型的其他连接别名也被排除。修改当前模型目录不能改写已执行的身份。没有合格候选或实现身份历史缺失时，保留输入、暂停审查节点并通知 main，不消耗自动重试；独立分支继续运行。

成功 submit 后遇到进程异常或未知用量，原输入记为失败待处理，不再进入可执行队列。已提交输出保留，未知用量和预留保留供 main 显式结算；恢复节点不会重新发送原任务。


## 节点模型与重试配置

节点可声明 `model:"configured-connection-id"` 以及 `retry:{automatic:2,resubmit:1}`。model 指配置连接 ID；审查排除仍生效，不可用或被排除的连接会从其余已配置候选选择替代。缺少候选时暂停节点。retry 的两个值各为非负整数，0 关闭对应自动动作；省略字段使用已确认的 2 次异常重试、1 次缺项补交默认值。

使用局部 patch 修改这些字段，从下一次新执行生效。已开始但中断的执行继续按其保存的 revision 恢复；不会因重启采用新任务、模型声明或重试上限。main 显式 retry 队列项会产生新执行，仍保留累计用量，已成功 submit 的原输入不能 retry。


## 查看实际预算与占位

节点额度随执行保存；恢复同一次执行时沿用该额度。节点详情显示实际累计用量和节点总占位，执行占位与 provider 请求占位分别列出，不应相加重复计算。用量未知时占位保留，main 显式对账后释放。

旧执行缺少额度记录时显示“预算尚无记录”；明确记录 unlimited 才显示额度不限。等待状态来自实际执行标记，尚未统计的等待和运行分项为 null；elapsedMs 是墙钟经过时间。


## Graph 默认配置与节点预算

定义可以声明 `defaults:{model:"connection-id",retry:{automatic:2,resubmit:1},budget:{tokens:1000000}}`；节点使用同名字段覆盖。重试的各字段单独继承。子 graph 的默认值在展开时保存到内部节点，节点自身配置优先于模板，模板优先于顶层默认值。

budget.tokens 是该节点累计额度，非每次运行的新余额；省略继承用户当前默认额度，0 不允许开始有用量的工作。null 请求无限，但用户设置有限额度时，main 的声明不能提高上限或改为无限。未获授权的额度会保留输入、暂停节点并给出处理原因，不调用模型、不消耗自动重试。

新的 execution 保存当时生效的额度；正在执行和已有预算快照的恢复执行不随默认值或 patch 改变。缺失预算历史的恢复执行保持未知并暂停，main 显式 retry 产生新的 execution 身份后使用当前已授权配置，会话和累计用量继续保留。


已完成、停止中、已停止的 graph 不接受执行控制修改；创建新 graph 才开始新的服务生命周期。活动 graph 暂停时显示 paused；stop 会清除 graph 暂停标记并继续取消、停稳，不需要先 resume。


## 检查待处理输入与执行历史

`graph_inspect({graphId,query:"queue",id:"worker",limit:100,after:0})` 按受理顺序读取队列，包含 seq、状态、原 payload、generation 和失败/取消原因。id 可省略以查看整张 graph。返回 items 和 next；next 非 null 时用它作为 after 读取下一页，limit 为 1–200。

`query:"executions"` 使用同样的分页与节点过滤，返回实际执行身份、冻结 revision/预算、尝试/补交计数和 submissionId。retry/skip/cancel 只处理尚未结算的 queued 或 failed 输入；claimed 输入需先等待当前执行结束，done 输入（已回复、跳过或取消）不能重新排队或改写原因。成功提交的原输入即使随后失败也不可 retry。需要新任务时明确发送新投递或聊天。nodeId 的 pause/resume 只接受当前定义中的 agent 节点，moduleId 只接受当前模块；两者不能同时指定，已删除或不存在的目标会被拒绝。模块发生异常后输入保留，修复配置后显式 resume(moduleId) 才重新处理；该操作保留模块输入与成功状态，不清除业务计数或 once latch，graph 暂停仍独立生效。无效 query 或分页参数会明确报错。

局部 JSON merge patch 的 null 表示删除字段；需要设置字面值 `budget.tokens:null` 时使用完整 definition。

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

常驻 Pi 的宿主控制流结束时，会结束未完成的宿主请求、中断当前 turn，并关闭会话与进程；断连后不继续请求模型。已提交输出仍保持不可撤回，崩溃执行和未知用量仍按持久账本由 main 处理，不将进程退出当作任务成功。

不限 token 额度的原生执行在成功模型响应缺少 usage 时使用已有本地估算，provider_calls 中保留 usageSource:"estimated"；费用仍取决于已配置价格。是否允许估算取自本次执行冻结的额度，不采用执行途中改写的配置。有限额度不以估算替代可核算用量，保留 unknown 记录和输入并等待 main 核对；不限额度仍无法估算时保持 usage:null / usageSource:"unknown" 和未知费用，允许后续请求及 workspace_commit；未知调用的占位继续保留，不补造零用量。若下次执行改为有限额度，旧的未知 provider 用量必须先显式核对；执行前暂停队列，不消耗自动重试次数。


确认任务共享项目集成的活动名额。当前任务真正 completed 或 stopped 后才释放名额，最早排队的确认任务随后进入 running；completing / stopping 期间仍保留名额。直接管理创建的 graph 不占用或释放其他确认任务的名额。用户 abandon 对原生 graph 表示停止请求，沿 stopping → stopped 取消待运行输入并等待活动工作停稳；重复 requestId 重放同一 receipt。


SDK 的原生草稿类型是 `NativeProposal`（src/core/types.ts），必须包含 `definition`，只声明 requirementVersion、summary、acceptance、decisions；不需要旧 nodes / containers / loops。`supervisor.propose` 与 `validateProposal` 接受原生对象，main 的 Pi 工具通道也使用这一类型。旧 Proposal 及旧 SDK 调用仍在退役，尚不能据此宣称旧内核已删除。


原生节点聊天（runtime.sendNodeMessage）与内部 peer 聊天（runtime.sendPeerMessage、send_to_peer）均一次消息对应一次队列项；忙碌时排队，空闲时由宿主启动回复，保留原会话，不隐含重跑后继节点。requestId 按目标节点与发送者区分，同内容重放原 receipt，改变内容报 idempotency_conflict；已接受消息在 graph 停止后仍可重放 receipt，新消息关闭。peer 来源记入目标节点聊天记录，可视化消息弧读取该持久记录；用户消息不画成 peer 弧。跨 graph、无效发送者/目标和 self 消息拒绝。


配置保存不能移除活动 graph 声明的模型，或当前执行冻结使用的模型。热修改模型时，当前 turn 保留旧连接，下一次使用新声明；旧 turn 结束后，不再保护已过时的空闲绑定。按配方选出的实际模型也受保护，直到相应节点退役或 graph 结束。未配置的偏好 ID 不会阻止无关配置保存；“移除”只判断本次确实从当前目录删除的连接。


节点通过 send_to_peer 向 main 发送聊天时，消息进入顶层 graph 所属的 main 会话，并记录 graphId、nodeId 和 requestId；main 位于 graph 外部。Pi 工具和 SDK sendPeerMessage 使用同一持久回执规则：同一发送者向同一目标重放同内容只投递一次，改变内容拒绝。graph 停止或完成后不接受内部 agent 的新聊天，但旧回执可重放，main 自己的会话继续服务。graph 没有所属会话时，向 main 发送明确报错。


main 所属会话的任务卡片包含原生 agent 节点，不再依赖旧 nodes / instances。卡片状态与累计已知用量来自原生账本，模型来自实际绑定，预算来自最近一次执行保存的额度；运行后仅修改下次额度不会改写这段执行历史。操作模块通过 graph_inspect 的定义和模块查询查看，节点列表只表示 agent。

确认任务的节点首次执行收到草稿确认时冻结的决策与约束；读取该任务的快照，不从 main 最新聊天重新拼装。切换项目不带入前一项目的约束，草稿之后的聊天不改变已确认快照；草稿显式声明 decisions: [] 表示没有约束，不回退到聊天。后续执行沿用节点会话，不重复初始约束全文，也不注入 main 的会话监控状态。


原生执行开始或从 blocked 恢复时，节点状态同步变为 running，并记录 graph.execution.started 事件；模型请求等待期间仍显示正在执行。执行结算后按实际结果显示 succeeded、blocked 或 failed。main 的会话状态摘要读取原生节点账本；确认后未投递的节点显示 idle，不把确认当作已执行。


main 使用 artifact_publish 的可选 graphId，在自己拥有的原生 graph 中发布或修改产物；修改时保持 namespace/name，并用 expectedVersion 指定已读的版本。省略 graphId 仍发布到 main 自己的任务。内部 agent 的工具不声明该参数，指定它会被拒绝。权限由实际 main operation、节点、实例、activation 和 graph 所有权共同核对；确认产生的 graph 与直接创建的 graph 使用同样的规则。main 的新版记录 main 为修改者，原作者仍以最早发布版本确定；旧版本字节和引用不会改变。

main 使用 artifact_retire({artifactId,version,reason,requestId}) 撤回已被替代或取消的精确版本；不需要再指定 graphId。宿主根据已发布产物的实际 graph 归属和本次 main 执行身份校验所有权，外部会话的读取权限不等于修改权限。撤回事件归属该 graph；重复调用不重复写事件，旧版本字节仍可按精确引用读取，其他版本不受影响。

确认草稿必须声明非空 definition.acceptance，并在外层 acceptance 摘要中完整列出同一组 ID 和描述；check 的 checkNode 对应 module，review 的 checkNode 对应 node。数量、ID、描述或检查对象不一致时，validate_proposal 和 propose_graph 都会在创建草稿前拒绝，不把无法执行或与用户展示矛盾的验收留到完成时才发现。human 仍使用用户验收流程，不从路由 passed 推断人工批准。

脚本化 ActionAdapter 用于无模型的确定性宿主测试，其 operation.input 来自当前已 claim 的投递 value（聊天 / 控制输入保留对应 payload），context.briefing 是该次实际组装的 prompt；不再读取旧 proposal.nodes 的 input/context。正式节点仍通过各自常驻 Pi 执行。原生节点详情的 elapsedMs / timing.totalMs 记录实际执行墙钟时间并可在重启后查看；未记录的 runMs / waitingMs 分项保持 null。


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


#### 上下文与生效版本的本轮验证（2026-10-09）

原生接口 value 原样传递，不自动补 digest/私有绝对路径或产生隐式 artifact。需要共享文件时由实际发布工具创建稳定版本，投递明确的 artifactId/version/digest；接收者读取该版本，不继承发布者私聊。证据过滤由显式 router 字段映射表达，无 context.predecessors/evidence_only 依赖推断。具名输入与聊天沿同一节点私有会话；普通复跑/重启继续原历史，配方/能力重绑沿已确认机制保留实例和聊天历史、分支新 session 文件，不与另一节点共享 session。

graph 使用自己的常驻会话；外部 main 的 operation context 账本继续用于自身 fresh/continue 恢复。旧 graph 继承声明、DAG 调度、前驱 parser 和提交入口已退役。设置页从真实 config response 同时读取保存与生效版本，不允许晚到 startup snapshot 回退已知生效版本。最新源码与默认桌面交付证据见 [逐项验收对应](issue-1-spec-acceptance-matrix.md)。


#### 当前执行与下一次配置

原生节点 run/prompt 的 configurations.current 来自最近执行的冻结 revision，configurations.next 来自最新声明；尚未执行时 current 为空，节点退休后 next 为空。pending 比较节点声明与 defaults，不单凭 revision 数字判断。prompt 的配方/任务标识对应实际发送记录所属执行，模型对应实际 provider call；不重组或预先展示下一次执行的 system prompt。节点独立聊天窗口继续接收 graph 原生事件并更新当前/下一次配置，实际发送内容仍可查看。

#### 节点运行时间

运行时间累计节点实际执行时段（准备、Pi turn、重试/补交与结算），等待凭据和重新取得全局执行名额时单独累计“等待名额”。已阻塞或空闲期间不增加工作时间；同节点下一次投递累加新执行，重启保留已记录计量。总历时为已结算执行的历时之和，与工作时间分开。旧记录没有时间边界、或硬崩溃缺少可信结束边界时，完整执行计量保持“未记录”；恢复剩余工作不会把未知时间补成0或将宿主离线时间算作工作。

运行中局部修改结构会保留未受影响对象的位置，新增对象和发生碰撞的相邻对象自动避让；边按更新后的坐标重新走线。布局按 graph 修订持久化，重启不会重新排列。`graph_control({ graphId, action: "relayout" })` 或画面上的“重新布局”按钮明确丢弃保存的位置，重新排列当前结构；不改变队列、执行或路由状态。


## 模型分层

节点 model 指具体已配置连接 ID；配方 recommendedGrade 使用 small/medium/frontier 分层，已有low/high/highest保留。新frontier选择依次匹配frontier、highest、high；旧high仍优先high且不扩成highest。目录视图公开只读tier，设置页可按三层筛选。main发现配方时可使用 list_agent_combinations({grade:"frontier"})。厂商与模型配置按需读取 [模型配置说明](models-and-providers.md)，不增加常驻配置工具。
