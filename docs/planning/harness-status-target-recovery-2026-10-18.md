# 状态查询目标字段的错误恢复

## 真实触发与因果边界

[Reviewer 身份对照](harness-reviewer-identity-comparison-result-2026-10-18.md)的 parser B 在 `1792301210009` 附近调用 `get_task_status({graphId,waitForNode:"coder",timeoutMs:150000})`。该工具支持 `taskId`，但适配层忽略额外的graphId字段，将没有目标的查询发给默认main会话，最终报“Task … has no node coder”。下一轮模型自行改用taskId才恢复。

这是字段忽略造成的误导错误，不是节点尚未创建或graph归属解析失败。源码适配层没有转交graphId；实际错误指向owner ID，而正确taskId调用随后可等到coder结束。现有完整交付E2E重放同一形状，修复前同样报主会话没有work节点，缺少可恢复调用；从错误恢复的受控外部模型无法推进交付。

离线规划时间审计同时发现：A首main operation为100413ms，B为271937ms；其工具执行累计分别约2487ms、4644ms（并行工具区间不能作为独占时间简单相减）。B进行了额外源码/评测脚本探索和临时parser验证。字段误查发生在第二operation，不能拿它解释前面约172秒的规划差异，也不能把全部差异算作本修复的预期节省。sha256sum缺失在A/B reviewer各发生一次，仍未修复；本轮不为了单个命令新增常驻工具或系统指令。

## 修复与回滚

`src/runtime/agent-tools.ts` 对get_task_status实际带有graphId键的调用返回invalid_input，指出该工具使用taskId，并返回可直接重试的JSON参数。提示优先保留明确的taskId，否则使用有效graphId字符串；保留nodeId、waitForNode和timeoutMs。错误发生在查询前，避免查询默认owner后误报节点不存在。

不把graphId接纳为新别名，不自动派发纠正查询，不改变正常taskId/缺省目标调用、会话归属校验或等待行为。若两字段同时存在，仍要求调用方移除graphId；提示保留其明确taskId。系统prompt disposition：无改动；schema/description、模型、effort、路由、分工与实验默认值均无改动。新增文字仅在这一错误发生时返回，不能当成正常请求静态前缀节省。

回滚只还原该适配层的错误分支，不涉及数据库、模型配置或历史结果。潜在收益是减少发现参数名的探索，尚无真实模型请求数、费用或成功率改善证据，不宣称总体优化目标已经完成。

## 验证

按test-audit扩展已有 `tests/e2e/harness-workflow.test.ts` 的frozen-explicit行，不增加新测试层、测试专用生产接口或单元/集成测试。通过真实CLI、Pi、工具、SQLite、worktree、宿主检查、独立review artifact与目标交付；只有外部供应商由受控本地服务替代。

该行先传错误graphId，从真实错误文本提取get_task_status修正参数并再次调用，核对正式graph的work节点已succeeded且reason=settled，然后完成原验收、精确commit独立审查和目标交付。其他bare/frozen-auto行继续使用原taskId路径，仍保留原模型角色与计量断言。

红灯：`VITEST_MAX_WORKERS=4 npm_config_offline=true node --run test -- tests/e2e/harness-workflow.test.ts -t 'context=frozen-explicit'`，39.63秒，1失败/4跳过；日志 `/tmp/graph-status-target-red.log` 含原始“has no node work”及缺失恢复标记，完整交付失败。首次尝试用npx被本地npm devEngines版本校验阻止，未执行测试；该环境错误不冒充回归红灯。

修复后同文件5项全部通过，52.83秒，日志 `/tmp/graph-status-target-green.log`。没有重新启动已停止的真实模型workflow或额外付费调用。

完整门禁 `node --run check` 通过：272文件、1514测试，350.01秒；baseline匹配、验收证据不变。日志 `/tmp/graph-status-target-check.log`。静态自审：修正参数由JSON.stringify生成，仅选择该工具已有字段，错误路径不调用supervisor；正常路径及所有权验证保持，未发现新增权限入口。无临时日志。
