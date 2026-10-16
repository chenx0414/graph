# 模型分层：已批准隔离评测的首轮结果

> 证据更正：下述 runner 使用 main 对话而非 Graph 原生 worker。CLI、持久状态和命令轮次曾将验收代码 case.json 放在模型可读目录；至少四项轨迹明确读取。以下数据保留为探索和缺陷发现证据，不能作为独立 worker 质量或模型分层收益结论。

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

## 验收代码暴露与角色纠正

审计 `/tmp/graph-model-verifier-exposure-audit.json`：cli b1、cli a2、persistence b1、persistence a1 的工具轨迹明确包含 case.json。cli b1 还将其中 verify 写成 /tmp/greet-verify.mjs 执行；不是假想风险。其他摘要没有记录读取不等于证明未暴露。整个第二类及后续试跑不用于独立质量比较，不只剔除失败样本。第一类 parser 当时没有 case.json，但仍走 main 对话，不能作为原生 worker 对照。

工具审计 `/tmp/graph-model-trace-tool-audit.json` 显示多个超时样本调查配方、graph 协议和 Graph 源码，部分尝试 validate_proposal；这混入 main 的编排职责，不能据此归因 worker 编码能力。此前 worker 可行性措辞予以撤回。没有据此改变生产默认值。

修正：case.json 仅在 daemon 关闭后保存，cleanupIncomplete 时不保存。现有真实 CLI E2E 的修复命令先检查 ../case.json 不存在再编辑；修复前 `/tmp/graph-eval-leak-red.log` 明确行为失败，修复后 `/tmp/graph-eval-leak-green.log` 两项通过。完整 `/tmp/graph-harness-check-verifier-visibility.log`：268 文件、1,487 测试通过，证据不变。

此修复只解决显式验收文件过早发布；main 完全访问仍能读取仓库中的评测源码，不能宣称隔离安全。后续必须使用正式 Graph worker 配方、独立工作副本和工作区沙箱，并以外部行为验收；main 编排任务作为另一个评测类别。不能通过给 main 去掉产品职责来冒充 worker，也不改变生产路由或 effort。

## 正式 Graph worker 小集：候选未通过（2026-10-16）

新增 `scripts/harness-worker-eval.mjs` 使用标准访问策略、正式提案/接受、输入投递、执行查询、独立 worktree 和原生 worker 配方。父侧仅作固定编排，不运行模型 planner；这仍不等于整棵树对照。验收代码仅在关闭后保存。真实 E2E 证明 worker 读取工作区外的独立标记被拒绝且没有返回标记；从真实工作副本运行 CLI 验收。

固定 parser 输入、CLI 验收、120 秒截止、两 flag 关闭，B A A B B A 顺序，每模型三次。grade 保留 A high / B medium，比较配置组合，不能归因纯模型效应。顺序 `/tmp/graph-native-parser-order.json`，汇总 `/tmp/graph-native-parser-summary.json`，单项 `/tmp/graph-native-parser-{样本}.json` 和 `.log`，每项记录 worktree 与原始 SQLite。

| 样本 | 完整成功 | 行为通过 | 超时 | 执行状态 | 时长 ms | 请求 | 未缓存输入 | 输出 | 缓存读 | 费用未知调用 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| b1 | True | True | False | completed | 108865 | 9 | 11788 | 2977 | 39168 | 0 |
| a1 | True | True | False | completed | 67148 | 14 | 10441 | 3094 | 88704 | 14 |
| a2 | True | True | False | completed | 73708 | 12 | 10546 | 3878 | 76544 | 12 |
| b2 | False | False | True | failed | 120097 | 6 | 12164 | 3744 | 17024 | 1 |
| b3 | False | True | True | failed | 120097 | 8 | 12322 | 3515 | 29696 | 1 |
| a3 | True | True | False | completed | 46025 | 11 | 6874 | 2796 | 63744 | 11 |

DeepSeek 3/3 完整通过，LongCat 1/3；候选两次超时，其中一次行为已通过但执行仍未结束，不计完整成功。按预先门槛停止扩大该候选，不做 planner+worker 原型，不启用路由。样本小，不能声称统计显著的模型因果质量差异，但已经没有通过当前可行性门槛。免费供应商价格不抵消失败与返工；不报告节省百分比或收益置信区间。价格未知的 A 调用仍保持未知。

新 worker 超时 E2E 原先 1 秒截止在全套负载下于启动阶段耗尽，未实际请求供应商；保留已发送断言，将专用测试截止设为 10 秒、外部供应商延迟 20 秒，真实模型仍 120 秒。`/tmp/graph-harness-check-native-worker-deadline.log` 中四条新生命周期 E2E 通过；整套仅现有 decision snapshots 测试 15 秒超时。真实模型结束后的默认并发检查 `/tmp/graph-harness-check-native-worker-quiet.log` 再现 main 取消竞态及既有 decision snapshot 超时。使用 Vitest 正式支持的 VITEST_MAX_WORKERS=4 运行 node --run check，`/tmp/graph-harness-check-native-worker-bounded.log`：268 文件、1,489 测试全部通过，验收证据未变化，未改动既有 decision snapshot 断言或超时。main 取消在高负载下的残余窗口仍单独处理，不把这次通过解释为该窗口已消失。
