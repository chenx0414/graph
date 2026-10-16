# Harness 摩擦分类提示词实验：未通过，默认关闭

动机：已观察到 main 在正常项目检查失败后扩展到 Graph 维护。实验只澄清项目失败与 Graph 缺陷的分类，保留同一 main 的维护职责、工具、权限、模型、effort 和任务分工。GRAPH_CLASSIFY_HARNESS_FRICTION=1 默认关闭，恢复环境变量为 0 或移除即恢复原文。

## 逐行 prompt 差异

| 原文 | 处置与理由 |
| --- | --- |
| the moment you notice friction - a defect ... an error the user had to point out - record it | rewrite：when evidence identifies friction in Graph itself，列出 Graph 工具、harness prompt、harness path。避免把请求中预期的项目失败自动当 Graph backlog |
| executor and improver ... same Agent、修复真实缺陷、report backlog、receipt/reload 与检查要求 | keep，保持所有职责与保护 |
| 新分类说明 | add：项目检查失败/缺配置/业务缺陷属于当前项目；同时显示 Graph 指令、工具或执行缺陷时才成为 harness 项。继续按原验收修项目 |

没有要求模型节约 token、少做工作或忽略真缺陷。参数说明修正已在两组共同基线上，单独比较分类开关。该说明稍增长静态 prompt，若有效只能通过减少错误返工获益，不能靠字符变少获益。

## 证据与结果

真实 HTTP→shell→SQLite→CLI E2E 验证实际 wire 包含开关文案且身份保持；负向控制移除装配后明确失败 `/tmp/graph-classified-friction-negative.log`。恢复后六项通过 `/tmp/graph-classified-friction-e2e.log`。这些受控供应商证据只证明装配和业务流程，不证明模型理解。

真实固定 command 任务，同模型 DeepSeek V4.1 Flash high、同初始文件/原话/验收、120 秒截止，其余 flag 关闭、无浏览器扩展；独立新会话，B A A B B A。顺序 `/tmp/graph-classified-command-order.json`，汇总 `/tmp/graph-classified-command-summary.json`，单项 `/tmp/graph-classified-command-{样本}.json` 和 `.log`。

| 样本 | 完整成功 | 行为通过 | 超时 | operation | ms | 请求 | input | output | cacheRead | 情景估算 USD |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| b1 | False | True | True | interrupted | 120318 | 10 | 32353 | 9554 | 174720 | 0.022219020 |
| a1 | True | True | False | succeeded | 31926 | 5 | 10325 | 1087 | 47360 | 0.004686060 |
| a2 | True | True | False | succeeded | 49150 | 7 | 11760 | 3214 | 74240 | 0.007830240 |
| b2 | False | True | True | succeeded | 120042 | 9 | 25692 | 5813 | 168192 | 0.015692352 |
| b3 | True | True | False | succeeded | 51379 | 9 | 21011 | 3102 | 154112 | 0.010950372 |
| a3 | True | True | False | succeeded | 53679 | 6 | 18704 | 2157 | 91520 | 0.008748720 |

A 3/3、B 1/3 在期限内完整成功。B2 operation 在 120.042 秒结算成功，跨越 120 秒截止，仍保留 timeout，不将边界样本重新标为通过。样本很小，不推断统计显著因果差异；已不满足预定质量门槛，不启用、不扩大。input .30/output 1.20/cacheRead .006 USD/百万 token 仅为同权重情景，真实冻结价格缺失且部分 usage 未知，不能当账单。

B1 文件行为通过后调查 ffind/ffgrep 缺失。DEFAULT_COMMON_RULES 无条件要求使用这两个索引工具，隔离项目没有绑定它们；这是可观察到的真实指令/工具不匹配，不应以节约成本为由要求 main 忽略。该分类实验没有解决这个根因。下一项可测修正应让默认搜索指引匹配实际绑定能力，并保留用户自定义规则；不修改模型角色或工作拆分。

完整 `VITEST_MAX_WORKERS=4 node --run check` `/tmp/graph-harness-check-classified-friction.log`：268 文件/1,490 测试通过，1 文件/2 项浏览器环境依赖测试跳过；总清单 269/1,492，验收证据未变化。
