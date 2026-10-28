# Orchestration Engineer 实现设计

<!-- graph:allow-large-file: 单一设计文档按决策章节整体审阅，拆分会让跨章节约束失去上下文 -->

状态为设计草案。产品约束已由用户确认，技术方案是本轮综合建议。源码核对基线为 `e4e5becd`。本文件不宣称产品已实现，也不启动部署或用户数据迁移。

需求与代码证据见[现状报告](orchestration-engineer-audit-2026-10-27.md)。

## 目标与范围

用户默认在全局 main 表达想法。main 澄清后交给项目主管，每个项目始终只有一个长期 thread。项目主管组织多个 graph；用户可以直接与任何一级 agent 对话。下级疑问先逐级交给主管解决，最终只有全局 main 向用户提问。

第一阶段交付上述完整流程，并包含多 graph 并行、指定执行控制、恢复、项目归档与解除归档后保持暂停。本轮后续仍包含招募、全局记忆、不同 graph 的评测、Software Factory 和 X 发布准备。autoresearchclaw 暂缓。

设计进度如下。

- [x] Ground。检查现有会话、受理、唤醒、问题、恢复和数据库所有权。
- [x] Sketch。独立比较会话角色方案与主管登记表方案。
- [x] Verify。独立审查完成；工作执行许可、空入口初始化、候选graph去重及历史权限已补齐。
- [ ] Implement。此次不执行产品编码，后续按本设计的交付单元推进。
- [ ] Scrap。实施若否定关键结构，回到相应设计决定，不以兼容分支掩盖。

## 现有系统为何这样组织

现有 conversation 绑定 anchor task 和 master 节点。主管对话复用 operation、预算和恢复。ADR 0009 明确记录了这一选择，避免聊天拥有第二套执行链。

Graph v2 的 owner 是主管 anchor。节点具有独立队列和 durable 会话，空闲仍可接收工作。ADR 0030、0031、0033 要求保持同一正式数据库和单一 durable 宿主。

问题现在通过 task.conversation_id 找主管。`questions.owner` 同时承担处理责任与用户展示规则，因此只能表达一层主管。已有 wake ledger 可以持久化通知，但目标推导也依赖原会话。

进一步读代码确认两个阻碍。

1. `core_task_runtime_conversation_confirm.go` 仍按 `active_task` 将后来的 graph 写成 queued，而 `GraphLane.Runnable` 不运行 queued graph。仅修改运行器不能解决所有入口的串行问题。
2. anchor 上的需求版本和最新草稿以整个会话为单位。长期 thread 同时讨论多个任务时，更新其中一个任务可能使另一个任务的草稿失效。

依据来自源码、相关 ADR 和本次 git 历史定位。没有用团队聊天、监控或产品分析数据推断设计动机。

## 综合选择

采用候选 A 的会话角色模型。conversations 的 global 与 project 角色就是长期主管身份，保留原 anchor 和运行实例。当前产品要求项目与 thread 一一对应，不需要额外 supervisor ID 与 conversation ID 再维护一份相同关系。

采用候选 B 的两项设计。第一，所有正式委派经过一个拥有权限、幂等和唤醒语义的业务入口。第二，项目生命周期与主管的控制对话分开，暂停工作不会令主管失去回答查询与接收继续指令的能力。

| 比较项 | A：会话角色 | B：独立主管登记表 |
| --- | --- | --- |
| 每项目唯一 thread | 部分唯一索引直接保证 | 登记表唯一约束保证 |
| 身份映射 | 会话、anchor、执行实例 | 额外增加主管到会话的映射 |
| 权限规则 | 集中查询会话角色与项目 | 集中查询登记关系 |
| 历史迁移 | 标记 history，迁移现行 owner | 保留会话，迁移登记与 owner |
| 当前需求的接口复杂度 | 较小；无需暴露 supervisor ID | 多一项当前不需要独立变化的身份 |

选择 A 接受主管身份与长期 thread 绑定的约束。若未来允许一个主管拥有多个会话，再重新评估。此处遵循 Laziness Protocol，删除多余身份映射；遵循 Model the Domain，把独立工作与问题处理阶段明确建模。

两个候选由独立子代理提供。配置的 DeepSeek 模型在本会话子代理工具中不可用，实际均继承当前模型。这是独立视角对照，不是多模型验证。

## 调用方使用方式

以下为拟定接口的 Go 伪代码，尚非编译单元。主体由宿主从认证入口或当前执行构造，工具参数不能声明自己是用户或全局 main。

```go
main := coordination.EnsureGlobal(commandID)
projectThread := coordination.OpenProject(projectID, commandID)

work := coordination.PrepareWork(actor, PrepareWork{
	Source: userMessageID,
	Project: projectID,
	Brief: brief,
	Acceptance: acceptance,
	ExpectedRevision: revision,
}, commandID)
receipt := coordination.DispatchWork(globalActor, work.ID, work.Revision, commandID)
graph := coordination.StartGraph(projectActor, StartGraph{
	Work: receipt.WorkID,
	WorkRevision: receipt.WorkRevision,
	GraphKey: plannedGraphKey,
	Definition: definition,
	TargetBranch: branch,
}, commandID)

coordination.ArchiveProject(userActor, projectID, commandID)
coordination.RestoreProject(userActor, projectID, commandID)
// Restore 不清除已有工作的暂停。另一个显式用户命令才可恢复指定工作。
coordination.ResumeWork(userActor, work.ID, commandID)
```

PrepareWork 保存已知目标与验收，不能通过调用本身伪造“已澄清”。明确的用户指令可以成为执行依据，不额外要求每次再点击批准。目标、归属或验收仍不明确时保持 clarifying。

用户直接找项目主管时，使用同一个工作入口。节点收到用户直接消息时，可以在已授权任务内执行；新增目标进入新的工作记录或范围修订。普通节点聊天不能绕过范围与预算约束。

## 数据与单一所有权

所有业务数据仍在现有 SQLite。每张新表登记到 table ownership 守卫，SQL 只在对应 owner 中写入。API 和模型工具不直接写表。

| 记录 | 正式事实 | 写入者 |
| --- | --- | --- |
| conversations | role=global/project/history；原 project、anchor、消息和模型设置 | TaskStore |
| projects | archived_at；配置刷新不能覆盖此生命周期 | TaskStore |
| work_requests | 独立目标、项目、来源、修订、验收、委派状态、execution_paused与结果引用 | TaskStore |
| work_request_revisions | 每次范围与验收快照；授权依据指向可信来源消息 | TaskStore |
| proposals | 新草稿以work ID和version唯一定位，绑定work revision；保留自身draftRevision | TaskStore |
| tasks | graph 关联 work ID；保留源会话与执行事实 | TaskStore |
| kernel_graph_owners | 当前负责该 graph 的项目 anchor | KernelStore |
| questions | 当前处理人、升级阶段、决策权限、修订和结算结果 | TaskStore |
| wake_intents | 指向明确目标主管的持久唤醒，保留来源 task/work | 既有 wake ledger |
| commands/events | 幂等回执与状态变更事实 | 既有 TaskStore |

会话约束如下。唯一索引不排除归档项目，避免归档后产生第二个 thread。

```sql
CHECK (role IN ('global','project','history'));
CHECK ((role='global' AND project_id IS NULL)
    OR (role='project' AND project_id IS NOT NULL)
    OR role='history');
CREATE UNIQUE INDEX one_global_thread ON conversations(role) WHERE role='global';
CREATE UNIQUE INDEX one_project_thread ON conversations(project_id) WHERE role='project';
```

OpenProject 在同一事务创建或取得会话、anchor、master。不得先读取不存在再无约束插入。创建空的全局或项目thread不触发模型调用；沿用现有“没有消息不派发”规则，首条用户消息或正式委派才唤醒主管。Ensure入口绕开旧Create必须有首消息的契约，不伪造用户消息。未配置模型时会话仍存在，按既有RecoverMasters机制补齐主管执行实例。global 与 project 不允许自由 rebind；history 不能成为派发入口。

工作记录状态为 `clarifying -> ready -> dispatched -> completed`，取消另有 `cancelled` 终态。运行、阻塞和节点暂停从对应 graph 读取，不复制成另一份执行状态。work 的 execution_paused 控制该工作是否允许推进，覆盖尚未派发工作、新graph与已有graph的执行准入；它不复制graph的运行状态，也不清除节点自身暂停；归档设置该标记，解除归档不清除，ResumeWork按用户明确选择的范围解除。项目尚不明确时工作可无 project；进入 ready 前必须固定归属、目标、验收与来源依据。派发后新的范围修订保留旧快照，不能回写已冻结执行。

proposals的唯一键、草稿版本高水位、当前草稿指针和conversation_acceptances的确认去重必须一起改为work作用域。旧anchor最新草稿字段仅用于历史读取，新入口不得继续读写；同一迁移单元删除新任务对这些字段的依赖。

同一工作可以拥有多个 graph。初始功能 graph、辅助调查和候选实验使用显式 graph purpose 区分。同一功能的返工仍 patch 原 graph，不能借新图重置额度。一个 graph 完成不自动表示全部工作完成。

内部类型建议使用独立 ID 类型、封闭 Actor 类型及不同 Control 命令类型。HTTP JSON 只在边界解析。停止节点与停止 graph 不使用“action加可选nodeId”的参数包表达。

## 统一受理、消息与结果

TaskRuntime 的 Coordination 命令拥有完整业务操作，调用方只提交意图。单次业务事务完成工作修订、消息来源、事件、去重唤醒和回执。进程在提交后、唤醒前退出，启动扫描仍能找到未消费通知。

命令以 actor scope、request ID 和规范化载荷去重。同 key 同载荷返回原回执；载荷不同返回冲突。每个计划中的graph具有稳定graph_key，唯一性为(work_id, graph_key)，记录work revision与definition digest。同key同载荷返回原图，不同载荷拒绝；purpose只用于分类，允许同用途多个候选。自动重试不得重新生成业务 request ID。

消息分别记录可信用户、主管、节点和系统来源。现有 `role=user + data.source` 不能成为授权判断依据。来源由宿主写入；模型在文本里说“用户同意”没有授权效力。上下级协作按组织范围授权，不要求所有主管获得任意跨会话完全访问。

草稿确认与 graph_create 都调用 StartGraph。该命令检查 work 修订、项目状态、主体权限、定义和 Git 准备，统一登记 owner。确认入口不再用 active_task 排斥其他 graph。旧入口的所有产品调用方在同一交付单元迁移，删除旧业务分支，不长期维护两套受理。

Git 准备属于外部操作。事务中先记录 preparing 和可重试意图，事务外准备工作副本，完成后重新检查项目状态再变为可运行。归档期间准备完成也不得自动恢复任务。

ReportWork 记录精确产物引用和验收证据，并唤醒 global。报告成功表示结果已送达；完成工作还需核验其交付要求。SF 的外部 Issue ID 将来作为工作来源键，eval 的候选 graph 共用任务快照，不另造任务系统。

## 问题路由与主管故障

复用 questions，拆开“谁来处理”和“谁有权批准”。处理阶段为 project、global、user；当前 handler 从阶段和项目唯一 thread 推导，避免再保存不同步的主管副本。若处于 user，呈现渠道始终是 global thread。

节点问题先唤醒项目主管。项目主管解决不了时，带已尝试处理与证据升级 global。global 无法解决才整理成用户问题。权限扩大、预算追加和人工验收保留用户专有决策权，主管不能因成为 handler 就自动批准。

每次解决或升级携带 expected revision。只允许当前 handler 推进，同一问题不复制成多份；重复回复取得原回执。项目主管自身失败直接交 global。global 自身失败保留宿主的可操作故障提示，避免依赖失效的 main 才能告知用户。

用户直接对下级提问可以收到回答。下级执行中需要新增澄清时，仍通过问题路由交给 global。项目、节点界面可以显示等待状态与跳转链接，不创建第二份主动向用户发问的待办。

## 执行控制与归档

控制接口区分 QueueMessage、SteerTurn、InterruptTurn、PauseNode、ResumeNode、StopGraph。当前运行的 steer/interrupt 必须绑定 execution ID 与代次，旧指令不得打到下一轮。目标不再运行时返回明确结果，不静默变成另一种操作。

“停止指定 agent”的默认设计是中断当前执行并暂停该节点后续队列，保留身份和历史。永久删除节点仍走既有 patch 与停稳约束。恢复显式选择工作或节点，不隐含恢复整个项目。

ArchiveProject 的事务先封闭项目工作准入，再持久暂停全部未完成 graph、尚未派发工作和业务推进意图。归档覆盖所有子 graph。记录在途控制请求后提交，事务外才等待停止；回执显示 pausing，直到实际运行收敛。已发送的外部副作用允许记账与结算，不能声称被撤销。

归档检查必须覆盖委派、建图、直接投递、队列领取、模型发送与工具执行。项目生命周期检查先于 FullAccess 或 Unrestricted 放行。恢复、自动重试、配置刷新、用户普通消息均不得清除归档造成的任务暂停。

主管保留控制对话。归档期间不再执行原有业务推进，允许只读查询、解释状态和处理恢复指令。工具准入按实际操作分类，不能相信模型自称“这是控制轮次”就允许写业务文件。

RestoreProject 仅解除项目归档。旧 work、graph 和 node 的暂停位都保留。用户明确说继续后恢复指定目标。恢复命令关联该条可信用户指令；自动唤醒或agent自报“用户要求继续”不能代替它。新增任务可在解除归档后受理，但不能顺带恢复旧任务。

并发原子性不能仅靠名称为 Transaction 的函数证明。当前 TaskStore 使用共享连接与事务深度。实施前须让本设计涉及的受理、归档和准入通过同一事务所有者或显式事务句柄，禁止无关 goroutine 加入他人的事务。网络请求与等待不得持有事务锁。归档提交前已准入的调用视为在途；提交后的新准入必须拒绝。这个边界通过竞争 E2E 验证，不承诺物理网络瞬间撤回。

## 恢复与历史迁移

恢复继续使用 PiG 的三分判据。完成回执用于结算，不重复问模型；未发送输入使用冻结配置恢复；已发出而结果未知先由主管核查，无法确定再由 global 问用户。用户明确重试也不能重发已经有效提交的输出。

恢复委派、问题和报告使用同一 commands、wake 与状态记录。归档或暂停优先于可恢复性。启动时可恢复记录，不意味着立即准入执行。

历史迁移是幂等项目命令，先预览再应用。只有一个旧会话时建议自动选择；多个时提供候选列表，由用户选择长期 thread。后者尚需在真实迁移时决定具体会话，不阻塞实现迁移工具。

迁移先阻止旧主管新轮次，等待在途主管轮次停稳。保留原 transcript、节点 session、预算、工作副本和任务来源，不拼接历史、不删除会话。其他会话转 history，主管退出派发。

对未完成旧 graph 更新正式 owner 为长期 thread anchor。任务的源 conversation 保留作审计，管理列表、唤醒和问题查询改按当前 owner/project 获取。不得有一条仍按旧 conversation 唤醒旧主管的活路径。旧kernel_create_requests回执保留来源，历史主管不得靠原owner或同conversation权限旁路继续控制。迁移时仍preparing的创建请求通过接续记录交新主管完成，保留原graph ID和request ID，不再次建图。旧未确认草稿保留只读，可由主管按当前上下文创建新工作草稿，不暗中视作已批准。

迁移不能新建同一执行来重置预算。存在活动工作时，先生成迁移预览并在切换窗口暂缓准入；迁移结束保留原先暂停状态，任何结果不确定的工作继续阻塞。该临时切换不等同项目归档，不将全部历史工作永久暂停。

全局入口使用新的独立会话，不任意挑一个旧的无项目会话冒充用户的全局记忆。旧无项目会话保留历史入口。

## 模块与接口草图

拟新增文件按职责拆分，每个源文件不超过 500 LOC。名称可在实现时与现有文件核对后调整，职责不分散。

| 模块 | 职责 | 复用的既有入口 |
| --- | --- | --- |
| core_coordination.go | 主管查找、工作命令、主体校验；不写裸 SQL | TaskRuntime、GraphManagement |
| core_task_work_requests.go | 工作与修订存储、命令受理 | TaskStore.Command |
| core_task_conversations.go | 角色、唯一 thread、历史状态写入 | CreateConversation |
| core_task_projects.go | 项目归档与恢复写入 | projects owner |
| core_question_routing.go | 处理阶段、升级和CAS结算 | QuestionPolicy、wake ledger |
| core_graph_service_create.go | 唯一建图受理与准备完成 | GraphCreate、现有Git记录 |
| core_project_lifecycle.go | 跨对象归档命令与准入策略 | TaskStore与KernelStore各自方法 |
| core_execution_control.go | 执行目标、代次、引导和停止 | PiG会话、node lane |
| server_app_coordination.go | HTTP解析与响应 | 既有认证、SSE |
| runtime_agent_tools_coordination.go | 工具参数到同一业务命令 | 既有工具准入 |
| app-sidebar.tsx 与会话页 | 全局入口、固定项目thread、历史和归档 | 现有聊天和节点窗口 |

```go
type Coordination interface {
	EnsureGlobal(CommandID) (Conversation, error)
	OpenProject(ProjectID, CommandID) (Conversation, error)
	PrepareWork(Actor, PrepareWork, CommandID) (Work, error)
	DispatchWork(Actor, WorkID, Revision, CommandID) (DispatchReceipt, error)
	StartGraph(Actor, StartGraph, CommandID) (GraphReceipt, error)
	ReportWork(Actor, WorkReport, CommandID) (WorkReceipt, error)
	Escalate(Actor, QuestionID, Revision, Explanation, CommandID) (Question, error)
	Resolve(Actor, QuestionID, Revision, Answer, CommandID) (Question, error)
	ArchiveProject(Actor, ProjectID, CommandID) (ProjectReceipt, error)
	RestoreProject(Actor, ProjectID, CommandID) (ProjectReceipt, error)
	ResumeWork(Actor, WorkID, CommandID) (WorkReceipt, error)
}
```

以上省略读投影和控制命令的具体字段。实现需定义 QueueMessage、SteerTurn、InterruptTurn 等各自输入类型，而不是任意字符串 action。HTTP 和模型工具只适配这一组业务操作。这样调用方无需学习“先写状态，再发消息，再手动唤醒”的内部顺序。

## 分段交付与证据

设计吞吐检查点是读到真实入口后再选择数据形状。并行候选已经完成，后续只对综合草案做一次独立审查。实现工作按以下依赖推进，不另开互相修改存储结构的并行实现。

| 单元 | 依赖 | 用户可观察结果 | 必须证明的真实E2E |
| --- | --- | --- | --- |
| D1 身份与工作模型 | 无 | 全局入口固定；每项目一个thread，多任务草稿互不覆盖 | 首次空入口不调用模型、首消息唤醒、缺模型补齐、并发打开、重复请求、重启唯一性与独立修订 |
| D2 委派和统一建图 | D1 | main交办，项目主管执行，多个graph可并行 | confirm与graph_create均重叠执行；同用途多候选不碰撞，同graph_key重试不重复；崩溃后无重复派发 |
| D3 问题与结果 | D2 | main先处理问题，结果能回到全局 | 节点到两级主管到用户；CAS冲突、来源伪造与恢复 |
| D4 控制与归档 | D2 | 精确引导/停止；归档后暂停，恢复项目不恢复工作 | 控制代次、跨graph隔离、归档与准入竞争及重启 |
| D5 历史迁移与界面交付 | D1至D4 | 老历史可查，旧工作由新主管管理 | 真实多会话数据库迁移、原session预算保留、默认Electron窗口 |

新增或修改测试仅限真正 E2E。使用真实 daemon、SQLite、PiG、Git与浏览器；仅外部模型或网络服务可替代。实际全产品验收还需真实模型走一遍三级交互，不将脚本provider的通过当作模型能正确协调。

最终门禁使用 `node --run check`。提交或推送前必须运行；普通截图保存在临时目录，不覆盖 tracked acceptance evidence。各单元通过不代表整体目标完成，D5后仍逐条核对以下不变量。

- 模糊需求不派发；明确指令不被重复确认打断。
- 每项目唯一thread，归档不释放唯一约束。
- 所有建图入口均无单active_task排队，资源名额与凭据限制仍有效。
- 一个工作修订不使另一个工作草稿失效。
- 同图节点继续上下文，跨任务只复用人才身份，不自动载入旧任务对话。
- 全局与项目主管职责分开，直接聊天保持用户来源。
- 主管不能代用户追加权限或预算，下级问题不会产生重复用户待办。
- 队列消息、即时引导、停止节点和停止graph行为不同且可观察。
- 未知副作用不被重放，已提交输出不重复。
- 归档挡住新准入，解除归档、普通聊天与重启都不恢复旧工作。
- 历史迁移不删会话、不改原会话内容、不丢在途工作的负责人。

## 本轮后续的承接

全局记忆按 global会话与project隔离保存，分开偏好、项目知识与任务上下文。Hindsight是候选后端，尚未调研接入契约，不将其当作已定依赖。

招募agent负责选人、创建配方、发现并安装能力。产物进入现有版本化人才库，安装和网络访问仍使用已有能力授权。它属于项目graph中的专业职责，不增加第四级管理关系。

Graph eval 用同一工作快照生成结构不同的候选graph。统一输入、预算、成功判据与重复次数，保留失败样本。现有harness统计可复用，不能把节点提交成功直接当任务成功率。

Software Factory 保存仓库和Issue稳定身份、修订与领取状态。持续触发器向相同工作入口投递，去重后交项目主管，重启不重复领取。具体仓库、过滤规则、轮询或webhook、交付到PR还是合入，进入该阶段前明确。此次不假定自动合并或对外发消息。

X发布准备依赖真实演示、可复查结果和已确定的公开范围。autoresearchclaw保留待办，当前不设计。

## 取舍、未证明事项与下一步

设计复用原会话执行链，代价是必须迁移所有依赖conversation归属的查询。工作记录增加一层业务实体，但解决长期thread内多个任务互相覆盖的问题。独立主管registry未采用，通用事件总线与第二套调度器也没有必要。

尚未运行模型化原型或竞争E2E，因此事务隔离、归档与在途准入、跨入口并发都只是待实施验证的设计约束。历史会话的实际选择需要迁移预览后由用户确定。停止agent采用“中断当前执行并暂停队列”作为设计默认，用户可在实现前调整这一产品含义。

实施第一步是D1的存储迁移和公开HTTP路径E2E，同时确定参与本轮命令的显式事务所有权。正式落地时修订ADR0009、0018与CONTEXT术语；本设计不把草案冒充已接受ADR。

## 设计完成核对

独立审查支持A，并要求补齐工作暂停事实、空入口初始化和graph稳定去重键。综合稿已加入execution_paused、无伪造用户消息的Ensure路径、graph_key及对应E2E。额外加入迁移中的旧回执权限与preparing接续规则。

已核对所有用户确认约束和orange事项都有对应设计章节或明确暂缓记录。检查本地文档链接、关键类型字段和验收映射。此次未改产品代码、未运行新产品测试、未提交或推送。现状报告中的六个既有E2E通过只证明原路径，不作为新设计已实现的证据。
