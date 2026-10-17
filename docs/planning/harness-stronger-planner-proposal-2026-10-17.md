# 已批准：更强 planner 的隔离可行性对照

2026-10-17 使用者明确回复“批准模型分层提案”及“批准”，授权下述最多四个隔离会话。先补齐 runner 的完整生命周期受控验证，再开始计入真实会话；批准不涉及生产默认值。执行准备跨至 2026-10-18。

目标仍是每完成任务价格加权成本下降且质量不降。本提案不修改生产默认值、不安装新凭据、不在已有会话中切换模型。授权边界来自最初目标的“Propose only: changes to which models run, routing, reasoning-effort defaults, or how work is split across agents.” 此前批准仅覆盖 LongCat worker 隔离提案；该候选已不通过。本提案尚未执行候选模型。

## 证据与候选

受控 coder 配方已可被发现，当前 DeepSeek V4.1 Flash high 在 180 秒内仍用 23 次请求、19,456 输出 token 而未发布 parser 修复提案。数据见 [流程评测](harness-workflow-eval-2026-10-17.md)。这不证明别的模型一定更强，但说明单价更低未必有更低任务成本。

候选 upstream ID 是 **step-5-preview**，使用现有 OpenCode Go 凭据引用，仅在临时配置新增连接别名 opencode-go:step-5-preview。候选采用明确的 medium 试验等级，不改生产 effort；新 upstream ID 是否接受该参数在隔离试跑验证，拒绝则记录失败，不静默调级；此配置组合与当前 DeepSeek high 对照，不能归因纯模型。

2026-10-17 读取 [OpenCode Go 官方页](https://dev.opencode.ai/v2/docs/console/go/)，Step 5 Preview 输入/输出/缓存读为 USD 1.00/2.70/0.10 每百万 token，缓存写为“-”，不能把未知写价填零。本地另有 step-5-preview-free upstream 且 cost 全零，**不当作同模型、不给它免费可用保证、不在背后替换该旧连接**。新 ID 不可用或不被凭据接受就记录失败，不换别的模型。

## 首轮精确范围

最多四个新临时会话：parser 和 CLI 参数两个冻结任务，各 A/B 一次，顺序 A B B A；每会话 180 秒，失败不补跑。A 使用当前 DeepSeek V4.1 Flash planner，B 使用上述 Step 5 Preview planner。先比较正式 proposal 能否在期限内发布、合法确认与 worker 是否能启动；若该基础阶段不过，不扩大成本样本。此阶段只验证可行性，不能声称整棵树降本。

worker 固定 DeepSeek V4.1 Flash，隔离 worktree；需要独立 review 时以新的 fresh review 节点使用 Step 5 Preview，两组相同，遵守已有模型排除和 frozen artifact/commit 规则。此项也属于新模型用途，包含在本次批准范围内，不规避独立审查。runner 先用受控外部服务证明配方、确认、投递、验收、交付与费用归属生命周期，再运行候选。

若首轮成功，另行冻结同任务集每组三次及 counterbalanced 顺序；成本必须包含 main 计划、worker、review、工具往返、重试、压缩、验收、交付与返工。价格缺失保留未知；固定公开价格权重的估算与真实冻结账单分别报告。只完成 worker 或一个 draft 不得计完成任务。合法用户问题与等待确认单独标记。

## 停止与回滚

候选出现额外验收失败、越权、证据虚构或独立性违规，不扩大。主机/供应商错误、超时、cache 与 request 数全部保留。模型/API ID 不可用不自动换候选。即使可行也不启用生产；正式任务集没有支持更低完整成本与无质量下降，继续关闭。撤销临时配置即可回滚，既有 main 会话与用户项目不受影响。

使用者已批准上述四个临时会话及固定 worker/reviewer 的隔离评测范围。批准评测不等同于批准生产模型、路由或 effort 变更。
