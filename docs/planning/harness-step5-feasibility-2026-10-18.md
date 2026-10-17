# Step 5 planner 隔离可行性结果（2026-10-18）

结论：获批范围内执行了 parser A/B 两个新会话；两组都没有正式 proposal 或 worker dispatch，因此按基础阶段停止规则不运行余下 CLI B/A，不补跑、不扩样、不启用生产。Step 5 确实直接修好并提交了私有 parser 项目，独立行为检查通过；不能把这个结果说成“编码失败”，也不能把未发生的固定 worker、独立 review、正式验收与交付算成已完成。完整任务成本仍未证明降低。

授权见 [已批准提案](harness-stronger-planner-proposal-2026-10-17.md)。测试准备与完整交付 E2E 见 [流程评测](harness-workflow-eval-2026-10-17.md)。本轮代码/测试准备提交为 91ca9dd。

## 冻结范围和真实结果

原 parser 短请求、输入文件、独立检查未改；两会话各 180 秒，所有上下文实验 flag 关闭。worker 固定 opencode-go:deepseek-v4.1-flash，reviewer 固定 opencode-go:step-5-preview；真实保存的配方是 coder@2 / reviewer@2，确认前验证精确模型与 coder worktree。A 首选 DeepSeek high 目录等级，B 首选 Step 5 medium 目录等级。grade 是目录/配方等级，不能把它等同实际 reasoning effort；本轮未显式设置 thinking level，沿现有 runtime 默认。没有中途换 main 模型。

| 指标 | A：DeepSeek planner | B：Step 5 planner |
| --- | ---: | ---: |
| 正式 workflow 完成 | 0/1 | 0/1 |
| 独立 parser 行为检查 | 未通过 | 通过 |
| 草案 / 确认图 / 原生 worker | 均无 | 均无 |
| 全部 API 请求 | 24 | 13 |
| 请求用途 | completion 24 | completion 12、prompt_suggestion 1 |
| 未缓存输入 token（记录值） | 55,169 | 14,315 |
| 输出 token（记录值） | 9,980 | 4,834 |
| 缓存读 token（记录值） | 742,656 | 166,144 |
| 缺失 usage 请求 | 1 | 0 |
| 未知费用请求 | 24 | 13 |
| main operation 时长 | 181,032 ms（截止收尾） | 50,438 ms |
| 每完成 workflow 成本 | null | null |

B 的 12 个 completion 请求使用 step-5-preview upstream；另 1 个 prompt_suggestion 使用 DeepSeek。A 的 24 个请求都使用 DeepSeek。建议调用没有从成本分子剔除，也不冒充 worker execution；两组原生节点执行数都是零。B 的主回合约 50 秒就完成直接修改，其余时间等待正式流程达到截止，不把 180 秒误报成模型一直在执行。两组 timeout 都指 workflow 未完成，不指全部编码行为失败。

B 在临时项目直接读写、运行其复现检查并提交；没有调用 propose_graph。A 的工具轨迹主要是 bash/read 与能力、配方调查。两者均非合法用户提问等待，awaitingInput=false。清理均完成，daemon 和私有模型进程已停止，正式汇总纳入失败成本。没有更换候选来追求通过，没有修改默认用户项目或生产配置。

## 价格与限制

再次读取 [OpenCode Go 官方文档](https://dev.opencode.ai/v2/docs/console/go/)核对精确 ID step-5-preview，公开输入/输出/缓存读为 USD 1.00/2.70/0.10 每百万，缓存写为“-”。临时候选删除旧 -free 的四项零价，标记 pricing.status=unknown；不把缺失写价填零。候选仍走现有 Go 连接及其凭据引用，没有修改生产 endpoint。contextWindow/maxTokens 沿用旧 Step 连接的配置上限，不代表已核实新 upstream 的容量。

A 有一次截止调用 usage 缺失，且全部缺少完整冻结价格；B 虽无缺失 usage，全部调用也没有完整冻结价格。零个完成 workflow 时，不能给出节省比例或每完成任务估价。单任务、单次、不同执行方式、未完成 A-B-B-A 的前两项，不支持统计质量保证、任务树成本优劣或生产选择。Step 5 直接编码成功是下一步设计的线索，不是本次 planner/worker 分层通过。若要改变任务完成定义或改成 standalone main 比较，必须另行冻结方案，不重标本轮样本。

## 可复核材料

私有实验目录：/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-step5-approved-5wuh38om。

- parser-a.json、parser-b.json：真实 runner 报告（各含独立 state 根目录）。
- comparison.json、comparison-result.json：显式 workflow scope，全部尝试纳入，两个 costPerCompletedTask 都为 null。
- plan.json：原顺序、180 秒上限、固定角色和停止原因。
- a.config.json / b.config.json：仅临时配置、0600，不提交凭据引用/路由头到仓库。
- 每个 state 根目录的 cost-report.json、state/tasks.sqlite：完整账本，case.json 仅在模型进程停止后落盘。

复核：`node scripts/harness-eval-summary.mjs <实验目录>/comparison.json`。局部完整流程 3/3 通过；全量 /tmp/graph-harness-check-layered-workflow.log 为 270 文件、1,502 测试通过，真实浏览器与 FFF 依赖执行，验收证据未变化。本轮只完善评测脚本与证据，未启用生产模型、路由、effort 或上下文实验 flag。总体降本目标尚未达成。
