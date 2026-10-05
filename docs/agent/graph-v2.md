# Graph v2 管理入口

本页描述正在接入产品的新内核 API。正式切换和旧内核退役尚未完成；不要把本文当作 Issue #1 已验收的证明。完整契约见 [已确认规格](../specs/graph-rebuild-v2.md)。

## 创建与启动

`graph_create({definition,targetBranch?})` 接收完整 JSON 定义，返回 graphId、验证后的定义和 revision。节点等待投递；创建不自动执行根节点。targetBranch 用于需要 Git 工作副本与交付合并的任务。graph 由当前 main agent 拥有。

定义包含 schemaVersion:2、name、protocols、nodes、modules、edges，以及公开 inputs/outputs。Agent 节点声明 recipe、task、acceptance、inputs、outputs、submission。协议是 JSON schema；连接的两端必须引用相同 protocol 与 version。完整示例和限制见规格第 4 节。

`graph_send({graphId,nodeId,input,value})` 向节点或模块的具名输入投递；省略 nodeId 时，input 指向 graph 的公开输入。系统持久保存 direct delivery 并与 landing 一起提交；value 必须满足输入协议。

`graph_send({graphId,nodeId,text})` 发送直接聊天。聊天与接口投递共用节点的串行队列；聊天可以只回复，不提交工作流输出。

## 修改与观察

`graph_patch({graphId,baseRevision,changes:{definition,reason,retire?}})` 发布新 revision。baseRevision 过期时不写入。删除节点必须明确列在 retire 中；存在运行、排队或失败待处理工作时，先处理工作。当前执行保留原配置，后续 submit 使用届时的连接。

`graph_inspect({graphId,query,id?})` 支持 summary（默认）、revision、nodes、results、edge、module、operations。edge/module 查询要求对应对象的 id。results 是公开输出收到的业务结果；运行失败与完成通知单独记录。

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

结果包含 passed、code、commit、operationId、record、stdout/stderr 摘要和耗时；record 指向完整命令记录。非零退出码产生 passed:false。commit 记录命令开始前的 HEAD，本身不证明执行期间文件未变化，也不替代最终版本验收。sandbox 默认启用；sandbox:false 仅允许 full access。

`graph_inspect({graphId,query:"operations"})` 查看持久操作记录。已保存结果在恢复时用于继续投递，不重新执行命令；派发后中断且没有可靠结果的操作标记 uncertain，暂停模块等待 main 检查。停止会终止命令进程组。

## 节点身份与可编辑提示

recipe 的 review 标记决定审查身份及规则；节点名称和任务文字不参与身份推断。节点运行指导使用可编辑的 runtime/node.md，描述实际 submit、具名输出、聊天和稳定产物引用，不注入旧 submit_result 指令。

身份、通用规则、相应角色规则/工具指导及节点运行指导修改后，从下一次执行生效；受控重绑保留原会话历史。节点视图显示实际绑定角色，尚未绑定时保持未知。

## 发布稳定代码版本

已准备 Git 工作副本的 worker 可调用 `workspace_commit({paths:["src/feature.ts"],message:"实现异常处理"})`，只提交自己的工作副本中明确指定的路径，返回 repository、worktree 和完整 commit。reviewer 不提供该工具。它不发布产物，也不把改动交付目标分支。

随后调用 `artifact_publish` 发布文件，并使用 `metadata:{kind:"code"}` 标记扩展名无法识别的代码文件。系统记录该文件所属 commit，并核对文件内容与 commit 中的字节一致；尚未提交的修改会被拒绝。将返回的产物 ID 和具体版本通过 submit 传给下游。发布后的内容保持稳定，工作副本后续编辑不会改变已发布版本。代码集成仍在任务执行结束时单独结算。
