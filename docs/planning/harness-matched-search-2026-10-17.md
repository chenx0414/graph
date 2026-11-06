> 状态（2026-11-07）：`@ff-labs/pi-fff` 已卸载，实验依赖的 `GRAPH_FFF_EXTENSION_SOURCE` 已删除；本文只作历史记录，内置搜索行现在指向 shell 的 `rg`。

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

## CLI 复验提前停止与验收改进

2026-10-17 CLI 类别原定 A B B A A B。已完成 a1、b1、b2 和在途 a2；发现 b1 通过 read/grep 读取公开的 harness-real-eval.mjs 与 harness-eval-cases.mjs，并生成 /tmp/eval-verify-cli.mjs。a1 与 b1 均超时；b1 旧固定行为验收通过不作为独立质量证据。观察该证据后停止后续调度，在途 a2 允许结束，未重启或覆盖任何样本。b3/a3 未运行，不伪装成完整固定集。汇总 `/tmp/graph-matched-cli-stopped-summary.json`，原始 `/tmp/graph-matched-cli-{样本}.json` 与 `.log`。

main 按产品设计可以读取 Graph 源码，单纯延迟 case.json 无法保证验收实现保密。因此本轮 CLI 复验不用于启用判断；前一 command 初步信号仍是待复验，不升级为结论。

后续验证不依赖隐藏公开契约：CLI 默认输出、合法正整数次数、非法参数退出仍是原目标，但合法次数在模型结束后由验收进程生成，包含原 3 加六个新的不同正整数（1..100）。模型不能预知这些输入；成功报告 verificationEvidence 保存实际次数以复现；当前失败报告仍仅保留行为失败，未保存失败时生成的全部次数，这是后续诊断缺口。实现细节公开不等于数据提前给出；父进程在发送模型前加载验收字符串，模型结束后才运行独立 Node 验收，模型自己写出的“验证通过”不会充当回执。该机制仍不声称约束拥有完全主机权限的恶意 Agent，测试隔离边界应由正式工作副本/沙箱 E2E 证明。

新增真实 CLI E2E：外部供应商工具确实写入 greet.mjs，普通通用实现通过；只对旧固定次数 3 输出正确的实现拒绝。负向控制临时去掉新次数生成，旧固定案例错误地通过，`/tmp/graph-eval-unseen-negative.log` 断言明确失败；恢复生成后完整门禁 `/tmp/graph-harness-check-unseen-verification.log`：269 文件、1,498 测试全部通过，真实浏览器与 FFF 依赖测试均已执行，验收证据未变化。此改进不改变生产 prompt、模型、effort 或路由，不用旧污染样本补新一轮样本。

## 失败输入诊断与最小环境限制

后续补齐失败路径：生成次数在验收前输出，父进程在 execFile 异常中保留 stdout。字段名使用 generatedCounts，不把失败输入称作已验证通过。现有真实 CLI E2E 先扩展到要求失败报告含输入，旧实现明确报 undefined JSON，`/tmp/graph-eval-failed-inputs-red.log`；修复后六项通过 `/tmp/graph-eval-failed-inputs-green.log`。完整 `/tmp/graph-harness-check-failure-inputs.log`：269 文件、1,498 测试全通过，浏览器与 FFF 依赖均执行，验收证据不变。

新增独立两次试跑 B1/A1（不是每组三次完整固定集），预注册 `/tmp/graph-unseen-cli-order.json`，原始 `/tmp/graph-unseen-cli-{b1,a1}.json`、`.log`，汇总 `/tmp/graph-unseen-cli-summary.json`：B1 14 请求、A1 10 请求，均 timeout 且行为验收失败；两者均无 proposal.* 事件，不把未完成修复假说成正常等待确认。B1 生成 [3,31,62,73,43,50,2]，A1 [3,26,59,35,44,97,41]；两份失败报告均保存，不能再把缺失诊断当通过。

检查临时 graph/agent-combinations.json 发现只包含 main、resources=[]。实际安装配置具有 coder、reviewer 等 worker 配方和资源，不能假定临时最小环境等于生产完整能力。此前多个 main 样本调查 recipe/协议，环境差异是混杂因素；所有 main 隔离成本结果只能支持最小环境探索，不证明生产安装或完整 main→worker→交付流程收益。原生 worker 对照使用显式发布配方和独立 worktree，属于另一已明确记录的单体可行性结果，不受此 main 配方缺失结论替代。

后续先建立受控 worker 配方与正式提案/确认/投递流程，再测完整任务成本；合法等待确认应单独标记，不计作普通执行失败，也不能当作完成。不能继续用单个 main operation 的状态冒充整棵任务树成本。所有实验仍默认关闭，前一 command 初步正信号不升级为启用决定。

## 汇总工具后的严格口径

可复现 CLI 重算见 [评测汇总](harness-evaluation-summary-2026-10-17.md)。基线 A 的未知 usage 导致严格每完成任务费用和情景成本均为 null；B 的用量完整但冻结价格未知，精确费用也 null。此前约 66.8% 仅为记录 token 的探索比较，不是完整成本或启用证据。
