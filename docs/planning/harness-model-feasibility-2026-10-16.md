# 模型分层：已批准隔离评测的首轮结果

使用者于 2026-10-16 以“批准模型分层提案”授权隔离评测，范围见 [提案](harness-model-mix-proposal-2026-10-16.md)。生产 main、模型和路由均未改变。

结论：首轮可行性不足以批准上线。LongCat 的文件行为 3/3 通过，但完整 operation 仅 2/3 正常结束；DeepSeek 1/3 正常结束并通过，另两次超时且行为失败。两模型的异常样本都在关闭评测 daemon 时出现迟到回调访问已关闭数据库，需先修复评测收尾，不能把本轮当作无混杂的模型质量比较。

## 冻结条件与顺序

相同 runner `scripts/harness-real-eval.mjs`、相同初始 config.js、用户原话“修一下 config.js，空白行别当成配置，保留值里的等号。”、相同 120 秒截止、独立临时项目/配置/SQLite、两项优化 flag 均为 0。预先保存顺序 B A A B B A；A 为当前 DeepSeek V4.1 Flash，B 为已配置 LongCat 2.5 Preview Free。未删除失败或替换样本。

保留原有 grade：A high、B medium；并非控制 effort 的实验，也不能将差异归因于模型本身。没有在同一会话切换模型。首轮仅 parser 可行性，不代表八类别固定集或 planner+worker 整棵树。

公开行为验收通过真实 Node CLI 执行：值内等号保留、空行无额外键；补充验证正常两键输入与空输入，所有截止时行为通过的样本也通过补充检查。

| 顺序 | 样本 | 截止时行为 | operation | 时长 ms | 请求 | 未缓存输入 | 输出 | 缓存读 | usage 未知 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | b1 | 通过 | succeeded | 64781 | 6 | 23219 | 1974 | 45184 | 0 |
| 2 | a1 | 通过 | succeeded | 110917 | 15 | 16866 | 6996 | 190336 | 1 |
| 3 | a2 | 失败 | dispatched | 120438 | 22 | 37409 | 6641 | 511488 | 1 |
| 4 | b2 | 通过 | succeeded | 41296 | 9 | 26159 | 3541 | 89344 | 0 |
| 5 | b3 | 通过 | dispatched | 120383 | 5 | 23760 | 4280 | 23680 | 1 |
| 6 | a3 | 失败 | dispatched | 120319 | 10 | 33732 | 8262 | 146944 | 1 |

超时行的时长为截止前观察时长，并非已完成 operation 时长；dispatched 是关闭后记录的状态，不能算完成。截止后可能发生的工作不纳入成功判定。a2、b3、a3 保留完整 stderr，明确记录评测器 shutdown race；不把关闭后的零成本或少请求解释为收益。

## 成本边界

2026-10-16 重新读取 [OpenCode Go 官方页](https://dev.opencode.ai/v2/docs/console/go/)，LongCat 2.5 Preview Free 仍是限时免费。b1、b2 冻结价格的已结算 worker 费用各为 USD 0；b3 有一条 usage/cost 未知，任务费用保持未知。A 的当前配置无冻结价格，47 条请求成本均未知，不用当前网页价格伪造历史账单。所有 cacheWrite 记录为 0 不等于证明供应商没有写缓存。

本轮没有 main 计划、worker 交接和父级核验的真实分层树，无法报告 whole-tree 节省或成本下降置信区间。main 对话 phase 仍是 chatting；以 operation+sandbox 行为衡量本次修复完成，不能把 CLI 的 completedTasks=0 改写为 completed graph。

下一步先修复 runner 超时后取消和 drain，再冻结生命周期契约；保留本轮结果，另建一轮记录。随后按已批准范围继续其他固定类别。尚未授权或实施 planner+worker 分工原型及生产路由变更。

## 原始证据

汇总 `/tmp/graph-model-feasibility-summary.json`；预注册顺序 `/tmp/graph-model-feasibility-order.json`。每项 `/tmp/graph-model-feasibility-{样本}.json` 与 `.log`；对应隔离目录如下（含 config.js、SQLite、cost-report.json）。私有配置副本包含 credential refs，不在报告复制凭据值。

- b1: `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-CpaxXH`
- a1: `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-GT8d81`
- a2: `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-YlsutY`
- b2: `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-lAGcdH`
- b3: `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-qAjEvs`
- a3: `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-1hV16d`

相关工程验证：成本来源与 429 计数修正提交 `d86cd99`，完整门禁 `/tmp/graph-harness-check-retry.log`：267 文件、1,485 测试通过，验收证据未变化。
