# 代码交付示例：worktree、检查与独立审查

为代码修改建立正式 graph、绑定宿主检查和独立审查时，使用 [parser-delivery.json](../../examples/graphs/parser-delivery.json) 作为完整定义示例。它修复项目中导出 `parseConfig` 的 `config.js`：忽略空行，保留值中的等号。项目使用 ESM；检查真实导入文件并验证结果。其他业务任务沿用该结构，替换任务、节点指令、产物与项目检查。

示例采用 main 显式投递：work、check、review 的输入都是 job，edges 为空。执行、检查和审查各自留下正式证据，main 按实际完成状态投递下一项。它不自动开始，也不因 worker 成功而自动结束。

## 装配与确认

1. `get_agent_combination({id:"coder"})` 与 `get_agent_combination({id:"reviewer"})` 查询稳定配方 ID；`read_system_capabilities` 核对当前定义版本和可用模型。将 JSON 中的 coder@1/reviewer@1 换为当前实际 definitionVersion，work/review 换为已配置且符合用户模型选择的连接 ID。reviewer 使用 review=true 的配方，实际模型独立于实现者。节点指令中的工具需要由这些配方绑定。
2. 读取示例 JSON 为 `definition`，保留 `workspace.base:"worktree"`。按真实需求填写 task、instructions 和 acceptance；宿主检查命令对应项目实际行为。此 parser 示例的检查不是通用项目检查。
3. 草稿的外层验收摘要与 definition 内正式验收一一对应：

```js
const proposal = {
  requirementVersion: 1, // 使用当前会话的需求版本
  summary: '修复 parser 并交付目标分支',
  definition,
  acceptance: definition.acceptance.map(item => ({
    id: item.id,
    description: item.description,
    checkNode: item.kind === 'check' ? item.module : item.node,
  })),
};
// 调用 validate_proposal({proposal}) 后，使用 propose_graph({proposal,requestId})。
```

该映射用于示例的 check/review 两类；存在 human 或其他验收时，按 [正式验收契约](graph-v2.md#最终版本验收与-git-交付)填写。用户查看并确认当前草稿修订与目标分支后，等待 graph_ready，取得实际 graphId。确认授权、修订标识与分支规则见 [创建与启动](graph-v2.md#创建与启动)。

## 实施、检查、审查、交付

下面的 `graphId` 与 `commit` 都来自本次运行回执。

1. `graph_send({graphId,nodeId:"work",input:"job",value:{}})`；用 `get_task_status({taskId:graphId,waitForNode:"work",timeoutMs:15000})` 观察实际终态。等待返回仍未完成时继续观察，失败则先处理真实原因。worker 在自己的 worktree 修改、验证、workspace_commit，并发布代码 artifact；执行成功后由宿主集成。
2. `graph_inspect({graphId,query:"acceptance"})` 读取当前 integration `commit`。workspace_commit 返回的 worker 提交与 integration commit 是不同事实，review 使用后者。
3. `graph_send({graphId,nodeId:"check",input:"job",value:{}})` 执行示例中的真实宿主检查。再次检查 acceptance，确认 behavior 对当前提交通过；operations 详情可核对原始输出与 verifiedCommit。
4. `graph_send({graphId,nodeId:"review",input:"job",value:{commit}})`；等待 reviewer 实际完成。它发现并读取不可变代码 artifact 的精确版本，发布 schema=graph.review@1 的 application/json 报告，正文为 `{commit,passed,reason}`，其中 commit 是实际审查的完整 integration SHA，passed 是真实结论。
5. 再读 acceptance，核对检查、独立审查与当前提交一致。目标或集成提交发生变化时，旧通过记录会 stale，需要验证新提交。全部满足后 `graph_control({graphId,action:"complete"})`，继续核对 graph phase=completed 及正式 Git 交付记录。完成请求与实际交付分开；blocked 的原因以运行回执为准。

main 的投递和完成调用不替代 worker 的 commit、真实 host check、reviewer 报告或用户已声明的人工验收。产物精确引用与 Git 规则见 [Artifacts, Handoff and Git](artifacts-and-git.md)；返工、暂停和恢复见 [Graph v2](graph-v2.md)。

## 验证范围

`tests/e2e/harness-workflow.test.ts` 直接读取该 JSON，只替换本地模型/已编译配方连接，并在自动偏好行省略显式 worker model。真实 Pi、Git worktree、提交、artifact、宿主检查、独立审查、目标项目行为及全树用量均由原有 owner 验证。外部模型是本地受控服务；这证明示例可执行，不证明真实 planner 一定能在指定时限内完成，也不改变用户授权和模型选择规则。
