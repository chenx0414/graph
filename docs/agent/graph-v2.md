# Graph v2 管理入口

本页描述正在接入产品的新内核 API。正式切换和旧内核退役尚未完成；不要把本文当作 Issue #1 已验收的证明。完整契约见 [已确认规格](../specs/graph-rebuild-v2.md)。

## 创建与启动

需要用户确认的草稿使用 `propose_graph({proposal:{requirementVersion,summary,definition,acceptance,decisions?},requestId})`。definition 使用本文同一 JSON 格式；无需旧 nodes 数组。外层 acceptance 暂用 `{id,description,checkNode}`，指向定义中的实际节点或模块；定义同时声明正式 acceptance 时，两者需一致。main 位于定义外部。确认后收到 graph_ready 通知，再显式 graph_send，不自动运行根节点。主 agent 的 propose_graph 只接收此结构化对象，已关闭旧 proposalJson 字符串别名；运行中修改使用 graph_patch，旧 revise_graph 工具已移除。SDK 与旧内核的完整退役仍在实施，尚未完成默认切换。

提交草稿前可调用 `validate_proposal({proposal})`，传入与 `propose_graph` 完全相同的原生对象；返回 `valid:true` 或 `valid:false` 与错误，不创建草稿、不启动节点。预检不接收旧 `proposalJson` 字符串。

`graph_create({definition,targetBranch?})` 接收完整 JSON 定义，返回 graphId、验证后的定义和 revision。节点等待投递；创建不自动执行根节点。targetBranch 用于需要 Git 工作副本与交付合并的任务。graph 由当前 main agent 拥有。

定义包含 schemaVersion:2、name、protocols、nodes、modules、edges，以及公开 inputs/outputs。Agent 节点声明 recipe、task、acceptance、inputs、outputs、submission。协议是 JSON schema；连接的两端必须引用相同 protocol 与 version。完整示例和限制见规格第 4 节。

`graph_send({graphId,nodeId,input,value})` 向节点或模块的具名输入投递；省略 nodeId 时，input 指向 graph 的公开输入。系统持久保存 direct delivery 并与 landing 一起提交；value 必须满足输入协议。

`graph_send({graphId,nodeId,text})` 发送直接聊天。聊天与接口投递共用节点的串行队列；聊天可以只回复，不提交工作流输出。

## 修改与观察

`graph_patch({graphId,baseRevision,changes:{definition,reason,retire?}})` 发布新 revision。baseRevision 过期时不写入。删除节点必须明确列在 retire 中；存在运行、排队或失败待处理工作时，先处理工作。当前执行保留原配置，后续 submit 使用届时的连接。

局部修改使用 `changes:{reason,patch,retire?}`，与 definition 二选一。例如 `patch:{nodes:{work:{task:"处理新增边界"}},edges:{review:{enabled:false}}}`。对象字段递归合并，数组整体替换，null 删除字段；未指定内容保留。结果仍按同一正式 graph 定义整体验证，不增加第二套 graph 格式。删除节点仍要显式 retire 并先处理待办工作；有连接时同时在 patch 中删除对应边。

`graph_inspect({graphId,query,id?})` 支持 summary（默认）、revision、nodes、results、edge、module、operations、provider_calls。edge/module 查询要求对应对象的 id。results 是公开输出收到的业务结果；运行失败与完成通知单独记录。

## 控制

`graph_control({graphId,action,nodeId?,moduleId?,seq?,operationId?})`：

- pause/resume：有 nodeId 时控制该节点队列，否则控制整个 graph 的派发。
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


## 子 graph 定义与实例

JSON 定义可含 `templates: {build: {version: 7, definition: {...}}}` 与 `instances: {first: {template: "build", version: 7}, second: {template: "build", version: 7}}`。父级连接和公开接口可引用 `first.job`、`second.result` 等子 graph 公开接口。系统将它们展开成 `first/work` 等稳定路径，并固定模板版本、隔离节点配置和内部边 ID。实例仅组织和复用结构，不增加执行或等待。

模块可声明 `control: {reopen: "control"}`，control 必须是已声明输入，且不属于 requiredInputs。该入口的一次有效投递只清除锁存，不替换审查输入，也不立即触发。

模块可在 limits 中显式配置 timeoutMs、memoryMb、inputBytes、outputBytes、stateBytes；修改经 graph_patch 产生可追溯 revision。memoryMb 在 64–16384 范围内。

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

结果包含 passed、code、commit、operationId、record、stdout/stderr 摘要和耗时；record 指向完整命令记录。非零退出码产生 passed:false。commit 记录实际派发前的 HEAD。verifiedCommit 只在退出码为零、派发前与结束后工作树均干净且 HEAD 相同时记录；完整结果文件包含 commitAfter、cleanBefore、cleanAfter。宿主检查与受管理的 Git 集成共用排他锁。该记录不替代审查、human acceptance 或最终交付条件，也不声称任意外部程序的副作用恰好一次。sandbox 默认启用；sandbox:false 仅允许 full access。

`graph_inspect({graphId,query:"operations"})` 查看持久操作记录。已保存结果在恢复时用于继续投递，不重新执行命令；派发后中断且没有可靠结果的操作标记 uncertain，暂停模块等待 main 检查。停止会终止命令进程组。

## 节点按需读取图定义

节点首轮只接收有限概览：最多 20 个节点、20 个模块、40 条边，任务描述预览为 240 字符；本节点任务、验收、接口及自身协议保留完整内容。未在预览出现不代表对象不存在。

内部 agent 可调用只读 `read_graph({section,id?,after?,limit?})`，section 为 nodes、modules、edges、protocols、acceptance、inputs 或 outputs。id 获取完整具名对象；省略 id 时按当前定义的稳定对象顺序分页，after 默认 0，limit 默认 20、最大 50。返回 revision、total、items 和 nextAfter；nextAfter 为 null 表示本节读完。该工具只读取本 graph，不能修改或启动工作。

查询始终使用当前执行冻结的 revision；运行中 patch 不改变本次读取结果。下一次执行采用新 revision，沿用常驻 Pi 与聊天历史，不因普通任务修改重启会话。

## 节点身份与可编辑提示

recipe 的 review 标记决定审查身份及规则；节点名称和任务文字不参与身份推断。节点运行指导使用可编辑的 runtime/node.md，描述实际 submit、具名输出、聊天和稳定产物引用，不注入旧 submit_result 指令。

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

`query:"executions"` 使用同样的分页与节点过滤，返回实际执行身份、冻结 revision/预算、尝试/补交计数和 submissionId。根据队列的 seq 选择 retry/skip/cancel 前，先确认是否已经成功提交；成功提交的原输入不可重发。无效 query 或分页参数会明确报错。

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

宿主 operation 与其他程序执行共用全局 4 个程序名额。等待名额的 operation 保持 prepared；名额取得后才允许跨越 dispatched 边界，实际 runner 结束后释放。operations 检查中的 worker_active 表示资源占位，不能据此声称 PID 存活或副作用已完成。等待期间 stop 不派发命令、不留下占位。恢复只自动释放未派发 prepared 的占位；已派发且不确定的占位保留，未核实终止前拒绝 cancel_operation。硬崩溃后的进程身份核查与安全释放仍待接通。

## 宿主命令崩溃后的资源占位

`sandbox:false` 的操作由独立监督进程执行；宿主死亡时终止命令组。监督进程记录本次操作的清理凭证，恢复和 `cancel_operation` 核对凭证后释放程序名额。凭证缺失或不匹配时继续保留占位，不能仅根据宿主已经退出就认定命令已经清理。

释放资源不会证明副作用或检查结果：操作仍为 `uncertain`、模块暂停，不自动重跑，不产生业务输出。main 核查后明确取消已有操作，再通过新的合法输入启动后续工作。受限执行器尚未接通同等凭证，不能将上述清理保证解释为所有运行方式均已完成。

常驻 Pi 的宿主控制流结束时，会结束未完成的宿主请求、中断当前 turn，并关闭会话与进程；断连后不继续请求模型。已提交输出仍保持不可撤回，崩溃执行和未知用量仍按持久账本由 main 处理，不将进程退出当作任务成功。
