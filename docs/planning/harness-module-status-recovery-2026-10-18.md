# 模块状态误查的错误恢复

## 实际触发与范围

[360 秒分层会话](harness-model-tiering-v2-result-2026-10-18.md)完成正式 graph 后，main 用 `get_task_status` 的 nodeId 和 waitForNode 两种参数查询宿主 `check` 模块，均收到 `Task … has no node check`。随后继续源码探索并尝试 RSI 文档修补，最后 main 超时。模块操作本来已通过，可由 `graph_inspect` 的 operations 查询；它不是 Agent 节点，不应把节点状态查询改成模块等待器或自动把错误当成功。

从原始 SQLite 事件读取：首次 main dispatched 到 graph.completed 为 286779 ms；graph 完成到 main interrupted 为 73919 ms。后段有 11 条 provider.request_profile、16 次工具调用，其中 3 次错误（两次模块误查、一次 RSI 检查命令无效）。这些是时间线与调用计数，不是独占耗时或费用归因。详表 `/tmp/graph-v2-post-completion-audit.json`。不能将后段全部成本归因于模块误查。

## 修复

`src/core/task-runtime.ts` 在节点选择/等待两条路径识别当前正式 revision 中的模块，保留 not_found 拒绝，并返回精确可调用的恢复入口。operation 模块指向 `graph_inspect({graphId,query:"operations"})`，其他模块指向 `graph_inspect({graphId,query:"module",id})`。模块识别仅接受定义自身拥有的键，不存在的对象仍保留原错误（包括 toString 等原型属性名）。校验归属先于状态查询，不绕过会话或 graph 所有权检查；不自动发起操作，不扩展权限，不假装已经等待成功。

系统 prompt、工具 schema/description、生产模型、effort、路由、分工、完成定义及所有实验默认值均保持。本轮 system prompt disposition：无改动。仅实际发生该错误时会增加恢复文字，不向正常每次请求加入新指令。

这是原目标允许直接修复的重复工具错误，而非模型策略实验。潜在收益是避免模型重新搜索查询接口和修补文档；当前没有可归因的价格加权收益估计，不把增加的错误文字忽略为零，也不把一次受控恢复推广为真实模型质量等效。

## 验证

遵循 test-audit，扩展已有完整交付 owner `tests/e2e/harness-workflow.test.ts` 的 frozen-explicit 行，不新增重复测试层或生产注入接口。真实 Pi→工具→SQLite→宿主命令、Git worktree、代码 artifact、独立审查、目标行为和整树计量继续执行，仅外部供应商由本地受控服务代替。

该行重放两种真实错误参数，从实际错误文本提取 graph_inspect 参数并发出查询，核对真实宿主 workspace.command 操作记录，然后完成原有独立审查与正式交付。查询可能观察到 prepared/dispatched 状态，最终通过与否由原本的完整 runner 终态核验，不把异步首次查询当完成、不增加固定延时。

修复前 `node --run test -- --run tests/e2e/harness-workflow.test.ts -t 'context=frozen-explicit'` 在 9.26 秒明确失败：错误只有 has no node check，缺少模块识别与恢复参数；日志 `/tmp/graph-module-status-red.log`。修复后同一路径 1 项通过、7.95 秒，日志 `/tmp/graph-module-status-focused.log`。首轮完整门禁 272 文件/1,514 测试通过、350.13 秒，baseline 与验收证据不变。随后复核新提示逻辑，扩展同一 owner 行查询不存在的 toString：`/tmp/graph-module-status-unknown-red.log` 明确发现误认模块；修为仅接受模块定义自有键。最终定向 `/tmp/graph-module-status-final-focused.log`：1 项通过、9.05 秒。最终完整 `/tmp/graph-module-status-final-check.log`：272 文件/1,514 测试通过、352.33 秒，baseline 匹配，验收证据不变。首轮门禁不冒充最终版本证据。

没有重新调用真实模型，没有重开已触发停止条件的对照。回滚仅还原该错误辅助函数及两处调用，不影响已有数据、模型配置或 graph 的正式行为。真实模型是否减少请求、任务是否成功、整树每完成任务成本是否下降仍需后续获批验证。
