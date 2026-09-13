# c8a6816 独立验收：已知用量恢复通过，未知用量核对仍阻塞

固定比较：`git diff fe8e2c4...c8a6816`。依据原产品化待办及 `productization-rework3-acceptance-2026-09-13.md` 的部分执行暂停关闭标准。

**结论：PA02-R3 的已知用量/工具效果恢复通过；未知用量分支不具备可用答复路径，新增 PA02-R4（P1）。T01–T08 暂不整体关闭。**

## 独立验证通过部分

- 项目 Node 24.20.0：47 文件 / **219 项通过一次**，双 tsc、Vite build 通过。全量包含正式 CLI/Chromium、同 key 别名和配置回归；交付方“两次”不计作主审次数。
- 八个历史沙箱/监听探针，以及独立 key B、配置版本、实时记录、PA05 探针，本轮运行保持预期。
- 零发送暂停：0请求、0成功、0名额；恢复后20请求、20成功、最大并发10、后继成功。
- 有文件效果和已知50 tokens后暂停：文件保留，operation interrupted、workerActive=false、reserved=0、used=50、节点pending、无问题；恢复后两次模型请求共计used=100，工作和后继成功，未重复工具写入。
- `host.reconcile()` 对 interrupted 返回并不代表实际执行了核查，它只是对非unknown状态提前返回。本轮认可的证据是正常恢复完成及准确累计用量，而非“reconcile接受”本身。

未调用付费供应商，未改产品源码或历史任务数据库。验收开始时工作区干净；期间出现其他工作产生的 desktop/main.mjs、src/web 下修改及新增样式/UI文件，主审未覆盖或回退。它们不属于本轮固定提交认可范围；完成后不宣称整个工作区干净，也不将原测试结果用于证明这些后续修改。两名并行审查者未都完成最终报告（Spec服务额度中止），主审已独立复跑本报告两条关键用量场景。

## Standards

interrupted 状态正确区分了部分执行与未发送，静止事实、预留释放和已知用量路径有复验证据。新增状态没有与未知用量答复协议一并整合，是下述同一问题的接口一致性缺陷，不另加重复返工项。没有把已知调用凭据或用量被删除作为结论。

## Spec

### PA02-R4 · P1 · interrupted 的 unknown_usage 问题无法答复

位置：`src/core/execution.ts` 新 interrupted 分支（约498–532），及 `answer()` 的 usage/reconcile_usage 分支（约129–145）。

**独立复现**：`interrupted-unknown.mts` 使用生产 Pi 适配器与本地合成 provider，第一轮返回工具调用且不暴露usage。后续发送被门拒绝，操作进入 interrupted；待清理后对打开的unknown_usage问题分别提交“补记权威用量”和“供应商不提供用量、保留未知并放行”。

结果：

```text
providerRequests: 1
operation: interrupted / workerActive:false / result:null
question: unknown_usage / open
usage answer: invalid_answer — requires a known result
reconcile_usage answer: invalid_answer — requires a known result
resume: work blocked，check pending，后续请求0
```

**原因**：新分支刻意保留 result=null；两个既有答复入口却都要求 operation.result 存在，并调用只接受 dispatched/unknown 的正常settle路径。因此“保留未知并阻塞”做到了，“可通过认证答复核对后继续”没有做到。简单补一个非空result仍可能遇到状态不兼容，且不能将部分工作误当完成。

这直接落在上一轮关闭标准“未知用量继续阻塞并可通过现有认证答复路径处理”中；不是要求自动折零或取消未知用量门。

**实现建议**：为interrupted建立明确的用量核对/释放路径，复用统一账本规则但保留它是未完成工作的事实。权威补记后或使用者明确保留未知并放行后，继续原实例和会话，不推进未真正成功的依赖。处理混合已知/未知invocation时保留全部已知用量，新增、重复答复以及恢复不能造成漏计或重复累计；未知费用仍保持unknown。

**关闭标准**：

1. interrupted+unknown_usage 的两种合法答复均可通过认证接口成功处理，并正确解决问题；重复答复拒绝且不重复计费。
2. 纯未知和混合已知/未知调用两种场景分别验证：补记权威用量准确累计；保留未知放行不把未知折零、同时不丢已知部分。
3. 用户恢复后原实例继续，文件效果不盲目重做，后继仅在真正成功后执行；名额、预留释放，最终用量与invocation账本一致。
4. 已知50→100、零发送暂停20节点、全局10名额、模型失败、PA05与八历史探针保持通过。

## 交接

本轮仅此一个P1返工项。PA01、PA03、PA04、PA05及PA02已通过的并发、零发送暂停、已知用量恢复结论保留；T09/T10可选，A13历史范围保持，不必重跑付费任务。

[独立证据目录](acceptance-evidence/productization-rework4-independent/) 保存固定提交、全量与探针输出、已知部分调用和未知核对反例。`interrupted-unknown.mts` 退出0表示采集完成，判定应检查两个answer结果及恢复状态。

两轴：Standards指出新增状态与答复协议不一致；Spec确认1项P1（PA02-R4），合计一个问题。
