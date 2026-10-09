# Issue #1 独立验收报告

日期：2026-10-05。验收对象：`rsi/product-line` 的 `5b5697cb85a755f7df8665afba8438b5fd4b8963`，目录 `/Users/macmini/workspace/graph-rsi`。

评审范围：从首次 v2 实施前的 `6b4af7128483b03cdbfa99f9de378b7372f38bec` 到目标提交；`git diff <baseline>...5b5697c`。不以当前 main（2f5c5cd）代替交付提交。

依据：已确认的 `docs/specs/graph-rebuild-v2.md`、GitHub Issue #1、交接文档、ADR 0030。ADR 0030 记录后续用户选择整体废弃旧 graph；本报告识别此变更，不把它当成未经授权。未独立回溯该决定的原始对话。

## 结论

**整体不通过；不能关闭 Issue #1，也不能将阶段 1–6 标为已完整验收。** 门禁通过，但产品路径、会话隔离、投递和生命周期仍有阻断问题。此次只读代码审阅和临时数据库复现，没有修改被验收分支。

## 独立运行的验证

在交付目录运行 `node --run check`，退出码 0：272 个测试文件、1768 个用例全部通过，耗时约 163 秒（Vitest 部分）；baseline 匹配，tracked acceptance evidence 未改写。详细日志：`/tmp/graph-issue1-acceptance-check.log`。

额外临时数据库复现（无付费模型调用）：

1. 启动 execution 于 revision 1 → patch 禁用边生成 revision 2 → 首次 submit。结果：当前 edge.enabled=false，但 deliveriesFor(execution).length=1。违反“边变更对后续 submit 生效”。
2. complete → 有 paused/failed node 时 settleCompletion。结果 phase=blocked；此时外部 chat 被接受，withdrawComplete 报“not completing”。违反完成请求持续关闭外部输入和可撤销规则。
3. Spec 轴独立复现：将聊天“What did commit ABC change?”入队，GraphRunner 的 host 首个 prompt 收到空字符串；之后收到两次通用 submit 提示，worker 被暂停。证明真实输入没有到达 turn，以及聊天不提交被误判失败。

这些行为在全量门禁仍绿的情况下存在。不能把绿色用例数量当作正式规格通过证据。

## Standards

### S1 [P1] v2 视图伪造零用量与空运行配置

`src/core/task-runtime.ts:965–972` 的 v2 node projection 固定返回 used:0、reserved:0、budget:null、unlimited:false、selectedModel:''。没有查询已经存在的实例预算账本和真实模型。节点消耗 token 或耗尽预算后，视图仍展示零用量和空模型。

依据：`docs/architecture.md` 的 TaskView 额度摘要与实例用量记录规则；CONTEXT 的实际运行配置定义。修复应读取正式账本，缺失数据明确标未知，不能用 0 代替。

### S2 [P2] scripted 测试补偿旧字段，没有证明正式 v2 输入交付

`src/core/task-runtime.ts:622–634` 从旧 proposal 取 input/context，人工构造旧 Operation 交给 scripted adapter，而不是读取 v2 queue 文本。真实 Pi 没有这项补偿。`tests/m8/scripted-legacy-fields.test.ts` 只证明补偿代码收到旧字段，不能证明真实 agent 收到输入。

依据：test-audit 的 authoring gate 第 4 条与“mocks that implement the asserted behavior”条目。scripted host 应只替换模型/进程，消费真实路径同一份上下文；旧 fixture 的转换应发生在测试夹具处。

Standards：2 项。最严重是运行视图伪造用量和配置。

## Spec

### F1 [P1] 任务 value 和聊天内容未传入真实 turn

`src/core/graph-runner.ts:155` 默认 initialContext 返回空字符串；调用 NodeTurnDriver 没有传 turnText，也没有将领取的 queue payload 交给 turn。生产 `src/runtime/kernel-graph-lane.ts` 没有提供 initialContext。节点配方 system prompt 不包含 graph 的具体任务输入。

违反 §7：初始 prompt 必须包含任务、验收、协议与实际 value，后续执行必须提供新输入。应统一从领取的投递/聊天构造 prompt，真实与 scripted 路径共用。

### F2 [P1] 聊天回复没有 submit 就被重试并暂停

`src/core/node-turn-driver.ts:107–120` 仅有 submission 才 done；`src/core/node-executor.ts:202` 附近未区分聊天与任务。即使 required=[]，聊天正常回复但不提交也被视为失败。

违反 §4、§2：直接聊天可只回复、不调用 submit。应根据执行来源及显式输出要求判断完成，不使用“提交存在”作为所有执行的唯一完成条件。

### F3 [P1] 常驻进程跨调度 tick 丢失，跨 graph 同名节点又共享进程

`src/core/task-runtime.ts:566` 的 graphs 回调每次重新构造 kernelGraphLane，丢失 hosts/sessions 注册表。`src/runtime/kernel-graph-lane.ts:205` 在单个 lane 内却只按 nodeId 缓存 host，configPath 也只用 nodeId。`src/core/execution.ts:511–513` 会遍历同一 lane 的多个 graph。

因此后续 tick 不能保证沿用常驻进程；两个 graph 同名 worker 又可能复用首个 graph 的进程、会话、workspace 和闭包绑定的 submit 目标。

违反 §7 与子 graph/graph 实例隔离。宿主应拥有持久注册表，以 graphId+稳定节点身份作为 key，配置文件也按实例隔离，并在结束/删除时释放。

### F4 [P1] 配方能力只保留名字，实际只给 submit

`src/runtime/kernel-graph-lane.ts:185–195` 仅提供 submit，nativeTools/skillPaths/piExtensionPaths 等均为空；`src/runtime/kernel-node-host.ts:107` 关闭 capability operation。`src/core/task-runtime.ts:645` 拒绝全部非 submit 调用。

违反 §5：最小聊天/产物工具与配方实际能力必须可调用。当前不能据此验收 worker 的代码工作能力、能力加载或 agent 互相聊天。须连接已解析能力的真实执行资源与宿主工具，并管理其生命周期。

### F5 [P1] 动态禁用边不影响当前执行随后发生的首次提交

`src/core/kernel-store.ts:365–389` 用 execution.revisionVersion 读取边集合。节点配置冻结与连接修订冻结被混为同一版本。

违反 §8：当前执行节点配置固定，但边变化对后续 submit 生效。额外临时DB已复现。应在提交受理事务读取当前连接修订，同时保留当前 execution 的节点配置版本。

### F6 [P1] 模块广播不整体校验，也不原子受理

`src/core/module-router.ts:78–97` 逐边 recordModuleDelivery，之后另外 enqueue 或 setModuleInput，无整体 value 协议校验/事务/outbox。单条成功后下一条失败可部分投递，崩溃可留下 Delivery 而无 Queue。

违反 §6“模块广播同样原子受理”。应先验证全部输出/终点，再一次事务写 transition、投递和消费队列；需要异步时使用持久 outbox，恢复去重。

### F7 [P1] 完成请求遇到阻塞后失去输入关闭与撤销语义

`src/core/graph-runtime.ts:169–171` 把 completing 改为 blocked；chat/deliver 只拒绝 completing/completed，withdrawComplete 也只接受 completing。额外临时DB已复现。

违反 §8、§15.6。completionRequested 应独立于可运行/阻塞状态持久保存，或保留等价状态表达；阻塞不能丢失完成意图。

Spec：7 项新增高置信缺陷。最严重是初始输入未交付，以及跨 graph 同名节点共享执行上下文。

## 交接已承认且核实存在的交付缺口

- 默认用户路径仍可不带 v2 definition，继续旧内核；新内核存在不等于产品已切换。
- 阶段 7 UI 未交付：边历史/value、模块判断状态、格点和稳定布局、多独立聊天窗口缺正式用户路径验收。
- 停止流程及结束进程的联动尚未完成；不能以库级 GraphRuntime.stop 方法存在算产品完成。
- 自定义模块进程内存硬上限未实施；memoryCapMb 只转换为 --max-old-space-size。模块仍获 scratch 写权限及较宽读取路径，不能声称满足“禁止文件访问/启动其他进程”的完整隔离契约。
- 提升器仍不能完整处理 container，故 73 个文件分类数字只是某轮测量，不是无损迁移或产品能力完成证明。此次未重跑其批量切换分类，不确认数字继续有效。

## verifier 与合并冲突不应因迁移困难自动删除

spec §9 明确测试/验证/合并实现为模块或子 graph；§12 不废除 Git 合并条件；§13.6 保留原 Git 验收门。因此保留对应可观察行为已有规格依据，不必再次让用户为“是否还需要基本验收与合并”兜底决策。

可以删除旧 verifier 数据结构和旧执行器，但应以新模块/子 graph 重表达已确认能力，并迁移行为验证。若确要降低产品能力，须提出具体行为变化并取得用户对齐；不能仅因旧测试无法机械迁移就删测试。

## 返工顺序

1. 统一正式输入与 prompt 传递，允许纯聊天结束；让 scripted/真实路径共用输入契约。
2. 修宿主常驻注册表与跨 graph 身份隔离，接通配方能力和聊天/产物工具。
3. 修提交连接版本、模块整体广播与完成意图持久化。
4. 修真实视图统计，完成停止/进程回收和自定义代码隔离。
5. 将旧验收、Git 合并/冲突能力用新模块重表达；迁移保留行为的测试。
6. 完成用户 UI 与新内核默认入口切换，按 §14 运行真实公开入口验收。

上述每项修复需有修前失败、修后通过的针对行为的证据；最后再跑完整门禁。验收后再更新阶段进度表，不能先以“阶段 1–6完成”为前提修阶段8。
