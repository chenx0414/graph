# ADR 0018：执行问题先由 Main Agent 处理

日期：2026-09-18

## 状态

已接受。

## 背景

运行内核会为恢复不明确、适配器错误、上下文拒绝、Git 冲突、用量未知、返工和停滞等情况创建问题。过去这些问题与权限、预算问题一样直接出现在用户收件箱，甚至把异常文本和 JSON 解析错误原样展示给用户。多数问题需要主 Agent 调查、重试或调整任务图，用户既无法理解，也无法直接解决。

## 决策

- 问题记录增加 `owner`，取值为 `user` 或 `main`。
- `permission`、`budget`、`reservation_exceeded`、`human_check`，以及明确请求配置模型的 `waiting/model_access` 直接归用户所有。
- 其他执行问题默认归 main Agent。问题创建后，对应主 Agent 节点会被唤醒；功能任务节点继续保持阻塞，直到问题被解决。
- 问题发生在主 Agent 节点自身时不能自我唤醒，否则会立刻重复同一失败。此类问题保持 `owner=main` 并进入停驻状态：节点可被显式 `resolve_problem` 或恢复路径重试，但调度循环不会自动再次执行它，也不进入用户收件箱。当配置或环境变化时，`recoverMasters` 清除停驻问题并重试；若问题需要用户决策，则仍按用户问题处理。
- main Agent 通过 `list_problems` 查看结构化问题，通过 `resolve_problem` 执行 `retry`、`respond`、`acknowledge` 或 `reconcile_usage`。需要改变图时先调用 `revise_graph`。
- main Agent 可以继续在正常对话中向用户提问真正的决策，但不应把原始异常、堆栈、内部 JSON 或无法操作的错误直接当作问题转发。
- 用户收件箱、任务状态和会话问题卡片只展示 `owner=user` 的问题；main Agent 的对话摘要仍能看到全部问题。
- 没有 conversation/master 可接管的历史或脚本任务保持兼容，问题归用户所有。

## 后果

用户面对的是经过主 Agent 调查后的权限、预算、人工验收或明确决策；恢复、适配器、上下文、Git、用量和返工问题先回到主 Agent。内部问题如果不解决，功能任务仍保持阻塞，不能绕过验收或额度规则。问题所有权和解决动作均进入数据库与事件记录，便于审计。
