# 首次大 shell 输出短视图：默认关闭（2026-10-18）

本实验针对已观察到的大输出呈现，不改变模型、effort、角色、RSI 职责、工具 schema 或系统 prompt。新的 GRAPH_COMPACT_SHELL_RESULTS 默认关闭。真实 A/B 两组均完成，但都未触发输出变换，因此没有可归因收益、不扩样、不启用；总体降本目标仍未达成。

## 来自真实轨迹的机会

此前完整绑定的 command B 产生大 shell 结果并为此记录 harness-backlog。检查真实 session 后，Graph 的既有钩子确实生效：约 32K 字符的 SDK 视图又被压至约 20K 字符；不能把模型 backlog 中的原始长度误当最终内联长度。业务配置修复后仍调查/发布该问题，说明应先解决输出呈现，而非取消 ADR 0026 的维护职责。[前次对照](harness-bound-command-2026-10-18.md)保留原结果。

另对桌面状态保留的 284 个 session JSONL 做流式只读审计，146,636 行，3 行不可解析；按 entry ID、toolCallId、tool 名、正文与错误状态的 hash 去掉复制条目。得到 26,847 个唯一 toolResult，另跳过 43,286 个复制条目。其中 bash 15,496 条，共 21,598,248 字符；1,138 条（7.34%）超过 4,000 字符，贡献 7,900,348 字符。若仅用 1,024 字符视图作离线体积 proxy，潜在减少约 6.73M 字符、约占 bash 正文 31.2%，未扣必要 notice；不是 tokenizer 用量、价格加权收益或任务完成指标。

这些 shell 条目按原始 entry.timestamp 日期前缀落在 2026-09-21 至 2026-10-12，没有覆盖本轮 10-16 以后生产 shell 轨迹；包含不同版本和模型。文件遍历也不是跨文件事务快照，缺失/不可解析不能当零。复制历史不能当新 API 调用，不把首次遇到的文件夹当业务 conversation 归属。核对文件 `/tmp/graph-shell-output-population-2026-10-18.json`，只有统计与元数据，没有打印用户正文。该结果仅提高候选的调查优先级。

## 开关行为与保存策略

默认路径保持原阈值、前两次完整视图和旧的 256 文件清理窗口。开关为 1 时，仅 bash 文本超过 4,000 字符的结果在首次就落盘，并用已有约 1,024 字符的 head/tail + 长度/行数 + handle 呈现；保留非文本部分、错误状态及退出码。小输出和其他工具不改变。主进程显式把布尔值传入一次性 worker 和 resident worker，避免依赖子进程环境继承。

新的文本副本放在实例 tool-results/shell 子目录，不进入旧 lazy spill 的自动清理窗口；否则短视图可能指向已被删除的唯一副本。复用结果 hash，不为相同调用及相同内容无限重复命名。原生 SDK 生成的完整日志和 Graph 保存的 SDK 返回文本分别保留：不能把 SDK 已经缩短的窗口文件冒称原始 stdout 全文。已发出的历史不重写，reasoning items 不变。实例目录被用户清除后的数据恢复不在此保证内。

这增加落盘、磁盘保留与 IO 成本。尚未证明长期大负载、满盘或所有原生 SDK 输出形态下的端到端质量；不能据局部测试启用。回滚为移除开关或设置为 0 后重新创建 worker，恢复旧视图；已有数据文件仍保留。系统 prompt diff 为零，无“节约 token”或降低工作强度指令。

## 真正的 E2E 与保留窗口回归

扩展已有 command-output-preservation owner，真实 HTTP conversation → Pi 原生 bash → 本地受控模型 → 原生 read → daemon 重启。命令实际输出 5,000 行并退出 7；默认视图超过 10K 字符，实验视图少于 2K 字符，尾部标记和退出码保留。模型从实际返回的原始日志路径读取第 2,500 行，得到初始视图没有的中段标记；测试还核对原始文件全文与独立生成的完整输出一致。

首次红灯 `/tmp/graph-compact-shell-red.log`：默认通过，实验视图仍过大而失败。基本实现后 `/tmp/graph-compact-shell-green.log`：3 文件、27 测试通过（只运行原有低层测试，没有新增或改写它们）。

随后加强同一 E2E 的实验行：再真实执行 256 个不同的 5K shell 输出，然后重启，由模型 read 读取早期 handle。旧保留策略在 `/tmp/graph-compact-shell-retention-red.log` 真实删除了首个文件，ENOENT 复现；修复后 `/tmp/graph-compact-shell-retention-green.log` 3 文件、27 测试通过，早期结果跨清理窗口和重启仍可读。没有替代自有工具、伪造文件保留回执或新增低层测试接口。

首轮全量 `/tmp/graph-harness-check-compact-shell.log` 早于保留策略修复。修复后的最终全量 `/tmp/graph-harness-check-compact-shell-final.log`：272 文件、1,513 测试全部通过，358.07 秒，suite baseline 匹配，验收证据不变。

## 完整绑定下的有限 A/B

沿用当前完整配置与同一 v2 资源归档，默认 DeepSeek V4.1 Flash，固定已有 command 提示/初始文件/checker、A→B、每组最多 180 秒；其余 flag 全关闭。B 只开新输出 flag。worker 配置实际记录 A=false、B=true，评测 variant 明确为 compact-shell。计划在发请求前持久化，每组一次、不补跑。

| 结果 | A 默认 | B 短视图 |
| --- | ---: | ---: |
| 业务/原 checker 字节/main 终态 | 通过 | 通过 |
| 全部请求（含提示建议） | 10 | 6 |
| 记录 input/output/cacheRead | 23,058 / 4,217 / 160,256 | 19,692 / 2,662 / 76,800 |
| 缺失/估算 usage | 0 / 0 | 0 / 0 |
| 严格冻结成本 | null | null |
| 公开 off-peak 逐模型费率情景/完成任务（USD） | 0.006268368 | 0.004622250 |
| 时长 ms | 46,326 | 37,296 |
| 大 shell 变换次数 | 0 | 0 |

两组都主动重定向诊断输出：A shell 回执最大 565 字符，B 最大 286 字符，全部小于阈值。B 的有利变化不经过新代码分支，不能归因于输出压缩；A 还执行了 backlog 的检查/发布，B 没有。这是非触发任务的正常行为差异，不支持“26% 降本”。收尾保留策略修复也不影响这两个未触发样本，不以此为由补跑付费模型。

价格使用前轮已核对的 [OpenCode Go 官方费率情景](https://dev.opencode.ai/v2/docs/console/go/)，按实际模型分别加权，缓存写价仍 null（记录写 token 为 0）；不是回填发票或重建订阅现金支出。严格账本费用均未知。真实完整任务与外部服务成功证明仍不能由单点扩张。

材料：`/tmp/graph-compact-shell-observation.json`；冻结 plan/config、A/B、comparison-off-peak 及结果在 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-compact-shell-pair-pDRQJy`。状态根 A `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-default-M24XyF`，B `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-real-eval-compact-shell-qyMrJY`。

下一次模型验证应取自当前版本、自然产生大 shell 结果且可独立验收的真实任务；不能要求模型禁止重定向、故意喂大输出，或从这次非触发样本追逐有利波动。当前仅保留关闭的实验和历史机会估计。


## 后续获批完整workflow范围

[600秒完整对照](harness-shell-workflow-result-2026-10-18.md)另行获得四会话授权；parser A成功、B实际7次触发但未交付且main未知usage=1，CLI两项取消。旧command对照的0触发结论保持，不拿新范围补改旧数据。当前仍无候选完整任务成本或质量等效证明，默认关闭。
