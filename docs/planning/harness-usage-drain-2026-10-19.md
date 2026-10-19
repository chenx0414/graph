# 优先修复中断用量丢失（2026-10-19）

使用者要求先解决反复未知用量再继续成本实验。新增付费对照停止；本轮只使用真实Graph/Pi/HTTP/SQLite/CLI与外部供应商fixture，付费模型调用0。完整优化目标尚未完成。

## 真实故障线索与复现

最近planner首项90请求中89条权威、1条未知。未知callId为54a29c84-6e37-4c00-a390-94a2a492ebea，属于第二个interrupted operation。发送profile在1792408243146，operation在1792408248904结束，相隔5758ms；这是与超时中断的相关证据，没有原始供应商响应，不能断言真实该笔一定可恢复。

源码显示SDK取消信号直接传给实际fetch。取消Agent同时关闭供应商连接，独立usage clone也无法继续收尾；等待既有evidence Promise并不能使已取消连接重新收到usage。

原CLI生命周期E2E已有超时后仍会返回最终usage的真实本地HTTP供应商。增强同一个公开流程断言后，原实现明确红灯：预期0未知而得到1（7.28秒）。这证明可避免的本地取消丢失，而不是凭SDK错误中的零token推断用量。

## 修复

controlled-openai新增显式开关`GRAPH_DRAIN_CANCELED_USAGE=1`，默认关闭以保留既有立即取消契约。启用后，SDK交付取消与已受理请求的HTTP用量收尾分开：Agent仍取消，不执行迟到工具；已经发送的连接最多继续30秒以读取供应商最终usage。收尾结束或失败后释放原credential slot/预算预留；没有重发或补跑。取消后通过独立admissionSignal拒绝新的准入，包括队列等待与重试之间。

ResidentHost同时跟踪宿主模型回调：停止worker后先等待这些回调完成，再允许SQLite关闭。worker退出本身不再被当成宿主HTTP记账已结束的证据；关闭后不再向已退出worker发送模型结果。

评测CLI在显式启用收尾时，将外层清理等待设为35秒，使30秒HTTP收尾之后仍有持久化余量；默认清理等待保持30秒。修复前两个同为30秒的期限会竞争，CLI可在最终unknown落盘前报告cleanupIncomplete。该5秒余量不是额外模型工作窗口；实际收尾时间及token仍计入任务。

若30秒仍没有usage，收尾连接被中止，账本保留unknown。缺失用量的正常响应仍明确estimated或unknown，不升级为权威。没有使用估算/零值填充，没有将中断任务改为成功，也不改写历史未知调用。

这是采集可靠性修复，不保证供应商、网络或进程永不失效。独立连接的原请求可能继续生成并计费；最多30秒收尾时间、全部实际tokens仍算入任务。不能声称它免费，也没有证明其降低任务费用。此为当前实现固定收尾上限，不将它悄悄套入已结束实验的600秒授权。

## 验证证据

- 增强前main超时公开CLI流程：红灯1未知，usage-drain-red.log。
- 修复后同一main流程通过，usage-drain-focused.log。
- 真实CLI生命周期owner第一轮9项通过，109.27秒：正常main/worker、缺usage、业务失败、延迟main/worker usage、辅助默认5秒与20秒，以及供应商发送内容但永不返回usage。延迟usage采用独立预期25/10/15等固定账单值，未知不填零；无usage窗口在30秒后有界结束，task不成功、成本null。
- 补充迟到工具调用：取消后供应商仍返回真实bash写文件请求，main/worker两项通过32.39秒，未产生该文件，请求数分别保持2/1，原中断状态保持，usage为权威。不是只检查取消函数被调用。
- fixture仅替代外部HTTP服务，没有mock自有Graph、计量、Pi、宿主工具或持久层。新增一行真正E2E场景，无新增/改写单元或集成测试。
- 独立真实CLI流式探针：供应商先发送响应头/工具增量，5秒后才返回usage；4秒时取消。2请求0付费，before-cancel.txt真实存在、after-cancel.txt不存在，task仍interrupted，权威账本为input50/output20/cacheRead30/cacheWrite0。覆盖响应已开始后的取消，区别于响应头前延迟。持久证明usage-stream-drain-proof.json，最新显式开关/关闭修复后重跑也通过（usage-stream-final.log），原始目录/Users/macmini/.graph-eval/usage-stream-tIY9AK。
- 首轮全量门禁暴露3项回归（usage-drain-full-check.log，272文件中270通过、1515测试中1512通过，380.45秒）：两个既有快速取消流程超时，关闭graph后落盘仍为inflight。该方案未交付；没有放宽原取消测试。
- 修正为显式评测开关且默认关闭，并补上ResidentHost关闭前等待宿主回调。既有快速取消及真实graph/HTTP/SQLite关闭流程两种开关状态共21项通过44.62秒（usage-drain-shutdown-green.log）；开启收尾且供应商永久挂起时，重开磁盘已明确unknown，不留inflight。CLI复验暴露外层30秒清理和内部30秒收尾的到期竞争，以及辅助基线子进程漏传开关，两项失败保留在usage-drain-final-owner.log；现修正这两处，保持unknown和迟到工具断言不变。修正后完整CLI owner 9项通过109.70秒（usage-drain-final-owner-v2.log），包括永久缺usage、延迟main/worker、默认/延长辅助窗口以及迟到工具。最终完整`node --run check`通过：272文件/1516测试、396.76秒（usage-drain-final-check.log），类型/lint/baseline/验收证据检查全部通过；测试基线按既有增长规则从1514自动升到1516，未降低原门禁，验收证据不变。

日志持久目录：`/Users/macmini/.codex/attachments/81739269-9f1f-4891-b9b7-4dd7f46a3ff7/harness-recovery-2026-10-19`。

## 仍需把握的边界

本轮直接证明OpenAI completions兼容路径的延迟响应/取消与永久缺失usage。共用收尾代码不等同于所有供应商的断流、Anthropic增量usage、进程崩溃和重启补账均已证明。没有供应商原始证据或可验证查询接口时，不能把历史未知恢复成数字。

重新开始真实对照前，需先完成用量可靠性门禁，并按实际供应商能力核验断流/恢复与不可恢复分类；继续报告unknown数量，禁止混入有效完整成本。这里的9项E2E或全量通过都不能替代真实模型质量与整树降本证明。此次不申请或启动新的付费实验。

现有Go用量页面路径src/server/usage.ts:433读取/usage并交给openCodeWindows解析配额窗口；当前实现不提供逐callId的input/output/cacheRead/cacheWrite补账证据。不能用配额百分比变化猜某笔token分摊；这不是断言供应商所有接口都不支持查询，只是当前已核验路径的边界。


## 恢复成本实验的判据

1. 已发请求、结算账本和任务树可对账；正常退出后没有inflight、未结算invocation或活跃写入者。
2. 逐请求input/output/cacheRead/cacheWrite来自可验证的供应商usage；延迟收尾的tokens和时间完整计入原任务，辅助调用和重试不能遗漏。
3. 取消后没有新请求或迟到工具副作用，30秒仍无usage时有界标记unknown；unknown/estimated任一非零，该范围停止，完整成本及每完成任务成本不能作为有效对照。
4. 本地故障E2E和完整仓库门禁通过后，真实供应商的采集可用性仍须在明确批准的新范围内验证。该验证须与优化对照区分；不可用的历史记录不用于补成基线。

上述判据以可验证的数据完整性为目标，不能承诺网络/供应商/进程永远不丢数据。当前不启动或申请新付费范围。


## 后续核验：部分用量不能冒充完整账单

在6b3198f之后继续检查采集完整性，发现另一条预存问题：Anthropic的message_start只含起始用量，旧解析器在正常EOF前无message_stop时仍返回它；损坏或缺output_tokens的最终message_delta也可能保留旧值或补0；最终事件更新的input/cache字段则被起始字段覆盖。这与此前Step未知调用不是同一根因，不能用本地Anthropic复现解释历史Step账本。

官方流式契约说明message_delta的usage是累计值，message_stop标记消息结束；完整示例还包含输入/cache更新。[官方流式协议](https://platform.claude.com/docs/en/build-with-claude/streaming)

新增单一真正E2E owner：tests/e2e/provider-usage-completeness.test.ts，真实HTTP会话经Graph、Pi SDK、SQLite关闭重开、harness-cost CLI，外部服务仅替代Messages API。5场景覆盖正常累计、最终input/cache更新、起始数据后EOF、损坏尾部、尾部缺output。旧实现1通过4失败（usage-completeness-red-v3.log，7.80秒）；修复后连同既有credential-queue的3项共8项通过8.28秒（usage-completeness-green.log）。EOF触发的既有自动恢复不被禁用，每次外部实际发送与正式账本逐笔核对，不预设重试次数。

修复仅调整采集：完整message_delta及message_stop齐备才将流式Anthropic用量记为权威；累计output采用最后值而不累加，最终事件提供的input/cache覆盖旧字段，省略的input/cache保留既有值；缺output不补0。无限预算下仍可明确estimated，不能进入权威成本；有限预算继续按正式规则处理。JSON非流式usage同样要求实际output_tokens。无新增模型/路由/推理努力变更，OpenAI路径不变，没有付费调用。最终完整`node --run check`通过：273文件/1521测试、394.72秒（usage-completeness-final-check.log），类型/lint/baseline/验收证据检查全部通过；baseline按增长规则自动增加1文件/5测试，验收证据不变。

供应商恢复能力另见[官方接口核验](harness-provider-usage-recovery-2026-10-19.md)：request logs是值得核验的线索，聚合CSV不能逐笔补账，公开证据尚未建立按ID自动恢复四类token的契约。该结论不是断言供应商没有其他接口。
