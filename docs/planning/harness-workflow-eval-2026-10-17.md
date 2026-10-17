# 正式提案确认流程评测：执行基础已验证，真实规划尚未完成

GRAPH_EVAL_CONFIRM_WORKFLOW=1 只影响独立评测脚本。启动后经正式 catalog.saveAgentCombination 发布受控 coder 配方（相同既有模型 grade、明确 worker prompt），经 projects.prepare 建立临时项目基线，再让真实 main 从原用户短请求开始。未复制完整生产资源库，故此环境是明确的受控基础流程，不称作生产镜像。

main 生成当前有效 draft、回合静止后，评测器使用 conversations.confirm 和真实 proposalVersion/draftRevision/targetBranch 确认，随后发送已确认 graph ID 的继续消息。确认建立结构不等于开始工作：graph_send 和工作执行仍属于 main。没有伪造工作回执或跳过持久化。每轮独立 SQLite 只有该主会话及其图，成本报告汇总全部实际调用；workflow.taskIds 明确保留主会话/图归属。

成功条件更严格：graph phase=completed、main 回合已静止且目标项目通过外部行为验收。只完成提案、确认或 worktree 局部修改不计成功。合法用户问题标 awaitingInput，不当作完成；截止时停止私有图和 main，并等活动/结算收尾。异常报告也保留 owner task ID，清理失败明确报告并退出失败，不在写者未停止时关闭数据库。此脚本不能把尚未执行的独立审查、验收或交付门禁当通过。

## E2E

新真实 CLI→daemon→外部模型工具调用→正式提案→Git 基线→用户确认→持久图 E2E。外部模型先查询真实组合库，再提交 coder@1 draft；确认后不发送工作，断言仍 completed=false、taskSuccess=false，主会话与确认图 ID 不同。该主断言保护“确认不等于完成”，并不声称 worker 交付端到端已证明。现有独立 worker/sandbox E2E 保持。

修复前 `/tmp/graph-eval-workflow-red.log` 缺少流程状态而失败；补实现时 catalog 正式拒绝空 worker prompt，随后补完整受控配方；`/tmp/graph-eval-workflow-detail.log` 通过。完整 `/tmp/graph-harness-check-workflow-confirm.log`：270 文件/1,499 测试通过、验收证据不变；异常 owner 归属补齐后的 `/tmp/graph-harness-check-workflow-cleanup.log`：270 文件/1,499 测试全部通过，真实浏览器与 FFF 环境依赖已执行，验收证据未变化。

## 真实模型基础试跑

固定既有 DeepSeek V4.1 Flash high，180 秒期限，其余所有实验 flag 关闭，parser 原短请求与验收不变。原始 `/tmp/graph-workflow-parser-pilot.json`、`.log`，JSON 记录独立目录。23 次请求，记录 input=59,933、output=19,456、cacheRead=694,912，全部 23 次费用未知。

coder 可成功读取，但 proposalSeen=false、未确认图、超时、行为验收失败。轨迹主要阅读 workspace/integration/模块实现，最后在 /tmp 写 proposal.json 并只验证 JSON 语法，没有调用正式 propose_graph。因而没有 worker 模型调用、review 或交付，不是完整任务成本对照。不能报告更省钱，不能把 180 秒超时解释为正常等待用户确认。

结论：原先缺 worker 配方的混杂已有可执行修复，但真实规划瓶颈仍在；下一步不能继续只按 schema 字节优化。应评估明确的原生 graph 定义示例是否足够减少源码调查，或单独提案更强 planner；模型选择、effort 与生产分工仍不自动改变。

## 正式投递和 worker 成本归属补充

扩展同一真实 CLI E2E 为两行：确认后不投递；确认后由 main 的正式 graph_send 投递。供应商使用当前真实确认消息里的 graph ID，不伪造图或回执。投递行确实启动原生 worker，cost-report 中主会话请求与图的 provider requests/executions 都大于零，并由汇总 CLI 将全部独立状态库调用计入分子。两行仍都 taskSuccess=false，因为没有独立验收/集成/交付；未把 worker 出现当完成。

局部 `/tmp/graph-workflow-worker-dispatch.log` 两项通过；完整 `/tmp/graph-harness-check-publish-and-dispatch.log`：270 文件、1,501 测试全部通过，真实浏览器与 FFF 依赖均执行，验收证据未变化。这补齐前置生命周期，不代表 Step 5 候选已获批或已运行。
