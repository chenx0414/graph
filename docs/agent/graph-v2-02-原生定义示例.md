# 原生定义示例

## 原生定义示例

需要流水线、分支汇合、嵌套路由或 main 派发 worker 时，读取 Graph 源码 `examples/graphs/{pipeline,fanout,router,supervisor-workers}.json`。文件就是正式 JSON definition，不需要旧模板函数或转换器。使用前替换节点的 coder@1 配方与 work/left/right/text/json 模型连接 ID，并按任务明确填写 task、acceptance、协议及输出要求；再把完整对象交给 graph_create。首次工作由 main 向公开 job 输入投递，完成由 main 显式请求。

示例 check 仅运行 node --version 来展示宿主命令连接，不能证明项目验收；实际任务必须换成项目检查并声明正式 acceptance。fanout 和 supervisor-workers 的 join 明确等待 left/right，成功后锁存一次；下一批工作需要显式重开 join。supervisor-workers 中的 main 位于图外，没有内部 master 节点。router 用两层子 graph 的公开映射连出两个分支，仅选中的接口投递，下游 check 每次收到一个结果就执行，不隐含等待另一个分支。

需要按 ask-matt 复用规划、实现、双轴审查与原节点返工团队时，读取 Matt 团队装配（该文档已删除）。装配入口写出实际编译配方版本的普通 JSON definition，可保存或作为下述子 graph 模板使用。

## 子 graph 定义与实例

JSON 定义可含 `templates: {build: {version: 7, definition: {...}}}` 与 `instances: {first: {template: "build", version: 7}, second: {template: "build", version: 7}}`。父级连接和公开接口可引用 `first.job`、`second.result` 等子 graph 公开接口。系统将它们展开成 `first/work` 等稳定路径，并固定模板版本、隔离节点配置和内部边 ID。实例仅组织和复用结构，不增加执行或等待。

模块可声明 `control: {reopen: "control"}`，control 必须是已声明输入，且不属于 requiredInputs。该入口的一次有效投递只清除锁存，不替换审查输入，也不立即触发。

模块可在 limits 中显式配置 timeoutMs、memoryMb、inputBytes、outputBytes、stateBytes；修改经 graph_patch 产生可追溯 revision。memoryMb 在 64–16384 范围内。

## 图的端点与路线

原生图的节点位置、尺寸、端点和边折点使用统一 16px 格点。具名逻辑接口在概览上汇为顶部入口、底部出口；前向边、反馈边和自回边都来自正式连接，并使用正交路线避开节点。多条同端点连接只在视觉端点附近共享短线段，之后使用不同通道。运行投递和状态更新沿用同一结构的布局；选中边查看实际具名接口、协议和投递，不根据画面位置推断执行顺序。

## Provider 用量与恢复

生产 Go 宿主通过私有 Unix socket 与同一数据库的共享 durable SDK 进程通信；main 与节点共用 Harness，模型请求和工具准入由 Go 执行，SDK 配置只保留凭据引用。每次实际发送分别受预算与共享凭据名额约束；等待凭据释放全局执行名额，获得凭据后重新取得执行名额。

`graph_inspect({graphId,query:"provider_calls",id?})` 返回实际模型发送记录，id 可限定节点。每条记录包含调用 ID、执行 ID、固定的连接/上游模型身份、状态、预留及已知用量。未知用量保持 null，不按零结算；使用返回的调用 ID 做 reconcile_usage。节点详情的调用历史与 modelsUsed 来自这些记录，旧记录缺少身份时保持未知。

运行时重启会保留输入、提交和尝试计数；无法证明用量或副作用的执行暂停等待处理。`graph_control({graphId,action:"reconcile_usage",callId,usage:{input,output,cacheRead,cacheWrite}})` 显式结算未知 provider 调用；相同结算可重放，不同结算被拒绝。结算不自动恢复节点，之后由 main 明确 resume。已成功提交的输入不能通过 retry 重发。SDK 已完成但 Graph 确认丢失时，显式恢复沿用原 execution、attempt 与 submission 完成验收，不重发模型或输出；未发送输入恢复冻结的原配置，未知外部效果继续停驻核对。

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

节点可声明 `model:"configured-connection-id"` 以及 `retry:{automatic:2,resubmit:1}`。model 指配置连接 ID；审查排除仍生效，不可用或被排除的连接会从其余已配置候选选择替代。缺少候选时暂停节点。

发送时的传输层回退是另一件事：如果这个连接在 `models.entries[]` 里配了 `fallbackModelId`，而这次发送在主选上因**传输层/协议层边界**失败（连接错误或 EOF、超时、非 2xx、流没走完就断，且一个字都没答出来），同一次发送会由回退模型接着答完——这一轮不重开、节点执行不加一次，`provider_calls` 记的是真正回答的模型（失败的尝试单独一行、用量为 0）。每次回退在图上记一条 `graph.provider.fallback` 事件，带 `primaryModel`、`error`（失败原文，一字不改）、`fallbackModel`、`sameModel`（两个 id 是否同一模型，真的换了模型是 `false`）。模型答了但内容不合格、工具调用写坏、审查不通过都**不**触发回退：那是这一轮的回答。两边都失败时这一轮明确失败，错误消息同时带两段原文。配置与守卫见 `models-and-providers.md`。retry 的两个值各为非负整数，0 关闭对应自动动作；省略字段使用已确认的 2 次异常重试、1 次缺项补交默认值。

使用局部 patch 修改这些字段，从下一次新执行生效。已开始但中断的执行继续按其保存的 revision 恢复；不会因重启采用新任务、模型声明或重试上限。main 显式 retry 队列项会产生新执行，仍保留累计用量，已成功 submit 的原输入不能 retry。


## 查看实际用量与占位

节点详情显示实际累计用量和节点总占位，执行占位与 provider 请求占位分别列出，不应相加重复计算。用量未知时占位保留，main 显式对账后释放。等待状态来自实际执行标记，尚未统计的等待和运行分项为 null；elapsedMs 是墙钟经过时间。


## Graph 默认配置

定义可以声明 `defaults:{model:"connection-id",retry:{automatic:2,resubmit:1}}`；节点使用同名字段覆盖。重试的各字段单独继承。子 graph 的默认值在展开时保存到内部节点，节点自身配置优先于模板，模板优先于顶层默认值。

宿主不设 token 额度上限：一次运行花多少就记多少，超支不会阻断发送或工具调用。定义里遗留的 `budget` 字段会被忽略。


已完成、停止中、已停止的 graph 不接受执行控制修改；创建新 graph 才开始新的服务生命周期。活动 graph 暂停时显示 paused；stop 会清除 graph 暂停标记并继续取消、停稳，不需要先 resume。


## 检查待处理输入与执行历史

`graph_inspect({graphId,query:"queue",id:"worker",limit:100,after:0})` 按受理顺序读取队列，包含 seq、状态、原 payload、generation 和失败/取消原因。id 可省略以查看整张 graph。返回 items 和 next；next 非 null 时用它作为 after 读取下一页，limit 为 1–200。

`query:"executions"` 使用同样的分页与节点过滤，返回实际执行身份、冻结 revision/预算、尝试/补交计数和 submissionId。retry/skip/cancel 只处理尚未结算的 queued 或 failed 输入；claimed 输入需先等待当前执行结束，done 输入（已回复、跳过或取消）不能重新排队或改写原因。成功提交的原输入即使随后失败也不可 retry。需要新任务时明确发送新投递或聊天。nodeId 的 pause/resume 只接受当前定义中的 agent 节点，moduleId 只接受当前模块；两者不能同时指定，已删除或不存在的目标会被拒绝。模块发生异常后输入保留，修复配置后显式 resume(moduleId) 才重新处理；该操作保留模块输入与成功状态，不清除业务计数或 once latch，graph 暂停仍独立生效。无效 query 或分页参数会明确报错。

局部 JSON merge patch 的 null 表示删除字段；需要设置字面值 `budget.tokens:null` 时使用完整 definition。
