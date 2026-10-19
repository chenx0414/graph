# Planner 对照：首项停止，未证明收益（2026-10-19）

批准范围摘要 `1e3b199fddd282b00c307e09fbf8e46b19c88c5a91b8399c7b3725685a4e36ae`，使用者批准“这四个恢复后的 planner 对照会话”。实际只执行 parser B（Step planner），因源码漂移、600秒超时和未知用量停止；parser A、CLI A/B取消，不补跑、不默认启用。没有完整配对，不能比较或推荐planner。

## 原始运行与终态

持久原始目录 `/Users/macmini/.graph-eval/planner-20261019/parser-b/graph-real-eval-default-U0STP2`；计划、冻结源码、漂移副本与汇总在 `/Users/macmini/.codex/attachments/81739269-9f1f-4891-b9b7-4dd7f46a3ff7/harness-recovery-2026-10-19`。orchestrator session86473已exit0，finished attempted=1/noFurtherAttempts=true。记录的daemon PID已不存在，活跃operation/execution均0，graph stopped、main paused；不是观察超时后擅自重启。

模型工作窗口600351ms。main第一operation succeeded，第二interrupted；taskSuccess/business/completed均false。DeepSeek worker启动并有completed execution，但未完成任务；没有独立reviewer绑定或执行，未交付目标项目。主报告workflow.phase=idle是清理前快照，最终正式task为stopped。

共90请求：Step planner 82（1未知usage）、LongCat辅助1（权威usage）、DeepSeek worker7（权威usage）。已记录input224482、output57966、cacheRead6054720、cacheWrite0；0 estimated，1 unknown保持未知。正式费用89请求未知；offPeak/peak公开情景已记录token权重小计0.953192212/0.958526824 USD，不是完整总费用或发票。完整任务成本null；没有成功任务，不能将这些小计除以未完成任务或与旧成功样本作因果对比。

## 源码漂移与RSI

首项结束的冻结核验发现唯一内容漂移为src/runtime/agent-tool-definitions.ts；orchestrator捕获Source drift并取消余项。异常收尾再尝试停止接口时ECONNREFUSED，因为评测daemon已经关闭；此错误保留，独立PID/SQLite终态检查证明没有残留执行，不能把拒绝连接本身当清理完成证明。

主会话多次将graph_send.value、graph_patch.changes、graph_create.definition作为字符串发送。宿主明确返回对象诊断；实际工具schema此前为{}。该行为没有被诊断提示自动修复，不能声称此前诊断已节省真实成本。

planner随后自行执行RSI：首次apply_rsi_change因工作区存在其他人的未提交工作而拒绝；主会话通过shell创建0b8a7f3，将原有63文件的未提交工作保存为wip；再调用RSI修改schema。首次检查`node --noEmit`失败；下一次仅`node --run typecheck`通过，生成b5a76b3。RSI activation.state=saved、restartRequired=false，没有reload确认；不能称生产已启用或完整门禁已通过。

0b8a7f3改变了原有工作的Git状态，不能当作本轮优化交付。当前保留这份提交，不重写历史或撤销别人的文件。源文件内容漂移发生在本轮过程中，本轮不能再满足固定源码只换planner的实验条件。

b5a76b3将两个参数改为显式自由对象、value改为JSON类型联合；注释声称工具层会把无类型参数编码成字符串，但该归因尚未被证明。现有完整交付E2E曾在原schema下传递对象成功，实际模型会话中的调用本身是字符串。需独立验证schema行为，不能把自述作为根因证据，也不能据此接受模型自修复的成本收益。

## 当前结论

该范围已经结束。整树成本下降、质量等效和模型选择优势均未证明。RSI在生产身份中的维护职责与冻结实验约束发生冲突；新实验必须先明确隔离源码/维护副作用的可审阅方案，不能默默关闭产品职责、弱化资源或沿用本次批准补跑。

## schema候选的独立核验与撤回

在b5a76b3上运行原完整交付owner：5项中4通过、1失败（49.88秒），frozen-explicit缺少原graph_patch对象/JSON字符串恢复诊断。不是全部业务无法完成的证明，但否定了完整既有契约已保持。未修改测试来接受它；仅将agent-tool-definitions.ts恢复到effdc65的逐字版本，wip保存的其他文件保持。原提交仍在历史，候选可复查；恢复后同一5项完整E2E全部通过（49.49秒），未改测试来迎合候选；最终全量门禁272文件/1514测试通过（357.63秒），baseline匹配、验收证据未变。

实际main session共有98条toolResult、9条isError，另有9次结构参数相关调用类型记录（其中一次graph_send为text聊天，没有value，不误记为null投递）。该统计不含child spool，不能冒称全树工具错误率。原始类型/错误计数保存structured-argument-evidence.json；不公开参数正文或凭据。

## 后续优先级（使用者决定）

使用者指出未知用量反复使成本结论无效，要求先妥善解决再实验。停止新增真实模型对照；下一阶段优先诊断用量采集、中断结算和供应商证据恢复。不能承诺外部网络/供应商永不丢失用量，但应以正常、终止、断流与恢复场景的真实E2E证明可靠性；不可恢复的用量继续unknown并阻止样本进入完整成本结论，不以估算、零值或排除失败替代。
