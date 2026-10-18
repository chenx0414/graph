# Reviewer 身份完整任务对照：停止结果

状态：使用者已明确批准四个新增隔离 workflow；本范围实际执行 parser A、parser B 后触发停止，CLI B/A 取消、不补跑。没有证明每完成任务降本或质量等效，候选未启用为默认。整体目标仍未达成。

## 授权与冻结范围

批准答复为“批准这四个 reviewer 身份对照会话”，对应 `call_96fcb3a929f747a5a85c4c7af377bbdf`。原始提案、批准记录、独占 started 文件、冻结清单与结果保留在私有目录 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-reviewer-comparison-wcsWNV`；原提案保留审批前原文，不修改历史字节。scopeDigest=`a294cd8c15d9ee61ff5b047105834f79db300b9365d0015ca1978b36e21e9311`。私有 config 含凭据，不进入仓库。

获批顺序为 parser A/B、CLI B/A，每项最多360秒，任何失败或未知/估算usage即停。A原身份，B使用[精简候选](experiments/reviewer-identity-candidate-2026-10-18.md)的2593字节物化版本及完整只读按需参考。planner/worker固定DeepSeek当前profile，独立reviewer固定Step 5 Preview非free upstream，辅助模型继承冻结配置；完整14/6/5资源。两组提示建议上限20秒并计入总时限，其他实验关闭，不修改effort、重试策略、输出限制或任务验收。

源码/文档1497项清单及归档固定，两次实际运行的身份、资源、角色、源码和辅助时限策略校验均通过。原/候选上下文归档161904项比较仅3文件不同：身份正文、能力元数据、配方版本引用。原身份13887字节，SHA-256=`07447dbe8733fb9e24b1016d52b62468748b27547b5cff7af3021f3436624ee5`；物化候选SHA-256=`22354ff8819b4f0a59f8217b67ac6d5e6104c60fd099e4bfd211eddd1ebd9503`。这证明装配保真，不证明审查质量等效。

## 完整任务结果

| 指标 | parser A：原身份 | parser B：候选 |
| --- | ---: | ---: |
| 完整任务成功 | 是 | 否 |
| 总耗时 ms（含终止开销） | 255732 | 361705 |
| main 两次 operation | 均 succeeded | 均 succeeded |
| 实现 execution | completed | completed |
| 独立审查 execution | completed | failed：Request aborted |
| graph 最终持久状态 | completed | stopped |
| 独立业务验收 | verified | behavioral CLI check failed |
| 请求数（整树） | 62 | 45 |
| 未知 / 估算 usage | 0 / 0 | 1 / 0 |
| input tokens | 140966 | 217645 |
| output tokens | 24461 | 45087 |
| cacheRead tokens | 1954496 | 1611968 |
| cacheWrite tokens | 0 | 0 |
| 宿主工具调用 / 错误 | 72 / 3 | 65 / 2 |
| 严格冻结费用 / 每完成任务费用 | null / null | null / null |
| 公开 off-peak 权重每完成任务 USD | 0.087124598 | null |
| 公开 peak 权重每完成任务 USD | 0.121258196 | null |

B 的tokens只是已记录部分，不能将未知计作零。成本保留全部失败调用和辅助调用；不因B请求较少就认定更便宜。冻结账本A有60条、B有44条未知价格，严格费用均null。公开逐模型权重沿用本轮冻结情景，不是发票或长期免费承诺。B off-peak已记录权重小计0.090046054 USD，因未知usage与成功数0，每完成任务仍null；不能用该小计计算节省率。两次尝试合计的完整成本同样未知，不能删去B以制造总体收益。

整树逐模型分解如下（input/output/cacheRead）；DeepSeek包含main与实现，不能把它全部归作worker：

| 模型 | A 请求 / tokens | B 请求 / 已记录tokens |
| --- | --- | --- |
| DeepSeek | 47 / 123417/17189/1769216 | 36 / 205511/40661/1543168 |
| LongCat 辅助 | 2 / 2418/112/0 | 1 / 563/77/0 |
| Step 5 reviewer | 13 / 15131/7160/185280 | 8 / 11571/4349/68800，含1条未知usage |

A实现与审查均无宿主execution重试；B审查记录retries_used=2、resubmits_used=0，属于原运行时内部行为，已包含本次计量，不是重新启动workflow。没有人工补跑。

A graph=`03cd1e37-5c92-4c13-bc15-ed6f29b289bb`，integration/target SHA均为 `9ac7e12df91216e38875c61667295a4f46e475d5`。B graph=`a80e8a20-92f1-4bb3-bd93-4e085466a8b4`，integration SHA=`a65a0194e8d4e96139a947e85509e68959e6041b`，target仍为 `1a469e3907eb498b24b42603e1ab32f0d1b00a78`。B不能以worker已修复或main成功替代正式审查与目标交付。

B结果文件的workflow.phase=running是停止前快照；终止后SQLite为stopped，owner paused=1，所有operation worker_active=0，cleanupIncomplete=false。不能据旧快照宣称仍在运行，也不能说main最终operation被中止。

## 失败与参考读取审计

A首main operation约100.4秒，第二约154.1秒；B分别约271.9秒、89.1秒。B reviewer直到首main开始后329162ms才启动，到停止约31.9秒；A reviewer执行约50.2秒。不同的规划与建图轨迹已经明显影响可用审查时间；每组只有一次parser样本，不能把B超时归因于身份文字，也不能据此认定候选本身审查能力更差。

B reviewer最后一条Step 5请求 created_at=1792301274312、settled_at=1792301277192，state=unknown、usage=null；随后graph.node.failed明确reason=Request aborted，graph.stopped=1792301277230。未知usage归属于reviewer completion，而非LongCat提示建议。

A两条提示建议成功；B第一条成功，第二条事件为Connection error.，timeoutMs=20000、timedOut=false。账本仅记录B一条LongCat请求；第二条错误事件与账本覆盖不同，未凭空补出usage或假定其费用为零。不能把20秒等待视作已解决所有辅助计量问题。

B reviewer会话的read和bash等toolCall参数没有访问冻结完整参考路径，未观察到参考正文回读。因此本次没有已观察到的全文参考读取及后续重发成本；不能据此证明所有专项检查仍等效。此前本地受控探针主动读取全文、产生73715字节重发，只证明装配和潜在反向成本，不混入本次真实模型结果。

全会话toolResult错误扫描与宿主计数一致：A为git只读限制、macOS缺sha256sum、artifact tag格式错误；B为对owner查询不存在的coder节点、macOS缺sha256sum。本轮未观察到额外的参数schema拒绝错误，但这不回填旧会话的计量覆盖。每工具调用占比只有单次workflow的观察，不能外推生产使用率。

## 解释与后续边界

实际wire profile按请求累计：A system/tools/user/history/tool_results分别987765/2529319/444423/1309250/3069119字节；B为628191/1732063/282081/2065916/2833838字节。候选静态部分较小，但失败任务和请求数不同，不能直接比较总字节得出费用收益。来源×billing精确分摊仍不可得，不按字节比例分账。

本轮保持原身份默认；CLI两项取消，未获得CLI质量样本、完整成功候选成本、缺陷检出率或误报率证据。已有[完整辅助基线](harness-auxiliary-baseline-result-2026-10-18.md)属于另一次授权，不替换本轮A，也不拼接为有利对照。当前最明确的下一步是离线核对规划耗时与停止计量路径；扩大时限、关闭辅助、更换模型、增加付费样本均不属于本轮授权。

证据文件包括proposal.md、plan.json、started.json、finished.json、observations.json、parser-a/b.json、terminal-audit.json、offPeak/peak-summary.json及对应state/tasks.sqlite和sessions。A匹配capabilities/extensions缓存已逐字验证现有归档后释放，恢复元数据保留；state、会话、项目、账本与结果保留，不通过删除失败数据腾挪结论。

验证：私有终止状态与会话只读审计、冻结完整性校验、费用汇总、git diff --check。本文不修改运行时代码或测试；提交前 `node --run check` 全量通过：272文件、1514测试，365.11秒；baseline匹配、验收证据不变。日志 `/tmp/graph-reviewer-comparison-check.log`。


## 本轮逐工具计数

调用次数/错误数如下；0表示该会话未调用，不代表生产使用率。

| 工具 | A | B |
| --- | ---: | ---: |
| artifact_list | 4/0 | 2/0 |
| artifact_promote | 2/0 | 0/0 |
| artifact_publish | 5/1 | 1/0 |
| artifact_read | 1/0 | 1/0 |
| bash | 30/1 | 39/1 |
| fffind | 0/0 | 1/0 |
| get_agent_combination | 2/0 | 1/0 |
| get_graph_state | 1/0 | 0/0 |
| get_task_status | 4/0 | 3/1 |
| git | 5/1 | 0/0 |
| graph_control | 1/0 | 0/0 |
| graph_inspect | 6/0 | 1/0 |
| graph_send | 3/0 | 3/0 |
| propose_graph | 1/0 | 1/0 |
| read | 2/0 | 8/0 |
| read_system_capabilities | 1/0 | 1/0 |
| submit | 1/0 | 1/0 |
| validate_proposal | 1/0 | 0/0 |
| workspace_commit | 1/0 | 1/0 |
| write_file | 1/0 | 1/0 |
