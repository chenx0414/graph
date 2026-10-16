# 浏览器 schema 按需加载：默认关闭，固定小集未通过

本实验不改变模型、effort、图分工、权限或生产默认值。`GRAPH_DEFER_BROWSER_TOOLS=1` 仅对已经绑定且允许激活的 Pi 扩展隐藏 agent_browser / agent_browser_web_search 的初始 schema，提供 load_browser_tools 指针；加载后下次请求可用，状态按实例保留，fresh 会话重置。原工具仍走原调用和权限门禁。关闭环境变量恢复全量工具。没有浏览器扩展时不提供虚假 loader。

## 真实执行验证

本机安装的 pi-agent-browser-native 0.6.17 与 /opt/homebrew/bin/agent-browser，真实打开 HTTP 本地页，读回唯一标题并关闭；默认/延迟两行均验证 daemon 重启后仍能调用。只替代外部模型服务，没有用伪造扩展代替浏览器。依赖通过 GRAPH_BROWSER_EXTENSION_SOURCE 指定安装目录；缺失时该环境依赖 E2E 明确跳过，不声称验证浏览器。

最初因临时能力缺少 PATH/命令环境声明失败，补齐 runtime 后通过 `/tmp/graph-browser-loading-runtime.log`。负向控制临时将 activateBrowser 改为空函数，下一请求缺少 agent_browser 而明确失败 `/tmp/graph-browser-loading-negative.log`；恢复原字节后浏览器与 catalog 三项通过 `/tmp/graph-browser-loading-green.log`。

## 固定真实模型命令任务

同一 DeepSeek V4.1 Flash high、同一短提示、初始 settings.json/check.mjs、120 秒期限与公开 CLI 验收，每次独立临时项目与 SQLite；仅 browser flag 不同，其余两 flag 关闭。绑定真实扩展，首请求实际工具 JSON 从 43,588 降至 33,703 字节，少 9,885 字节。工具 schema 字节不是 provider 精确 token，更不是任务费用。顺序 A B B A A B，预存 `/tmp/graph-browser-command-order.json`，汇总 `/tmp/graph-browser-command-summary.json`，单项 `/tmp/graph-browser-command-{样本}.json` 和 `.log`，其中记录所有隔离目录。

| 样本 | 完整成功 | 行为通过 | 超时 | 请求 | 时长 ms | 未缓存输入 | 输出 | 缓存读 | 统一权重估算 USD |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| a1 | True | True | False | 11 | 105145 | 29092 | 7072 | 233216 | 0.018613296 |
| b1 | True | True | False | 9 | 53010 | 13003 | 3148 | 89088 | 0.008213028 |
| b2 | True | True | False | 11 | 65231 | 14943 | 4599 | 137472 | 0.010826532 |
| a2 | True | True | False | 9 | 68946 | 16370 | 2816 | 123008 | 0.009028248 |
| a3 | True | True | False | 10 | 66773 | 17895 | 4185 | 143616 | 0.011252196 |
| b3 | False | True | True | 19 | 120884 | 23129 | 7086 | 262528 | 0.017017068 |

A 3/3 完整成功，B 2/3；B3 文件验收通过但未正常结束。统一情景权重 input .30/output 1.20/cacheRead .006 USD/百万 token（此前核对的供应商 peak 档），不是回填历史账单。A、B 所有真实冻结费用未知；B3 还有未知 usage，故这里只是记录用量的情景比较，不能声称精确成本。

记录用量总情景支出 A .038893740、B .036056628，B 表面低约 7.3%；但将全部尝试计入、除以各自完整成功数，A .012964580、B .018028314，B 约贵 39.1%。不以未完成尝试的少用量冒充任务节省。成功率门槛已未通过，不启用，不扩大该配置。样本不足以证明总体因果差异。

## 轨迹发现与限制

未在工具摘要发现 case.json 或评测源码读取，不把摘要缺失当形式化保密证明。B3 完成配置修复后，按现有 DEFAULT_MAIN_RSI_IDENTITY 记录/发布/promote harness-backlog，研究 artifact schema 并尝试 apply_rsi_change。RSI 以工作区其他未提交变更拒绝；复核 agent-tool-definitions.ts 没有产生差异。main 的自维护开销属于本轮完整成本，不从统计剔除。

这与 worker 单体评测分开；没有模型 planner+worker 树，不推断 whole-tree 分层节省。没有截断输出、删除 reasoning、提示模型少做工作或调低 effort。修改 RSI 工作职责需要另行提案；本实验保留既有规则。

## 门禁与回滚

完整真实浏览器环境门禁 `/tmp/graph-harness-check-browser-defer.log`：269 文件、1,491 测试通过，验收证据不变。随后收紧 activateExtensionTools 前提，`/tmp/graph-harness-check-browser-policy.log`：269 文件、1,491 测试通过，真实浏览器两项已执行，验收证据不变。回滚实验 flag 即恢复初始完整 schema；可单独撤销实现提交。
