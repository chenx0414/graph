# 搜索工具指引匹配实际能力：初步组合信号，默认关闭

GRAPH_MATCH_SEARCH_GUIDANCE=1 只在 common 与 DEFAULT_COMMON_RULES 完全相等时重写内置搜索行；用户自定义 common 原文保留。根据当次 available/enabled 工具列出 fffind、ffind、ffgrep、find、grep、bash 的实际子集，缺少索引工具时不再命令调用它们。该提示词实验默认关闭，移除 flag 恢复原文，不改变工具绑定、权限、模型、effort 或角色。

轨迹依据：前一分类实验 B1 完成项目修复后调查 ffind/ffgrep 缺失；本机正式 pi-fff 能力实际注册 fffind（三个 f），而内置规则写 ffind（两个 f）。实验使用真实绑定事实，未硬编码假工具，也不让 main 忽略真实缺陷。

逐行处置：内置通用规则的“Search ... indexed extension tools (ffind, ffgrep) instead of shell ...” rewrite 为实际可用搜索工具及 fallback；其他通用/角色/RSI/测试约束 keep。自定义规则 keep。没有任何“少花 token”或缩小任务要求。

## E2E 与负向控制

真实 HTTP→模型工具→shell/扩展→SQLite→成本 CLI：默认不变、flag 开启、用户规则保持原文、分类组合均验证 wire 与真实副作用。本机 GRAPH_FFF_EXTENSION_SOURCE 指向已安装 @ff-labs/pi-fff，实际 fffind 找到预置 find-proof.txt，wire 指引含 fffind/ffgrep。缺失扩展时固定清单的依赖行显式 skip，不动态改变测试总数。

`/tmp/graph-matched-search-real-extension.log` 九项通过；临时关闭 prompt 装配后 `/tmp/graph-matched-search-negative.log` 指引断言明确失败，原字节恢复。完整 `/tmp/graph-harness-check-matched-search-stable.log`：268 文件/1,494 测试通过，1 文件/2 浏览器测试跳过；清单 269/1,496，真实 FFF 用例已执行，验收证据不变。

## 真实模型：组合对照

为验证上轮已观察根因，本轮 B 同时开启 MATCH_SEARCH_GUIDANCE 与 CLASSIFY_HARNESS_FRICTION；A 两者关闭。只能解释组合结果，不能独立归因任何单 flag。其余 docs/catalog/browser flags 关闭，同一现有 DeepSeek V4.1 Flash high、相同 command 任务/初始文件/验收、120 秒、独立临时状态，B A A B B A 顺序。指令补充后的 artifact schema 说明两组共同持有。

原始 `/tmp/graph-matched-command-{样本}.json`、`.log`；顺序 `/tmp/graph-matched-command-order.json`，汇总 `/tmp/graph-matched-command-summary.json`，每项记录隔离目录。工具摘要未出现 case.json/评测源码路径，不当作形式化保密证明。

| 样本 | 完整成功 | 行为 | 超时 | 请求 | operation ms | input | output | cacheRead | 统一权重估算 USD |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| b1 | True | True | False | 8 | 38911 | 15619 | 2008 | 87296 | 0.007619076 |
| a1 | True | True | False | 5 | 22860 | 18696 | 1223 | 70016 | 0.007496496 |
| a2 | True | True | False | 9 | 48630 | 11518 | 2868 | 103168 | 0.007516008 |
| b2 | True | True | False | 5 | 49630 | 11179 | 2079 | 48512 | 0.006139572 |
| b3 | True | True | False | 7 | 28986 | 11112 | 1778 | 73216 | 0.005906496 |
| a3 | False | True | True | 17 | 120432 | 34254 | 9419 | 475776 | 0.024433656 |

A 2/3、B 3/3 完整成功。包括失败尝试的全部已记录用量，按 input .30/output 1.20/cacheRead .006 USD/百万 token 同权重情景，每完成任务 A .019723080、B .006555048，低约 66.8%。A3 的 usage 有一项未知，A/B 真实冻结费用皆缺失，因此不是账单，也不是精确节省。两组都发生项目修复，B 没有靠跳过检查通过；check.mjs 字节与 settings.label 保护由外部 CLI 独立验收。

这是探索的首个正信号，不能启用：只有一类任务、每组三次，差异受基线一次超时影响，未知用量、时序/cache 和 main 自维护仍混杂。对三次样本做 bootstrap 无法消除这些限制，不用条件置信区间包装确定收益。两 flag 默认关闭，尚无跨类别固定集、真实使用或完整树成本下降证据。下一步同组合在 CLI 参数类别复验，保留所有失败，不与旧污染评测混算。
