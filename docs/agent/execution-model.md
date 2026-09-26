# Graph Execution Model

## 图与版本

任务图由 proposal 创建，用户确认后成为正式图版本。图可以包含：

- Agent node；
- Program node；
- 子图/container；
- 顺序和依赖边；
- 条件路由；
- fan-out / fan-in；
- 主管-工人等待与唤醒；
- 回到原节点和原 instance 的返工回环。

图修订使用新版本，不原地覆盖历史。已确认的 acceptance 和关键程序检查输入不能在修订通道中静默改变。修订可以显式带上目标任务（`revise_graph` 的 `taskId`）：不带时修订本会话自己的任务，带上时可以修订本会话创建的功能任务（即确认草稿后真正在执行的那个），但跨会话的任务一律拒绝。

## Agent Instance

一个 Agent node 对应一个 Agent instance。Instance 拥有：

- 稳定 instance id；
- Agent definition version；
- session；
- Git worktree；
- 预算作用域和累计 usage；
- activation history；
- 可恢复的 context binding。

返工、恢复和模型切换保持 instance 身份；新 Fork 或 Fresh 执行创建新的 node/instance 关系。

每个 Agent node 在**每次派发**时都跟随它自己那份配方的最新 definition 版本：配方一改，下一次派发即生效。节点保留自己的模型、工作副本和位置，只有 definition version 前移；已完成的节点不会因此重跑。

## Operation

所有真实外部动作都先写 operation intent，再派发，再结算。实际动作包括：

- 模型请求；
- 工具调用；
- 命令执行；
- MCP 调用；
- extension 请求；
- provider retry、compact 和 summary；
- Git 写入；
- 共享 artifact 发布。

Operation 通过调用门执行。暂停、预算、权限、并发和恢复规则在真实派发前检查，而不是只在 agent turn 开始时检查。

## 激活与循环

Activation 区分同一节点的新一轮执行。回环返回到原节点时：

- 不创建新的 Agent 身份；
- 保留 session、worktree 和累计预算；
- 使用新的 activation id；
- 旧轮次 evidence 不能验证新输入。

汇合节点绑定本轮分支集合、activation 和输入版本。旧轮次成功不能错误满足新轮次。

## 工具返回与大结果

每个工具结果都要经过 agent loop 的 `afterToolCall` 接缝（`src/runtime/tool-results.ts`），它只替换 `content`，工具的 `details` 与 `terminate` 提示照旧存活：

- 小于 `TOOL_RESULT_LIMIT`（4,000 字符）的结果原样交给模型；
- 大于该阈值的结果，同一会话/工具/参数/内容的**前两次**仍全量返回，**第三次起**换为不超过 `SUMMARY_LIMIT`（1,024 字符）的首尾视图；
- `bash` 另有 `SHELL_OUTPUT_LIMIT`（20,000 字符）封顶，与只读 `git` 同口径，从第一次视图就生效；`read_system_capabilities` 同样单发封顶 `SYSTEM_SUMMARY_LIMIT`（12,000 字符）——它是一次性大结果，懒加载永远碰不到它；
- 被压缩的结果总是形如 `[large tool result: N chars, M lines]` … `... omitted X of N chars ...` … `handle: <路径>` … `Read the whole result with the read tool (offset/limit) on that path.`。数字的**单位是字符，不是字节**（非 ASCII 结果在磁盘上比它长），句柄是 `<instance>/tool-results/<key>.txt`，仍然包含逐字节完整的原文。

**工具返回不是证据**，因此压缩不影响验收；但「按需拉全」必须真的可行：需要完整内容时用 `read` 读句柄路径（`offset`/`limit` 分段），不要凭摘要下结论。上游 `read`/`bash` 自带的上限与 `offset` 继续读、完整输出临时文件路径照旧保留，本接缝不重复实现；`read` 与 `edit` 不在 Graph 侧封顶（`edit` 的模型可见内容本来就只有一行）。

四条边界保证它长期诚实：occurrence 映射每个 scope 最多记 256 个键（按最近使用淘汰——被遗忘的键最坏只是再全量一次，绝不会静默截断）；同一时刻最多 64 个 scope；每个实例目录最多留 256 个句柄文件，超出按最旧回收，**因此句柄是尽力保留**：读到不存在的句柄说明它已被回收，重跑那次工具即可。计数与句柄放在一起（`<instance>/tool-results/counts.json`，按 scope 分组、原子替换），所以同一 binding 的实例被重开（含 daemon 重载）后接着原来的次数往下数，而不是从零开始。

## 并发

整个任务图共享 Agent 并发名额，Main Agent 也计入。等待依赖或用户时会释放名额；恢复执行前重新获取。Program node 不占 Agent 名额，但工具进程仍可受宿主资源控制。对话阶段的主管在会话未归档时，由待处理消息、显式恢复、问题答复或执行续轮触发调度。消息已消费且队列为空的异常回合不会自动重试；空队列不阻止显式恢复或答复后的继续执行。

一个项目同一时刻只有一个活跃代码任务：新任务按 `created_seq` 排队，只有活跃任务走到终态时名额才交给队首。任务也可能永久停住（节点 blocked、问题无人可答，谁都无法推进），因此队列不能只依赖完成来推进：`abandon`（任务页「终止」按钮，或 `POST /api/tasks/:id/abandon`）把任务置为 `abandoned`、以 `{type:abandoned}` 解答它剩下的开放问题，并立即把名额交给队首；任务还有在飞操作时先暂停再终止。排队中的任务在视图里带 `queuedBehind`（占着名额的任务、项目与它的开放问题数），排队不再是无法解释的等待。

## 返工与独立性

- 实现节点和其直接后继默认使用 `result_handoff`。
- Fresh 审查与验证只读取 acceptance、evidence、artifact 和冻结事实，使用 `evidence_only`。
- 独立审查默认排除本轮实现使用过的模型集合。
- Fork 只用于必须继承精确 transcript/tool-call 事实的情况，不用于普通探索。

## 恢复

后台重启或 worker 消失后，Graph 先核查：

- operation 是否已派发；
- 外部动作是否留下可识别结果；
- worker/session 是否仍存在；
- Git、artifact 或命令是否已经产生副作用。

结果明确时补记；确认没有发生且可以重做时才 retry；结果不明时阻塞并生成由 Main Agent 处理的 recovery problem。不能承诺任意外部操作 exactly-once。

## 进度判断

监控执行中的任务时优先用 `get_task_status`：返回紧凑的节点状态（含实际选中并执行的模型）、未决的用户问题与内部问题、以及每条 acceptance 当前有效的证据，体积远小于 `get_graph_state`。带 `nodeId` 时额外返回该节点的 `input`（修订前核对归属与自检命令用）；`waitForNode` + `timeoutMs` 可以阻塞等待该节点 settle，或在出现需要你处理的问题时立即返回，不必自己轮询。

有证据关闭问题、通过此前失败的检查、产生合法 artifact/result handoff 才算进展。重复改写说明、重复启动同一失败动作或跳过检查不算进展。连续多轮无进展应升级给用户。
