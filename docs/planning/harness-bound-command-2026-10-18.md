# 完整绑定下的交付基础与 command 对照（2026-10-18）

本轮补齐真实生产资源绑定下的完整交付基础，并执行一个固定 command A/B。两组业务检查均通过，但候选没有提供降本证据，不扩样、不启用。此前裸环境的有利结果不能外推到该环境。

## 受控供应商下的完整交付

沿既有 delivery E2E 的真实工具流程运行一次本机探针，使用新 v2 全量归档，保留 main/coder/reviewer 的 14/6/5 项资源引用。模型端为三个独立本地受控外部服务，不计作模型质量或成本样本。真实经历 proposal → confirm → worktree 写入/commit → 代码 artifact → host command check → 不同模型的 reviewer 读取不可变 artifact/发布 graph.review@1 → graph complete → 目标项目独立 parser 检查。

最终 taskSuccess=true、phase=completed，work/review 两个 execution 都为 completed，2 个 artifact。main/worker/review 为 12/5/7 请求，账本总数 24，相等且没有付费模型调用。实际 wire 工具数 54/17/16；worker 读到 tdd，reviewer 读到 coding-standards 正文。私有核对文件 `/tmp/graph-full-delivery-probe-2026-10-18.json`，根目录 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-full-delivery-probe-zA22ZU`，实际运行根 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-FL5Mti`。这是装配与交付机制证据，未调用全部外部工具或证明所有外部服务健康。

先前探针只设置 high 偏好且省略 work.model，生产 coder 推荐 medium，因此运行时选到了本地 review 端点，未产生代码 artifact；脚本随后因空 artifact 列表退出。真实状态确认 work 使用 review，符合当时配置，没有作为产品选路缺陷修复。失败根 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-3iXhgI` 保留；确认相关进程均已终止后，显式指定本地 worker/reviewer 重验成功。没有改生产 grade、preferences 或 recipe。

## 完整 main 绑定的真实模型对照

固定既有 command 短请求、settings/check.mjs 和独立行为检查，保留 checker 字节不变。两组复制同一当前配置（含全部模型、preferences、access），主模型仍为现有默认 DeepSeek V4.1 Flash；源模型和 effort 未变。使用同一完整归档摘要 `de57b345f76ce241c037d3eb2c3ca873372a1ee026d573c32e194fdde5034b39`。A 全 flag 关闭；B 仅 GRAPH_MATCH_SEARCH_GUIDANCE + GRAPH_CLASSIFY_HARNESS_FRICTION 打开。A→B，各最多 180 秒，最多一次，无失败补跑；一次配对不支持扩大或启用。计划在发起请求前写入私有 plan.json。

scope 为 main-operation：按独立业务检查及 main 终态判成功，未伪装为正式 graph 模型分层对照。全部主调用和提示建议都计入任务分子。

| 观测 | A 默认 | B 搜索匹配＋摩擦分类 |
| --- | ---: | ---: |
| 行为/checker 不变/main 终态 | 通过 | 通过 |
| 全部请求 | 9 | 18 |
| DeepSeek completion | 8 | 17 |
| LongCat 提示建议 | 1 | 1 |
| 已记录 input / output / cacheRead | 24,054 / 3,686 / 136,576 | 35,995 / 6,711 / 460,928 |
| usage 缺失 / 估算 | 0 / 0 | 1 / 0 |
| 未知费用请求 | 8 | 18 |
| 运行时长 | 38,308 ms | 75,453 ms |
| DeepSeek static fingerprint 种数 | 1 | 1 |

B 缺失 usage 的是提示建议调用，不能当零；其余已记录 token 仍逐模型归属。两个总 fingerprint 对应主模型和提示建议两条独立上下文，不能解释为主会话缓存前缀变化。原 tool_calls 表本轮没有留存结果，因此从真实 session 的 toolResult 另核对调用：A 9 次、B 21 次，均无 isError；B 有 fffind/ffgrep 各一次，另增加读取和命令。不能把请求增量归因错误重试，或从 n=1 判定单独哪个 flag 导致差异。

## 逐模型的价格权重

2026-10-18 再次读取 [OpenCode Go 官方页](https://dev.opencode.ai/v2/docs/console/go/)：DeepSeek V4.1 Flash 每百万 input/output/cacheRead，off-peak 0.15/0.60/0.003 USD，peak 0.30/1.20/0.006；缓存写价未列，保留 null。LongCat 2.5 Preview Free 仍为限时免费。该页描述订阅额度的 token 权重，不是这些调用的重建发票；没有向运行配置补填费率或改变原账本成本。

用新逐模型汇总分别算两套公开费率情景，保留未知 usage：A 每完成任务权重 off-peak 0.006048828、peak 0.012097656 USD；B 只可给已记录 token 权重小计 0.010808634 / 0.021617268 USD，因缺一次 usage，情景每完成任务成本仍 null。未记录写 token 的费率保持 null，已记录 cacheWrite=0，不把“-”改成零价。两组冻结账本的严格成本均 null。不能用这些小计声称精确涨幅或已降本。

本配对没有降本信号，停止扩样，开关继续默认关闭。此前裸环境 command 的约 66.8% 探索信号不能与本次完整绑定结果混合汇总，也不足以推翻本轮停止判断。

材料：`/tmp/graph-bound-command-observation.json`；冻结计划、配置、A/B run 和 off-peak/peak 两套比较清单与结果位于 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-bound-command-pair-LaMJij`。实际状态根分别为 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-MD1Nbr` 与 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-matched-search-Syd2Rm`。重新导出的 cost-report 仅增加模型明细，原导出另存 cost-report.original.json，SQLite 原记录未改。
