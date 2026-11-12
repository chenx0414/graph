# 动态子 Agent 规格

本规格落实 [ADR 0043](../adr/0043-unified-agent-runtime-and-fleet.md) 第 3 条：任何层级的 Agent 都能 `spawn` 子 Agent。它只定义新增行为，不改变既有主管、graph 节点与执行账本的语义。

## 身份

子 Agent 是独立持久实体，不是一个 graph 节点：

- `conversations.role='child'`，`conversations.parent_conversation_id` 指向父会话；
- 自己的 anchor 任务（`tasks.phase='chatting'`）与 `master` 节点，复用现有执行链；
- `agents` 行：`kind='child'`、`parent_id`=父 Agent 的席位 id、`conversation_id`、`task_id`、`project_id` 继承父级；
- 自己的工作区与 durable 会话；
- 不出现在用户会话列表，只在编队页的父级下面出现。

父子关系只认 `agents.parent_id`；节点、会话、任务都不是父子关系的来源。

## spawn 工具

对 global、project、node、child 四类 Agent 默认可见，受能力包与授权上限约束：

```
spawn_agent({
  objective: string,          // 必填，子 Agent 的第一条任务
  name?: string,              // 编队页显示名，缺省从 objective 生成
  model?: string,             // 缺省继承父级
  workspace?: "isolated" | "read-only" | "inherit-readonly",
  wait?: false,               // v1 只支持 false，true 显式报错
  maxTurns?: integer          // 缺省 1，只影响自动续跑，不改变会话持久性
}) -> {
  agentId: string,
  conversationId: string,
  taskId: string
}
```

- 立即返回，不阻塞父级回合；子 Agent 的第一个回合由运行时派发。
- `workspace` 缺省 `isolated`：在 `state/children/<agentId>` 新建工作目录，不写父级工作区。
- `read-only`：只读父级工作区与共享产物，不获得写权限。
- 子 Agent 继承父级的项目绑定、能力包上限与授权上限；不能请求更大权限。
- 子 Agent 可以继续 spawn，受深度与数量限制。

## 结果与唤醒

- 子 Agent 回合结束时：
  - 最终回复写一条 `kind='agent_result'` 的消息到父会话；父级是 graph 节点时写 `node_entries` 的 `kind='agent_result'` 条目；
  - 同一事务里写一条 `wake_intents`，`kind='agent_result'`，`dedupe_key=childAgentId+operationId`；
  - 失败时同样投递，`kind='agent_failure'`，带失败原因，父级可决定重试或接管。
- 父级被唤醒后可用 `read_agent({agentId, sinceSeq?})` 读子 Agent 的会话尾部，或用 `list_children({agentId?})` 看子级状态。
- `message_agent({agentId, text})` 给子 Agent 追加消息；子 Agent 忙时排队，空闲时开始下一回合。
- `stop_agent({agentId, reason?})` 停止子 Agent 的当前执行并暂停其队列；不删除会话与编队记录。

## 限制

配置项（写入 `graph.config.json`，非法值启动时报错）：

- `limits.maxAgents`：项目总 Agent 数上限，默认 1024（含 global/project/node/child）。
- `limits.spawnDepth`：从 global 算起的最大生成深度，默认 4。
- `limits.childrenPerAgent`：单个 Agent 直接子级上限，默认 16。
- `limits.agentExecutions`：同时活跃执行上限，见 ADR 0043。

达到限制时 `spawn_agent` 返回确定性错误并点名哪条限制；不静默排队，不返回假成功。

## 父级消失

- 父级被 pause 不自动暂停子级；父级归档时子级进入 `paused`，其会话保留只读。
- 父级完成时子级继续完成已派发的工作；子级结果投递失败不算父级失败，记一条问题。

## 编队投影

`GET /api/fleet` 返回的 `agents` 中，child 的 `parentId` 指向父级；`status` 由 anchor 任务与 operations 聚合；`tokens/cost/requests/messages` 与主管同口径。`links` 中父子边 `kind='parent'`，spawn 边 `kind='spawn'`。

## 验证

- 单元：spawn 创建会话/任务/席位/工作区；限制逐条拒绝；结果消息与 wake 去重；`read_agent` 分页。
- 集成：真实 SQLite + 假 provider，证明 child 回合完成后父级被唤醒、父级读到结果、编队投影出现 child。
- 1,000 并发：同一测试进程内创建 1,000 个 child 席位，验证 limiter 与编队查询，不调真实模型。
- 真机：编队页打开 child 详情、点击打开会话、停止子 Agent。
