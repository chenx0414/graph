# M2–M7 独立验收

日期：2026-09-12。结论：**未通过，不能确认首版 M0–M7 已完成。** 同日修复与复验见 [acceptance-rework.md](acceptance-rework.md)。下文保持验收当时的记录，不回溯改写。

审查基线为 M1 `19511f7e377d98ebbd482301b02951030fba5870`，被验收版本为 `d0193bbf2587093d16fdd6e97bc667bbb81b9959`。后者比 handoff 中的 `751e5da` 多一个交接文档提交。固定比较为 `git diff 19511f7...d0193bb`，覆盖 M2–M7 六个里程碑及交接文档。

本次按 [产品规则](../graph-mvp.md)、[实施计划](../implementation-plan.md)、[架构](../architecture.md) 与相关 ADR 验收。里程碑报告中的“已完成”是待核对的声明，不能替代原出口。代码规范和规格符合性由独立审查分别核对；下方两轴不合并排名。没有修改产品代码或原有测试，也没有改动 MediaBookmarks 原仓库、读取环境文件或调用收费模型。

## 已复验的检查

使用项目 Node `v24.20.0`，在 Graph 根目录执行：

| 检查 | 实际结果 | 能证明的范围 |
| --- | --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 通过 | 主 TypeScript 配置覆盖的代码 |
| `./node_modules/.bin/vitest run` | 26 个文件、107 项测试全部通过 | 既有用例的行为断言 |
| `./node_modules/.bin/vite build` | 通过 | Web 可构建 |
| `./node_modules/.bin/tsc -p tsconfig.web.json --noEmit` | **失败，退出码 1** | App.tsx 的两处导入及 main.tsx 的一处导入报 TS5097；前端配置缺少 `allowImportingTsExtensions` |
| `git diff --check` | 通过 | 已跟踪变更的空白检查 |
| 本次额外诊断 | 下列反例均复现 | 公开 Task Runtime、HTTP、真实临时 SQLite/Git、本地 provider 与 Playwright |

主 `tsconfig.json` 没有覆盖 `.tsx` 文件，`pnpm check` 也没有调用前端配置。前端类型错误作为检查结果记录，不重复计入人工 Standards 发现。

完整诊断代码与本次输出保存在 [acceptance-evidence](acceptance-evidence/README.md)。这些程序打印观察结果，退出码 0 表示诊断完成，**不表示产品行为正确**。

## Standards

### ST-01 · P1 · Git 重检清除了仍需核对的实例阻塞

位置：[src/git/integration.ts:186–191](../../src/git/integration.ts)。文档要求：[architecture.md:125](../architecture.md)：“待核对并暂停该 Agent”，“核对后再重新发起并累计”。

公开入口复现：审查调用第一次返回 `usage:null`，实例变为 `blocked`，产生 `unknown_usage`。另一个独立工人稍后完成集成，`invalidateChecks()` 为检查后继创建新激活并无条件写入 `pending`。没有任何用户答复，审查次数就从 1 增至 2，状态变成 `succeeded`，旧问题仍为 `open`。

这不是仅有 UI 状态错误：第二次 Agent 调用实际发生。应使 Git 引起的失效遵守同一持久阻塞与重新激活规则。证据：`unknown-usage-recheck.mts` 的 `beforeLate/afterLate`。

### ST-02 · P1 · 目标在其他工作副本检出时仍裸更新引用

位置：[src/git/integration.ts:112–125](../../src/git/integration.ts)。文档要求：[architecture.md:141](../architecture.md)：“已检出时必须同步处理 index/worktree”，“不裸更新 ref”。

公开入口复现：项目根目录检出 `other`，另一 linked worktree 检出目标 `main`，其中保留人工修改。交付仅检查根目录的当前分支，随后 `updateRef(main)`。Graph 报告 `completed`，但目标工作副本没有交付的 `feature.txt`，`git status` 出现 `D  feature.txt`。人工 README 修改还在，但 HEAD 与 index/worktree 已不一致。

应枚举工作副本，在目标实际检出位置检查干净状态并执行快进；目标脏时等待处理。证据：`core.mts` 的 `TARGET_WORKTREE`。Spec 轴也独立发现此问题，见 SP-08，不把它算成两个不同缺陷。

### ST-03 · 判断性建议 · 失效与重新激活逻辑重复

[integration.ts:189](../../src/git/integration.ts)、[graph.ts:176](../../src/core/graph.ts)、[revision.ts:89](../../src/core/revision.ts) 都维护“失效证据、创建激活、重置节点”的转换。后两者保留特定阻塞，Git 路径漏掉了同类保护，导致 ST-01。这是可能的 **Duplicated Code**，建议统一内部状态转换，让 Git 模块只提供受影响节点和提交；不是单凭文件长度提出拆分要求。

Standards：**2 项文档规则违反、1 项判断性建议**；最严重等级 P1，涉及未知用量后继续调用及目标工作副本一致性。

## Spec

### SP-01 · P1 · 生产 Pi 没有接通自主主管与工作能力

涉及 M3 G09–G11、M5 对话流程。[pi-adapter.ts:51–59](../../src/runtime/pi-adapter.ts) 打开 Pi 时没有注入工作工具或 supervisor/catalog 通道，只把最后文本作为 `completed` 输出；[pi-instance.ts:106](../../src/runtime/pi-instance.ts) 禁用了内置工具。传入的 `catalog` 没有用于装载实例能力。

配置生产 master 后，通过 HTTP `begin → runReady → say → runReady`，本地 provider 只收到一次无工具请求。结果为 `master=succeeded`、`phase=discussing`、`proposalVersion=0`、无待处理问题。既不能形成提案，也没有被第二条用户消息重新唤醒。工人同样不能通过当前生产入口读取/修改代码或复用安装的能力。

违反 G11：“自主拆解并并行执行；不需要用户复制上下文”，及产品要求“主管可自主搜索、安装新 Skills、MCP、扩展”。需要把受控工作工具、主管提案/修订、库能力和持续对话接到生产实例，再从用户入口验证。证据：`runtime.mts` 的 `production-master`。这不是因为测试用了替身而判失败，而是实际生产 adapter 路径没有相应能力。

### SP-02 · P1 · 生产请求门没有在每次请求前落实预算和未知用量

涉及 M3、M6 A06。[task-gate.ts:12–19](../../src/runtime/task-gate.ts) 忽略 `_reservation`，只检查暂停；`settle()` 累计到内存，整个 prompt 结束才向外层结算。

两个本地 provider 反例：首次模型响应包含工具调用且 `usage=null`，Pi 仍发第二次 HTTP，结束后才出现 `unknown_usage`；首次报告 20,000,001 token，同一 prompt 仍发第二次，最终累计 20,000,051 才阻塞。工具不存在也会触发 Pi 的后续响应，因此不需要额外注入真实工具才能复现。

违反产品规则：“达到上限禁止新调用”“用量缺失标为待核对并暂停该 Agent”。应在每次 invocation 结算及准入时更新、检查同一正式额度和阻塞记录。证据：`runtime.mts` 的 `missing-usage-multicall`、`budget-multicall`。

### SP-03 · P1 · 自动合并没有必需的独立审查通过门

涉及 M4 G13、M6 A11。[execution.ts:536–545](../../src/core/execution.ts) 只要求节点执行完成和 acceptance 证据，没有要求存在绑定当前提交的独立审查通过证据。

公开反例 `work → check → review`：reviewer 定义为 `review:true`，返回 `outcome=completed`、`output.verdict=fail`、具体阻塞原因，任务仍完成并把代码合入目标。没有 review 节点的普通 `work → check` 图同样可以交付，既有 M4 测试也使用这种图。

违反：“自动合并必须通过验收项、相关回归检查和独立审查”。修复应建立明确且不可省略的结构化审查门与提交绑定；不能仅改成猜测任意 JSON 中的 `verdict` 字符串。证据：`core.mts` 的 `FAILING_REVIEW`。

### SP-04 · P1 · 图修订允许降低已确认的验证规则

涉及 M2 G06/G08。[revision.ts:23–33](../../src/core/revision.ts) 固定 acceptance 数组，却允许替换该数组引用的检查节点及其 verifier 配置。

用户确认 `correctness.required=true` 后，主管把同一维度改成 `required=false`，修订被接受。评审仍返回失败，最终却得到 `outcome=pass` 的有效证据并合并，`graphVersion=2`。

违反：“降低或删除验收要求需使用者确认”。应冻结验收语义涉及的检查动作、验证规则和必要依赖；不是仅比较验收项的 ID/文字。证据：`core.mts` 的 `WEAKEN_DIMENSION`。

### SP-05 · P1 · 审查模型排除漏掉程序节点之前的实现者

涉及 M3 G09、M4 G13、M6 A07。[execution.ts:234–237](../../src/core/execution.ts) 仅读取 reviewer 直接依赖节点的 `models_used`。

公开反例：模型目录只有 `writer`，reviewer 明确 `review:true`，图为 `work → program check → review`。直接依赖的 check 没有实例，排除集为空，实现与审查都选择 writer，任务完成且无 `model_unavailable` 问题。

违反：“对应审查避开参与过该轮实现的模型，无合格候选时暂停该节点。”应按对应执行轮次、产物/提交来源获得实现模型集合，穿过程序节点与容器。证据：`core.mts` 的 `SAME_MODEL_REVIEW`。

### SP-06 · P1 · 旧人工确认会为新提交签发通过证据

涉及 M4 G13、M6 A11。[execution.ts:275](../../src/core/execution.ts) 仅查询同任务同节点是否曾有 resolved 的 `human_check`，没有绑定激活、输入版本或提交。

目标前移触发集成重检后，人工检查节点执行两次，却只有一次用户确认；第二次直接为新提交生成有效证据并完成合并。

违反 G13：“代码、测试或目标分支变化使不适用证据失效”，以及人工检查项等待用户的规则。应使确认与用户实际检查的输入绑定，失效后重新提问。证据：`core.mts` 的 `STALE_HUMAN`。

### SP-07 · P2 · 评委有合格胜者仍因落选方案失败返工

涉及 M2 G08、M6 A04。[verification.ts:202–206](../../src/core/verification.ts) 把任一候选的硬性条件失败加入整个决策的 blockers。

公开反例：a 满足硬条件、b 不满足，排名已选出 winner=a，但输出仍为 rework，任务被问题阻塞。

违反：“评委式先检查硬性要求，再按预定标准排名；全部不合格则返工。”单个候选不合格应将其排除，保留失败说明；仅在没有合格候选或存在针对胜者的阻塞时否决。证据：`core.mts` 的 `JURY_ONE_INELIGIBLE`。

### SP-08 · P1 · 目标在其他工作副本检出时未保护工作现场

涉及 M4 G13、M6 A11。Spec 审查独立复现了 ST-02：目标工作副本脏时未进入 `git_dirty`，仍更新目标分支并声称交付。违反 G13 的目标工作区保护及最终交付一致性要求。位置：[integration.ts:112–125](../../src/git/integration.ts)，证据：`core.mts` 的 `TARGET_WORKTREE`。与 ST-02 为同一缺陷。

### SP-09 · P1 · Web 无法处理额度等必需人工问题

涉及 M5 G14。[App.tsx:91–94](../../src/web/App.tsx) 把预算、权限、用量未知、返工等问题统一转换成 acknowledge；等待问题则固定回答 `ok`，没有用户输入。

浏览器实测：预算不足后点击“答复”，HTTP 返回 `400 invalid_answer`，budget 问题继续 open，页面没有输入追加 token 数量的入口。对应内核明确要求 `add_budget`；其他类型也需要各自参数。

违反 G14“待处理问题”与产品的额度追加/问答流程。需要按问题类型呈现有效答复表单和错误反馈。证据：`ui.mts` 的 `budget_reply`；其他类型为代码核对，未声称全部逐一做过浏览器复现。

### SP-10 · P2 · 图页和节点详情不随运行更新

涉及 M5 G15、M6 A12。[App.tsx:139–140](../../src/web/App.tsx) 仅在 task ID 改变时加载图与操作，没有事件订阅或刷新。

真实浏览器中先打开 pending 图，后台完成任务后，公开 Runtime 已是 completed，页面节点仍显示 `work pending`。图修订、费用、产物和后续调用也保持打开页面时的快照，直到重新进入页面。

违反产品的运行状态展示与 G15 的运行观测出口。证据：`ui.mts` 的 `graph_stale_after_completion`。

### SP-11 · P1 · M7 当前证据不能证明 Graph 自主完成真实任务

涉及 G17–G18/A13。[tests/m7/adapters.ts:34–69](https://github.com/chenx0414/graph/blob/d0193bbf2587093d16fdd6e97bc667bbb81b9959/tests/m7/adapters.ts#L34-L69) 使用写死的任务图和预写文件，工人把 fixtures 复制进工作副本；review 只检查源码中几个字符串；usage 为固定数字。[delivery.test.ts:71](https://github.com/chenx0414/graph/blob/d0193bbf2587093d16fdd6e97bc667bbb81b9959/tests/m7/delivery.test.ts#L71) 由测试代替用户 acknowledge 登录，没有真实登录或页面验收。

这些测试证明了编排、复制、检查及合入机制，值得保留。但 G18 要求“Graph 自行拆解……实现、检查、独立审查……”，产品完成标准还要求真实任务验收。结合 SP-01 的生产路径断开，不能把此脚本视为已完成自主开发证明，也不能用同一脚本生成的用量充当真实调用记录。

问题不在于使用克隆或未发布；隔离副本可以作为交付目标。缺的是生产 Agent 实际完成任务，以及已确认功能真实可用的证据。应把当前 M7 结果标为 scripted 机制演练，补齐生产路径后再执行真实任务验收。原产品范围未授权用 scripted 演练替换 A13。

2026-10-07 迁移说明：M7 的交付、production、冻结与 CLI 合同已手动改用原生 Graph v2，旧 adapters / proposal 支持文件退役；上面的链接固定在当时的验收提交。当前本地 HTTP / 预写内容 / 合成用户确认的测试仍不能代替自主开发和真实登录 A13 验收。

### SP-12 · P2 · B站页面缺少登录前置与采集中进度

涉及 M7 G17/G18。[fixtures/m7/web-server.js:64–102](../../tests/fixtures/m7/web-server.js) 启动采集前不检查登录，等待 CLI 全部结束后才返回；[index.html:43–58](../../tests/fixtures/m7/index.html) 只在首次加载及 POST 完成后刷新，采集期间没有轮询或推送。

用交付代码和真实配置模块，在全新临时目录把外部 CLI 替换为慢速本地响应：`loggedIn=false` 仍成功启动；后端 `/api/job` 为 running，页面仍为 idle。真实 CLI 分支还只记 0/1 到 1/1，没有消费 stdout 进度。

违反已确认的“确认 B站登录状态 → 发起采集 → 查看进度与失败原因”流程。应落实登录准入、异步任务启动和持续进度展示；fixture 一次返回 done 的用例无法覆盖这个阶段。证据：`media.mts` 的 `collect_without_login_and_no_live_progress`。

### SP-13 · P2 · 已有笔记只能列文件名，不能浏览内容

涉及 M7 的 browse-notes 验收项。[fixtures/m7/index.html:49–50](../../tests/fixtures/m7/index.html) 只将文件名写为 li，没有链接或阅读器；[web-server.js:120–126](../../tests/fixtures/m7/web-server.js) 也没有笔记内容或静态文件入口。

浏览器实测：页面列出 fixture.md，链接数为 0；请求 API 返回的 `output/bilibili-notes/fixture.md` 得到 404。原测试只断言 notes 数量非零，因此错误地将“列文件名”当成“浏览已有笔记”。

违反 G17/G18 的收藏与已有笔记浏览要求。应提供受限的笔记读取接口和可阅读内容的界面，再从浏览器验证。证据：`media.mts` 的 `notes_not_browsable`。

Spec：**13 项发现，9 项 P1、4 项 P2**；最严重等级 P1，涉及生产任务闭环、调用预算与合并验收规则。其中 SP-08 与 Standards 的 ST-02 是同一缺陷，不叠加为独立数量。

## 里程碑验收判定

| 里程碑 | 判定 | 本次否决依据 |
| --- | --- | --- |
| M2 | 部分实现，未通过 | 验证规则可被主管降低；评委部分候选失败的决策错误 |
| M3 | 未通过 | 生产主管/能力未贯通；逐请求预算及未知用量阻断缺失；审查模型排除不完整 |
| M4 | 未通过 | 合并缺少独立审查门；旧人工确认可复用；其他工作副本目标及未知用量重检问题 |
| M5 | 部分实现，未通过 | 关键人工答复流程不可用，图状态不更新；另有前端类型检查失败 |
| M6 | 不能确认 A01–A12 全部通过 | 新反例击穿 A04/A06/A07/A10/A11/A12；107 项通过不能推导覆盖矩阵全部成立 |
| M7 | scripted 演练可复现，真实任务未通过 | 自主实现证据缺失，交付页面仍有可复现功能缺口 |

## 再次验收需要的证据

1. 把上述公开入口反例转为保护预期行为的回归测试，补齐生产逐调用与结构化审查/授权边界。
2. 用生产 Pi 走完整用户流程：讨论、提案、确认、独立副本编码、检查、不同模型审查、必要返工、合并；记录实际 invocation 与使用量，受控本地模型可继续用于机制测试。
3. 从 Web 完成额度追加和实际问题回复，后台状态变化实时投影到图和详情；主检查命令覆盖前端类型检查。
4. 修复 B站页面后，在约定隔离资源下验收真实可运行流程；需要真人完成的登录/检查绑定对应任务与输入，不能由 fixture 确认代替实际结果。
5. 复跑受影响用例及完整套件，按固定版本重新两轴审查，再更新里程碑完成声明。当前报告没有替产品修改状态或创建新的里程碑。

本次只增加验收报告与诊断证据，保留使用者原有 `.gitignore` 和历史 `m2-handoff.md`。没有提交这些新增文档。
