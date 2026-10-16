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

## 第二类：CLI 参数（2026-10-16）

固定输入、验收和独立项目已保存；A B B A A B 顺序，每模型三次，120 秒截止。此轮使用 operation 完成状态与正式 pause+interrupt 取消，运行进程均退出 0。两模型完整成功均为 1/3，未达到上线门槛。保留现有 grade 差异，A 价格仍未知。此轮不证明模型本身因果优势或整棵树降本。

| 样本 | 完整成功 | operation | 请求 | 时长 ms |
| --- | --- | --- | ---: | ---: |
| a1 | True | succeeded | 13 | 105978 |
| b1 | False | interrupted | 16 | 120454 |
| b2 | False | interrupted | 25 | 120358 |
| a2 | False | interrupted | 21 | 120030 |
| a3 | False | interrupted | 22 | 120537 |
| b3 | True | succeeded | 7 | 78423 |

原始汇总 `/tmp/graph-model-cli-summary.json`，顺序 `/tmp/graph-model-cli-order.json`，单项 `/tmp/graph-model-cli-{样本}.json` 与 `.log`。成功必须同时满足默认输出不变、--count 3 三行、非法数值/负值/小数/缺值非零退出并报错，以及 operation succeeded。失败不被零价格掩盖。

## 评测收尾修复

真实 CLI→HTTP→受控外部供应商→SQLite E2E 将迟到请求缩成 5 秒。最初明确失败于 database is not open；暂停属于软停止，不取消当前模型请求；增加立即中断后局部通过，但完整门禁在 Node 24 再现。等待账本 cost 非空仍不足：SDK 会在自定义 fetch 返回之前报告 abort，导致 evidence 尚未建立，turn 提前结束。受控传输现等待已开始的 fetch，再等待 usage evidence，然后才能发出终态。未吞掉费用证据、未把未知用量填零。新增正常完成与超时取消两条真实 CLI E2E，后者保留 interrupted 与 timedOut，不冒充成功。

可复现命令：`node_modules/.bin/node node_modules/vitest/vitest.mjs run tests/e2e/harness-eval-lifecycle.test.ts`。修复前日志 `/tmp/graph-eval-lifecycle-red.log`，中间不充分修复的完整门禁 `/tmp/graph-harness-check-eval-drain.log`，传输修复后局部 `/tmp/graph-eval-lifecycle-join.log` 两项通过。该中间修复完整门禁仍失败；检查失败账本发现 pause 发生于 live session 注册前，interrupt 返回 no_active_operation，评测器异常退出并关闭数据库。现只对该明确拒绝作有界重试，等待真实 session 就绪再取消。最终完整门禁 `/tmp/graph-harness-check-cancel-registration.log`：268 文件、1,487 测试通过，验收证据不变。

## 持久状态与命令任务试跑

使用已保存用例、Node 24、每模型每类一次，尚未完成三次重复；顺序见 `/tmp/graph-model-next-pilots-order.json`。

| 类别 | 模型 | 完整成功 | operation | 请求 | 时长 ms |
| --- | --- | --- | --- | ---: | ---: |
| persistence | a1 | False | interrupted | 11 | 120682 |
| persistence | b1 | False | interrupted | 14 | 120722 |
| command | a1 | True | succeeded | 11 | 70407 |
| command | b1 | True | succeeded | 6 | 44599 |

持久状态两者均超时，不通过；命令任务两者均通过且检查程序字节未改。LongCat 命令样本费用 USD 0，DeepSeek 冻结价格缺失保持未知。单样本不支持置信区间或整棵树收益。原始 `/tmp/graph-model-{类别}-{样本}.json`、`.log`，每份 JSON 记录隔离目录。graph、artifact、续跑、独立审查和完整树成本仍未验证。
