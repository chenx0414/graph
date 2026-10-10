# Graph 重构 v2：设计与实施规格（定稿）

日期：2026-10-01。状态：产品契约及第 15 节九项选择已由用户逐项确认；实施方案由 main agent 按本规格细化。本文供 main agent 进行 RSI 构建，不代表已实施或已验证。正式规格在 GitHub Issue 管理，本文件为可阅读的工作副本。

切换决策补充：使用者随后确认丢弃旧内核及旧 graph，不保留转换器或旧历史 reader，见 [ADR 0030](../adr/0030-graph-v2-interface-delivery-kernel.md)。以下第 11、13 节按此决策更新；基础设施与外部 main 会话继续保留。

## 1. 指导思想

Graph 是 main agent 创建、拥有和管理的协作运行空间。main agent 位于 graph 外部，可以管理多个 graph；完成 graph 不结束 main agent 会话。

从第一性原理分配职责：agent 执行任务；接口定义交互；边定义连接；投递承载一次信息；模块执行控制逻辑；共享产物保存稳定成果；子 graph 复用结构。可视化直接投影这些正式对象，不能另造一套推测出来的执行图。

奥卡姆剃刀：初次输入、后续输入、聊天共用串行队列；前向流、返工共用普通边；普通路由与汇合共用模块机制；子 graph 不引入独立调度器；公开工具隐藏事务、恢复和状态管理。替换旧机制，不在 dependsOn/when/loops 上再叠加投递调度。

## 2. 已确认的产品契约

- Agent 节点 = agent + 具名逻辑接口；视觉上只有一个入口和出口。
- 配方定义身份、规则、能力；节点定义任务、验收、接口、工作位置、预算和实际模型。
- 每个节点一个独立常驻 Pi 进程，直到 graph 结束；一次执行结束后保留进程与会话。
- 同节点执行串行，一次投递触发一次执行；忙时排队，空闲时执行。多输入汇合由模块承担。
- 直接聊天也排队触发执行；只回复不必 submit。聊天不得中途注入正在执行的 turn。
- 每次执行最多一次有效 submit，可提交多个输出；未出现的输出等价于 enable:false。
- enable:false 不形成投递、不触发节点、不覆盖模块输入。业务不通过为 enable:true 且 value.passed:false。
- submit 先校验整体，全部通过后发送；失败给简洁字段级错误并允许修正，不消耗有效提交机会。
- submit 选择本节点输出接口，向所有启用连接广播。提交与执行结束独立。
- 已成功提交不可撤回，不因执行失败或恢复重复发送。
- 输入协议由终点定义。连接启用状态、本次输出开关、业务判断分别表达。
- 模块每个输入保留最新一次有效投递；没有收到与收到 false/null 是不同状态。
- 触发策略 each 每次有效输入更新后判断；once 条件满足后触发一次，仍接收后续输入更新。
- once 显式重开只解除已触发状态，保留输入，等下一条投递再判断。暂不提供清空输入状态的操作。
- Agent 通过声明的控制输入请求重开；main agent 可直接管理。重开不是普通 agent 的隐含权限。
- 已接收投递不因删除或禁用边而取消；取消是独立操作。Agent 配置变更默认下一次执行生效。
- main agent 可直接投递到节点具名输入，遵守同一协议与队列。
- 模块内置小规则表达式，也允许 main agent 编写扩展代码；不保留独立工具节点。
- 子 graph 显式映射公开输入输出，不执行额外 agent，也不隐含等待所有内部节点。
- 子 graph 复用定义、实例独立：会话、队列、路由状态互不共享；产物空间属于顶层 graph。
- 产物支持文件、文本、JSON；已发布版本不可变。修改产生新版本，记录作者和修改者。
- Agent 只能修改自己的产物，可读取其他已发布产物；main agent 可以修改所有产物。
- 代码产物必须引用稳定 commit，worktree 是访问位置；审查记录实际审查版本。
- 通过状态可保留，但不能自动成为新 commit 的有效审查证据；最终验收检查精确版本。
- 执行异常先自动重试，失败后保留输入并暂停本节点队列，由 main agent 处理。
- 必需输出由节点配置声明；缺失时自动报错补交，仍失败则标记未满足交付要求。
- graph idle 不等于 completed。main agent 显式完成或完成出口提出请求，等待执行和队列清空；stop 明确取消剩余工作。
- 每个 agent 可独立打开聊天窗口；system prompt 完整透明可见。

### 节点工作环境的声明格式

节点可选 workspace:{base:"auto"|"project"|"worktree",path?:string} 与 access（现有 AccessPolicy，mode 必需，其他字段按模式补默认值）。默认自动选择已准备的私有 worktree，否则项目根；显式 worktree 要求 targetBranch。path 是已存在的根内相对目录，禁止词法及符号链接越界。实际权限不得超过宿主授权，受保护路径继续适用。执行与补交冻结环境，修改在下一执行生效；重绑保留身份、历史、预算，运行快照公开实际工作位置和权限。配置拒绝保留本次输入并暂停节点，不盲目自动重试。

## 3. 正式对象与身份

GraphDefinition 是声明式结构，GraphRevision 是不可变修订；GraphInstance 是一次运行。NodeInstance、ModuleInstance、SubgraphInstance 使用稳定路径身份，例如 build/reviewer，不随名称或图版本变化。

Edge 保存 id、from、to、enabled；Delivery 保存 id、graphId、edgeId 或直接投递来源、from/to、value、协议版本、接收图版本、时间、因果 submitId、队列序号与状态。边无单一可覆盖的权威 value；latest 仅是查询投影。

Execution 保存 id、输入投递或聊天记录、节点配置版本、attempt、状态、submitId、开始结束时间。Submission 保存 executionId 唯一约束、内容摘要、输出集、回执。ModuleTransition 保存输入更新、状态前后、判断结果、输出、规则版本和原因。

保存 definition 与 instance 的区别，不能用 graphId 混指模板和运行。大型 value 用内容引用存储，界面分页读取，不塞入 SSE 全量快照。

## 4. 声明式 interface

JSON 是唯一正式定义格式；创建、局部修改、持久化及可运行导出均使用结构化 JSON。YAML 仅用于文档示意，不支持直接导入；具名 map、稳定 edge ID、统一 schemaVersion。最终字段命名由 main agent 在实施前固定，避免两套语法并存。

```yaml
schemaVersion: 2
name: implement-and-review
protocols:
  code-result:
    type: object
    required: [repository, commit, artifact]
    properties:
      repository: {type: string}
      commit: {type: string}
      artifact: {type: object}
  review-result:
    type: object
    required: [passed, reason, reviewedCommit]
    properties:
      passed: {type: boolean}
      reason: {type: string}
      reviewedCommit: {type: string}
nodes:
  worker:
    recipe: worker@1
    task: 实现功能并根据审查意见返工
    acceptance: [满足确认需求, 完成约定检查]
    inputs:
      task: {protocol: implementation-request}
      rework: {protocol: review-result}
    outputs:
      result: {protocol: code-result}
    submission: {required: [result]}
  reviewer:
    recipe: work-reviewer@1
    task: 审查收到的具体 commit
    acceptance: [结论附理由与审查版本]
    inputs:
      code: {protocol: code-result}
    outputs:
      review: {protocol: review-result}
    submission: {required: [review]}
modules:
  review-route:
    type: router
    trigger: each
    inputs:
      review: {protocol: review-result}
    outputs:
      rework: {protocol: review-result}
      approved: {protocol: review-result}
    rules:
      - when: review.passed == false
        emit: {rework: review}
      - when: review.passed == true
        emit: {approved: review}
edges:
  worker-review: {from: worker.result, to: reviewer.code, enabled: true}
  review-route: {from: reviewer.review, to: review-route.review, enabled: true}
  rework: {from: review-route.rework, to: worker.rework, enabled: true}
inputs:
  task: {to: worker.task, protocol: implementation-request}
outputs:
  result: {from: review-route.approved, protocol: review-result}
completion: {on: result, drain: true}
```

implementation-request 必须在实际定义中完整声明或引用精确协议版本；示例不作为可运行 fixture。输出 schema 声明生产者承诺，目标输入 schema 是接收权威。连接两端必须引用相同协议 ID 与版本，避免不可靠的任意 schema 子类型推断；提交仍按全部目标校验。需要不同协议时插入显式映射模块。

规则支持存在性、字段取值、布尔与或非、比较、对象构造与输入转发。禁止 eval 执行规则字符串。多个匹配规则的输出按声明顺序合并；同一输出冲突拒绝定义。once 多输入规则必须显式写 requiredInputs，避免缺失字段被当 false。

必需输出意味着本次任务提交必须 enable:true。互斥输出需要 requiredAnyOf 等明确约束，而非全部 required。聊天默认无必需输出，可主动提交；成功提交也遵守一次限制。

## 5. 工具与管理 interface

Agent 最小宿主工具：submit、直接聊天，以及产物 list/read/publish。其余工具按配方实际能力暴露。直接聊天显示可点击 agent 身份链接，调用使用稳定目标 ID，不能依赖显示名称。

```js
submit({outputs: {
  review: {enable: true, value: {
    passed: false, reason: '缺少异常处理', reviewedCommit: '…'
  }}
}})
```

宿主绑定 executionId 和发送者，模型不得自行伪造。工具错误包括 code、接口/字段 path、expected、got 和修正方式。tool call 成败及原因写入聊天与执行记录。

Main agent 建议公开四类入口：graph_create(definition)、graph_patch(graphId,baseRevision,changes,reason)、graph_inspect(graphId,query)、graph_control(graphId,action)。输入投递与聊天复用通用 send 工具。control 包含 pause/resume、retry/skip/cancel、reopen、complete/stop；完整 schema 按需文档查阅，避免低频工具常驻占位。创建返回验证后的定义、revision 与 graphId，禁止部分创建成功。

## 6. 投递与事务

submit 在一个短事务中校验当前执行资格、有效提交唯一性、输出与所有启用终点协议，冻结当前连接修订，写 Submission、全部 Delivery、队列与事件。全部持久受理后才回成功；不在事务内执行模型、模块代码或外部命令。

同 executionId 同内容重放返回原回执，不产生新投递；异内容拒绝。一个坏终点导致整体拒绝，不能部分广播后才报错。没有启用连接的输出，按自身协议校验通过后成功记录提交，返回 no_recipients 提示和 0 次投递，仍满足该接口的必需输出要求。graph 公开输出映射算接收方；后续新增连接不自动补发历史输出，补发须由 main 明确发起新投递。

模块输入按 graph 受理序号串行处理；计算与发送以可恢复 transition/outbox 提交。模块广播同样原子受理。each 会逐次判断，包含历史已保留输入；once 已触发时只更新状态。重开只改变锁存标志，不能自行再次 emit。

投递只承诺持久受理和执行去重，不承诺外部命令副作用恰好一次。循环是普通连接，允许有向环；禁止无限递归展开子 graph 定义。无进展和预算限制独立监控，不能禁止合法返工环。

## 7. 队列、常驻进程与恢复

一个节点一个队列，聊天与接口输入按受理顺序处理。同一时间最多一个 execution；idle 进程不占执行名额。跨 graph 建议复用全局运行名额池，不能因多 graph 绕过限制。

初次执行 prompt 包含 graph 结构概述、其他节点摘要、任务、验收、具名输入协议、实际触发 value、submit 要求和实际能力说明。后续执行只提供新输入、必要配置变更和相关引用；不重复初次全文。完整 graph 按需查看，避免嵌套大图撑爆上下文。

system prompt 与实际有效工具集同源生成；独立窗口显示本次精确配置及下一次配置，不混淆预览与运行事实。

常驻 Pi worker 接受 start-turn/control/inspect，宿主仍掌握派发、usage 和正式状态。进程崩溃可重建，但节点身份、session lineage、队列、预算及提交记录不变。能力/身份配置更新若需重建进程，在 turn 之间受控重建并保留历史，记录 rebind。

已确认默认：首次未提交执行失败后最多自动重试 2 次，共 3 次尝试；缺失必需输出最多自动补交 1 次。graph 设置默认，节点可覆盖；两种次数分别计数，进程重启不重置。补交沿用同一 execution 和会话，注入结构化缺项说明，不重做已完成实现。已提交后禁止新的提交及重发原输入；剩余工作恢复失败交 main。

未知副作用先核查，预算耗尽和权限拒绝不盲重试。失败节点暂停自身队列，独立节点继续；main 收到原因、输入、attempt 和可用处理动作。

## 8. 动态修改与生命周期

patch 要求 baseRevision，整体校验并产生新修订；冲突返回当前版本。已接收 Delivery 的 value、来源和协议快照不变；边变更对后续 submit 生效。当前 execution 的节点配置固定；下一次 execution 启动时采用最新配置，用接收时协议解释旧输入，并明确记录两者版本。

存在运行中、排队或失败待处理工作的节点/模块不得直接删除，须先处理或显式取消，并等待当前执行停稳。删除尚有旧投递的具名输入也遵守此规则。仅保存历史输入状态的模块可删除。删除节点时结束 Pi 进程，原子移除其连接，保留聊天、投递、产物和执行历史。边可以直接删除，保留历史身份。禁止通过改名或新节点清空累计额度。

graph 状态区分 running、idle、paused、completing、completed、stopping、stopped、blocked。完成请求后关闭外部任务投递及触发执行的聊天，返回明确的 completing 错误，允许内部执行产生后继；main 可继续查看、处理失败、取消和停止，也可显式撤销完成请求恢复外部输入；队列、执行、模块待处理 transition 全部清空且无未解决失败后结束进程。blocked 不算清空；保留失败现场直到 main 处理。stop 取消队列并阻止新派发，核查在途调用，停稳后标 stopped。

公开输出记录业务结果并投递给 main；失败、需介入、完成与停止通知独立且去重。自动完成出口只发完成请求，不暗中代替最终验收或合并条件。

## 9. 模块扩展与子 graph

内置 router 与 command 模块共用具名输入输出、投递记录和诊断。测试/验证/合并实现为模块或可复用子 graph，普通 agent 工具调用不展开为 graph 元素。

自定义模块代码使用显式、版本化契约：evaluate({inputs,state,trigger}) 返回 {state,outputs,diagnostics}；重开为声明的控制输入。判断、汇合与映射代码在独立子进程隔离执行，只接收输入与状态、返回状态/输出/诊断，禁止直接访问网络、文件、凭据或启动其他进程。需要外部操作的模块经宿主 interface 与已有 operation broker 执行，沿用权限、预算及操作记录。默认单次 5 秒，输入和返回各 1 MiB，持久状态每模块 1 MiB，同模块串行。main 可显式调整并记录配置变更。超限、异常或非法返回保留输入、暂停模块并通知 main。必须有进程级内存硬上限，准确数值在 spike 中测量确定；JS 堆上限不代表整个进程内存限制。隔离必须实际验证，无法落实时明确报告，不退回宿主进程执行任意代码，也不在数据库事务或 Web 主线程执行。

子 graph 实例展开时生成独立稳定节点路径与状态；输入输出映射编译到统一连接模型，不产生额外执行。模板精确版本固定，修改模板不热改现存实例。顶层共享产物记录 producer、subgraphPath、version、digest、commit/repository 与可选 worktree。

## 10. 可视化与独立聊天

节点、模块、子 graph 使用不同外形与状态标记。16px 格点建议沿用，但节点尺寸、位置、端点和折点必须统一约束；边正交走线、避开节点、为回边和多条同端点边安排可分辨通道。

布局只在结构变化或显式重新布局时计算；投递、token、路由状态更新不移动节点。复用未变化位置，局部调整受影响区域；折叠子 graph 保留公开接口与跨组边，不隐藏外部关系。

选中边显示：具名端点、启用状态、输入协议、最新投递摘要、历史列表、精确 value、来源执行、接收状态、时间与产物链接。未投递不能显示成空 value。disable 与业务 false 显示不同。

模块详情显示：每个输入当前 value/来源/时间、缺失输入、逐条件真假或错误、each/once、已触发状态、重开记录、实际输出及历史 transition。不得只显示 succeeded。

点击 agent 打开独立聊天窗口，多个窗口可并存；含实时消息、排队消息、工具结果、当前 execution、完整 system prompt、有效工具、产物及累计 token/运行时间。窗口关闭不停止 agent。大 value 与日志分页、懒加载，SSE 断线可从游标恢复。

## 11. Codebase 对照与替换位置

已检查的依据：

| 位置 | 当前机制 | 处理方向 |
| --- | --- | --- |
| src/core/types.ts | NodeSpec.dependsOn/routes/when、ContainerSpec、LoopSpec | 新声明式 interface；退役旧 graph 字段，不保留旧图历史读取 |
| src/core/graph.ts | GraphPlan DAG 校验，GraphState 按成功状态计算 readiness/inputs | 替换为显式连接、Delivery、队列和模块状态 |
| src/core/router-action.ts | 单 case 的状态/字段/agent 自述路由 | 替换为多输入、多输出、触发策略与可解释 transition |
| src/core/revision.ts | 完整节点列表修订、验收锁定 | 保留修订和校验思想，提供局部 patch 和新版本生效规则 |
| src/runtime/agent-tools.ts | submit_result 校验后 onSubmit 回调 | 替换正式提交事务；不能把回调内记录结果当投递保障 |
| src/core/transient-retry.ts | 环境错误最多两次重试 | 复用分类与计数基础，加入提交前后与缺项补交语义 |
| src/core/node-messages.ts | 消息触发/reactivate 旧节点状态 | 统一写入串行工作队列 |
| src/runtime/pi-process.ts、pi-worker.ts、agent-session.ts | 每 operation 进程与会话 transport | 常驻 worker、多 turn、重绑与崩溃恢复 |
| src/runtime/agent-context-assembly.ts、src/core/node-prompt.ts | 上下文与 prompt 组装 | 配方/节点分责，初始与后续差量输入 |
| src/core/artifact-workspace.ts | 不可变版本、精确引用、发布工具 | 复用存储，调整 graph 归属/作者权限，补 commit 引用 |
| src/server/layout.ts | ELK、节点位置16px吸附，部分边不参与 ELK | 统一格点与路由，稳定布局投影 |
| src/web/GraphCanvas.tsx、src/core/node-run.ts | 图与节点详情 | 边历史、模块状态、独立聊天窗口 |

继续复用预算账本、调用记录、能力库/配方编译、模型目录、Git worktree、会话分页和 HTTP/SSE；接入新 graph 身份时检查实际耦合，不直接复制成第二套基础设施。

## 12. 与既有设计的差异

ADR 0004 的节点/实例一一对应及返工保留身份继续适用；ADR 0011 的每 operation 进程改为每节点常驻；ADR 0025 的不可变版本继续适用，权限调整为发布者与 main。

现有架构中“同轮汇合、旧结果不能满足新轮”改为模块保存最新状态、显式重开；最终验收版本匹配仍保留。旧容器完成状态不能用作新子 graph 隐含等待。

现有文档的“Agent 不生成能力”与本设计“main 编写模块扩展”需要明确区分：模块代码是 graph 程序逻辑，不自动等于新 MCP/skill 能力安装。模型 small/medium/frontier 目录与现有等级需迁移别名，不默默改变现存配方。

本规格不自动废除已确认任务的权限、预算、验收与 Git 合并条件。main 位于 graph 外部不意味着可以绕过全局运行名额与用量统计。

## 13. RSI 实施顺序

1. 固定类型、协议、状态转换与三份可执行定义：流水线、返工、双 reviewer 汇合；验证常驻 Pi 多 turn 与配置重绑可行性。
2. 新数据库 schema 与事务：Revision、Submission、Delivery、Execution、ModuleTransition；实现原子受理、去重和恢复。
3. 节点队列与常驻 Pi，接入聊天、配置版本、预算/统计；完成提交前后失败恢复。
4. router each/once、重开与规则表达式；命令模块接 broker；加入版本化代码扩展。
5. main 工具、声明式定义、局部修改、公开输出与完成/停止；子 graph 展开与复用。
6. 产物归属和 commit 审查引用；保留原 Git 验收门。
7. 图布局、边 value/历史、模块解释、独立聊天与 prompt 透明展示。
8. 按 ADR 0030 将所有 graph 入口统一切换到新内核，整体退役旧 DAG/特殊 loop 调度、转换器与旧图历史 reader；启动时丢弃旧 graph 记录。更新架构/术语/ADR/使用 docs，并验证实际默认应用交付。

同一 SQLite 数据库中的能力/配方、模型配置、外部 main 会话、预算与调用基础设施继续复用，不删除重建整个数据库。旧 graph 与其任务归属历史按 ADR 0030 整体丢弃，不等待旧内核运行、不归档转换、不保留历史 reader，也不重放已发生副作用。切换前列出删除模块及活跃引用，切换后以真实启动、原生 graph 执行与默认应用验证单一执行路径。

## 14. 验收与证据

- 三次同边投递产生三条记录、三次串行执行；忙时 A/C 和聊天按队列顺序处理。
- 多输出整体校验失败零投递；修正可成功；广播任一终点不兼容时全拒绝；回执丢失重放不重复。
- disable 不触发、不覆盖；passed:false 能触发返工。
- each 连续返工；once A通过/C失败后C通过触发一次，再次通过不触发；重开不立即触发，下一次投递才判断，保留A状态。
- 新输入覆盖旧输入；缺失输入与 false/null 可区分；模块判断和输出可回溯。
- 提交后崩溃，下游已受理且不重复；提交前有限重试；缺项补交仍受一次提交限制；失败保留输入并暂停队列。
- 常驻 worker 多 turn PID保持，idle释放执行名额；崩溃恢复同一会话与预算；配置变更在下一执行生效。
- 禁用/删除边不取消旧队列；旧协议快照可解释；patch版本冲突零局部变更。
- 两个子 graph 实例状态隔离；跨组产物可读；输出映射不等待其他内部节点。
- 新产物版本不改变旧引用；旧commit审查不会证明新commit。
- idle不完成；完成请求等待内部后继和模块事件清空；停止显式取消；失败不会假装完成。
- 自动布局包含流水线、扇出、汇合、返工、嵌套、多同端点边；节点/折点格点对齐且边不穿节点；运行更新位置不变。
- 边可查看历史value；模块显示等待/判断/触发/重开；多聊天窗口独立且关闭不停止进程；system prompt与实际运行一致。

以公开 interface 验证行为；磁盘 SQLite、真实临时 Git、受控模型与实际 Pi 进程分别证明对应契约。截图只证明布局，不能证明调度。实施中写测试遵循 test-audit；提交或推送前必须 node --run check，工程与证据规则见 [CODING_STANDARDS.md](../../CODING_STANDARDS.md#验证与交付)，检查操作见 [检查指南](../agents/checks.md)。

## 15. 已确认的九项选择与实施权限

1. JSON 是唯一正式格式，YAML 仅用于文档示意，不支持导入。
2. 边两端必须引用相同协议 ID 与版本；不同协议经显式映射模块转换。实际 value 仍在 submit 时整体校验。
3. 执行异常默认自动重试 2 次（共 3 次尝试），缺项补交 1 次；分别计数、可配置、重启不清零。已提交不重发；预算、权限和结果不明走对应处理流程。
4. 未连接输出校验成功即提交成功，提示 0 次投递，也满足必需输出；公开输出算接收方，新增连接不自动补发。
5. 有执行中、排队或失败待处理工作的节点/模块先处理或显式取消、停稳后删除；移除连接并保留历史。仅历史状态不阻止删除模块。
6. 完成期间拒绝外部新任务与执行型聊天，内部工作继续；main 可处理问题、停止或撤销完成请求。
7. 自定义判断代码独立进程隔离，禁止直接外部操作；5 秒、输入/返回各 1 MiB、状态 1 MiB、串行，限制可显式调整并记录。进程内存硬上限经实测细化，隔离实际验证；外部操作走宿主 interface。
8. main 可自主细化文件组织、内部函数、数据库索引、实现库及优化，但须满足已确认契约和验收。语法字段可以实施时固定，不能维护两套正式语法。
9. 改变投递次数、队列顺序、提交成功条件、重开、权限、默认重试次数或完成条件等产品行为，先给用户具体场景、原行为、新行为与原因并取得对齐。技术限制必须报告，不得包装为实现细节。

## 16. 给 main agent 的 RSI 交接说明

请读取本规格及关联 GitHub Issue，按仓库 AGENTS.md 规定读取领域、架构、实施计划、产品规则和检查文档。以已确认产品契约为准，对旧 ADR 的冲突显式更新，不沿用与本设计冲突的旧执行行为。

先完成常驻 Pi 多 turn、配置重绑、自定义代码进程隔离三个可行性验证，再按第 13 节交付垂直切片与后续能力。重构以接口投递为正式执行模型，复用会话、能力库、预算、产物和 Git 基础；不要在旧 dependsOn/when/loops 调度上叠加第二套执行真相。

每阶段在规格 Issue 记录改动、验收证据、限制和下一步。优先证明串行投递、原子 submit、去重恢复与 each/once，再完成动态修改、子 graph 和可视化。第 14 节是最低验收集合，第 15 节为已确认选择；实施时补充针对行为的必要验证，提交或推送前运行 node --run check。

本交接授权按已确认规格细化工程实现；出现产品行为变化，遵守第 15 节第 9 项先与用户对齐。不得声称本规格中的验收已经通过。
