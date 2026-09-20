# Graph Overview

Graph 是用于编排多个 coding Agent 完成已有项目功能的本地控制台。它不是一个单独的聊天模型，也不是一个新的包管理器；它负责把用户确认的需求转换为可执行图，并在宿主边界内控制 Agent、工具、预算、权限、恢复、证据和 Git 集成。

## 核心角色

### 用户

用户负责确认需求、验收项、目标分支、预算变化、权限扩大和必须由人完成的检查。用户不负责手工拆任务或把上下文复制给每个 worker。

### Main Agent

Main Agent 直接与用户对话，调查项目、澄清需求、提出任务图草案、选择已配置模型和 Agent 配方、监控执行、处理内部问题并汇报结果。

Main Agent：

- 不直接实现业务代码；
- 不能绕过用户确认直接启动执行；
- 不能通过 prompt 自行扩大权限或预算；
- 对内部执行问题先诊断，再决定重试、答复、返工或升级给用户；
- 可以读取 Graph 的实时自模型和 Agent 文档，以解释或优化系统。

### Worker Agent

Worker 在独立 Agent instance 和 Git worktree 中实现、检查、审查或验证被分配的节点。它只接收任务 briefing、允许的 handoff、artifact 引用和当前 definition 的能力包。

### Program Node

Program node 由宿主执行确定性工作，例如运行测试、检查文件、验证 review report 或等待人工确认。它不占 Agent 并发名额，但仍受暂停、权限、审计和恢复规则约束。

## 一次功能任务的典型流程

1. 用户创建对话并描述目标。
2. Main Agent 只读调查项目，必要时询问会改变方案的问题。
3. Main Agent 提交任务图草案和 decisions。
4. 用户确认草案和目标分支。
5. Graph 创建正式功能任务，准备 integration branch 和 Agent instance worktree。
6. 调度器按依赖派发 agent/program nodes。
7. Worker 提交 result handoff、artifact 和 evidence。
8. 检查、独立审查和 verifier 决定通过、返工或阻塞。
9. 满足 acceptance 和审查后，将已验证提交合入目标分支。

## 核心领域词汇

- **功能任务**：一项已确认边界的功能开发工作；新增功能另建任务。
- **任务图**：程序生成、会版本化的执行结构。
- **Agent 定义**：可复用、版本化的能力配置；具体模型不属于定义身份。
- **Agent 实例**：一个节点对应的会话、worktree、预算和身份。
- **Operation**：一次实际模型、工具、命令或 MCP 派发。
- **Artifact**：任务级不可变内容版本。
- **Evidence**：某验收项在具体输入和提交上的证据。
- **Result Handoff**：实现节点给下游的结构化工作结果。
- **问题**：需要 Main Agent 或用户处理的结构化阻塞。

完整术语以 Graph source tree 的 `CONTEXT.md` 为准。

## 不需要猜测的事实

- 任务状态：读取 conversation/task view。
- 图结构：读取 task graph view 和 graph revision。
- 工具能力：读取 `read_system_capabilities` 和 Agent definition。
- 工具实际可用性：读取 capability load fact、session manifest 或 node run。
- 执行问题：读取 `inspect_graph_system` 和 `list_problems`。
- 系统版本：读取 `application.root` 和 `application.mode`。

如果这些接口没有给出答案，报告“未知”，不要从历史对话中补造事实。
