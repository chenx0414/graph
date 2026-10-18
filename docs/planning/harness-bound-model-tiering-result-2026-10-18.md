# 完整资源模型分层：对照组未交付，按批准条件停止

2026-10-18 使用者明确批准最多四个隔离会话，顺序 parser A、parser B、CLI B、CLI A；每项模型运行上限 180 秒、失败即停、不补跑。[批准提案](harness-bound-model-tiering-proposal-2026-10-18.md)的首项停止条件已经触发：仅运行 parser A，其余三项未启动。生产模型、effort、角色和全部实验 flag 未改。没有证明模型分层降本，也没有本轮 LongCat 或 Step 5 的质量结论。

## 实际结果

| 项目 | parser A |
| --- | --- |
| planner / worker / reviewer 配置 | DeepSeek V4.1 Flash / DeepSeek V4.1 Flash / Step 5 Preview |
| 实际调用模型 | 仅 DeepSeek V4.1 Flash |
| 完整配方资源引用 main/coder/reviewer | 14 / 6 / 5，加载验证通过 |
| 模型请求（含中断尝试） | 25 |
| 记录 input / output / cacheRead / cacheWrite | 80,738 / 20,695 / 1,152,768 / 0 |
| unknownUsage / estimatedUsage | 1 / 0 |
| unknownCost | 25 |
| 执行时间 | 181,005 ms，含中断收尾；operation 180,861 ms |
| proposal / confirmed graph / worker / review | 均无 |
| 业务文件与独立验收 | config.js 保持原始错误实现，独立行为验收失败 |
| 最终状态 | interrupted；worker_active 已清除，cleanupIncomplete=false |
| 完整交付 | 0/1 |
| 严格成本/完成任务 | null |
| 公开 off-peak 费率下已记录 token 小计（USD） | 0.027986004，完整情景/完成任务仍为 null |

25 个真实请求来自 request_profile 与账本关联，不把 70 个 invocation 行全部当模型调用；其中包含工具 admission。中断请求的缺失 usage 不填零，不删除失败的成本分子。公开费用仅为 [OpenCode Go 官方使用量费率](https://dev.opencode.ai/v2/docs/console/go/)情景，不是发票或订阅现金支出，也不是已知整次请求总额。候选和 reviewer 都没有启动，不把未执行写成失败质量样本。

## 轨迹解释与局限

真实 Pi session 有 43 次工具调用：bash 29、read 10、get_agent_combination 2、read_system_capabilities 1、list_projects 1。main 验证了原始 parser 的错误，然后广泛阅读 Graph 文档、示例、proposal/acceptance、Git integration 与实现源码；在时限内没有调用 propose_graph。不能从这一条轨迹断言“调低 planner 思考强度”或“换便宜 worker”会改善结果。

两次配方详情查询分别传入 coder@2、reviewer@2，返回 Unknown Agent combination。产品公开契约区分 recipe ID（coder/reviewer）与 graph 节点 definitionVersion（coder@2/reviewer@2），已有 briefing 也说明这一点；本轮新增的用户角色 setup 却把后者标为 recipe，术语不准确，可能加重查找混淆。此因素与大量 API/源码探索同时存在，不能把全部超时归因于这两个错误，也不能据此宣布对照模型质量下降。

真实请求的静态 fingerprint 只有 1 个；meanEstimatedStaticTokens 为 17,190。25 请求累计 wire 启发式估算分别为 system 86,100、tools 343,650、user 28,275、assistant_history 218,169、tool_results 529,277 tokens。这是重发请求的累计估算，不能分摊供应商 cache/input 账单；tool_results 累计约 2.68MB，进一步说明探索轮次及历史重发值得调查，不能据此给出可实现降本比例。

本次数据库 tool_calls 表未给出 main 的这些调用；原生 session 与实例 tool-calls spool 各保留 43 条，事件还有独立 message.tool 记录。源码核对显示子进程已落盘，公开 `/api/tool-stats` 的读取负责归并 spool；本评测收尾没有请求这个接口，而 harness-cost 只读 DB，因此不是“main 没调用工具”，也不是已证明遥测丢失。运行中误用未归并的统计表得出的观察已纠正。后续应补齐评测收尾的公开统计读取与 E2E，当前 DB 报告不能冒称完整工具覆盖。原始账本与 spool 保持原样。

资源目录保真通过不等于所有 MCP、浏览器、外部服务都执行成功；allRuntimeDependenciesProven 仍为 false。脚本化受控 E2E 能证明正式链路可执行，不能代替真实 planner 在此 180 秒范围内完成交付。

## 收尾修正，未补跑真实模型

只修正评测 setup 的术语：coding recipe: coder；independent reviewer recipe: reviewer；另列 graph node definition 的精确版本。原始任务、模型、effort、配方和业务验收不改。原冻结 plan 和实际发送的 execution-setup.json 保留旧字节，不用新 setup 重解释失败样本。

扩展同一完整交付 E2E 的受控外部模型，让它按收到的 recipe ID 真正调用 get_agent_combination，随后走真实 worktree/commit/artifact/check/review/目标交付。红灯 `/tmp/graph-model-recipe-identity-red.log` 复现 Unknown Agent combination coder@2；修正后 `/tmp/graph-model-recipe-identity-green.log`：1 文件、5 测试通过，49.43 秒。没有新增或改写低层测试，没有启动其他真实会话或重跑 parser A。最终全量 `/tmp/graph-model-recipe-identity-check.log`：272 文件、1,514 测试通过，353.18 秒，baseline 匹配，验收证据不变。

## 材料与下一步

计划、私有冻结配置、原始结果、finished.json、停止项及逐模型情景：
`/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-bound-model-tiering-EjgLzd`。

状态、session、原业务项目、cost-report.json、case.json 与发送前 setup：
`/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-acJWjm`。

聚合核对：`/tmp/graph-bound-model-tiering-observation.json`。本轮 source/case/model/context hash 均在发请求前持久化；context SHA-256 为 de57b345f76ce241c037d3eb2c3ca873372a1ee026d573c32e194fdde5034b39。运行后本地术语修复改变 runner hash，不篡改冻结值。

本次批准范围已经按停止条件结束。后续先处理主会话工具统计缺口与正式 graph API 的发现成本，不继续消耗未启动三项，也不以新 setup 为理由自动重试。若要再运行模型比较，需形成新的具体范围；当前保留全部默认值，整体价格加权降本且质量不降目标未达成。
