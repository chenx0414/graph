# Graph 实现架构

当前架构依据 [Graph v2 定稿规格](specs/graph-rebuild-v2.md)、[产品范围](graph-mvp.md)、[ADR 0030](adr/0030-graph-v2-interface-delivery-kernel.md)与 [ADR 0031](adr/0031-pi-durable-agent-kernel.md)。Graph 领域编排使用 TypeScript，main 与节点的 Agent 执行迁移至 pi-durable 1.1.0，共享 SQLite、本机 HTTP/SSE 和 React/React Flow。迁移交付状态见 [验证进度](agent/pi-durable-migration-evidence.md)，默认应用切换仍需最终验收。历史 M0–M7 架构不再是当前 graph 执行模型；[进度记录](agent/issue-1-implementation-progress.md)与 [退役审计](agent/issue-1-old-kernel-removal-audit.md)区分实际证据和剩余工作。

## 职责与正式对象

main 是外部拥有者，管理多个 graph，规划与协调工作。Agent 节点执行具体任务；具名接口定义协议；边保存连接；Delivery 保存一次发送；模块判断与映射输出；产物保存稳定成果。子 graph 复用定义，并展开为同一内核中的独立节点、模块与接口映射。

graph 不从节点成功状态推断依赖就绪，不使用特殊 loop 执行路径，不把容器完成状态当作子 graph 输出。聊天与接口输入共用节点串行队列；普通前向流与返工使用相同边；each 与 once 共用模块状态和 transition。

| 模块 | 正式 interface | 内部责任 |
| --- | --- | --- |
| 声明与协议 | 整体解析定义、精确协议连接 | 子 graph 展开、引用解析、字段和规则校验 |
| KernelStore | 修订、提交、投递、队列、执行、模块状态 | 共享数据库事务、唯一约束、去重和可恢复事实 |
| Graph Runtime/Service | create、patch、inspect、send、control | 归属、修订冲突、生命周期、工作清空与通知 |
| Graph Runner | 推进已受理工作 | 节点并发、模块串行输入、transition/outbox 恢复 |
| Node Executor/Driver | 运行一条队列输入 | 冻结配置、初始或复跑 prompt、补交、重试与不可撤回提交 |
| Durable host/transport/lane | 稳定会话、持久输入收据、模型与工具任务 | 单一 Harness、冻结执行配置、受控凭据与工具装配、checkpoint 恢复 |
| Module Runtime/Broker | each/once、重开、自定义规则和宿主操作 | 输入最新状态、代码隔离、资源上限、命令副作用与恢复 |
| Catalog/Artifact/Git | 版本化配方、发布成果、代码集成 | 能力发现、不可变内容、作者权限、commit 与最终验收 |
| HTTP/Web | 查询、命令和可恢复 SSE | 正式图投影、稳定布局、独立聊天与按需历史 |

## 持久状态与事务

新内核使用 TaskStore 的同一个 SQLite 数据库。kernel revisions、submissions、deliveries、queue、executions、module inputs/transitions、outboxes、provider calls 与 lifecycle 保存 graph 的执行事实；原项目、main 会话、能力库、配方、模型、预算与产物基础设施继续复用。

submit 事务先核对 execution、有效提交唯一性、本节点输出与全部启用终点协议，再写入提交、投递与接收队列。没有部分广播。同 execution、同提交身份与内容重放返回原回执；异内容拒绝。当前连接修订在受理时冻结，后来删除边不撤销已接收工作。

模块输入按受理序号串行处理。判断、状态更新和 transition/outbox 的持久边界允许重启继续广播而不重复判断或投递。自定义代码和外部命令不在 SQLite 事务中执行。

大型 JSON 由 [kernel-content.ts](../src/core/kernel-content.ts)保存不可变正文、摘要与字节数，正式记录保存引用。提交、投递、队列、模块状态、operation 请求/结果和公开结果的生产读取还原原值；内容与业务引用在同一事务写入。兼容读取既有 inline JSON，不批量改写用户数据。概览 SQL 只读大内容元数据，精确详情查询再取全文。

SSE 传递可恢复的事件与引用，公开结果通过 resultId 主动查询。节点日志保留完整正文，但默认页和 node.entry 事件对大记录发送摘要；按 entryId 查询时验证其 task/node 归属。全文读取不修改 Agent 会话或正式工作队列。

## 进程、配置与能力

main 与所有 graph Agent 节点使用同一个 durable Harness，分别具有稳定会话身份。空闲节点不占 Graph 执行名额，返工沿用原会话与累计预算；没有从另一节点 transcript 派生 graph 节点的公开配置。工具扩展可以在受限辅助进程中加载，该进程不执行第二套 Agent 循环。

当前 execution 固定节点配置、配方、工作位置和模型事实。下一次执行采用最新修订；恢复已受理输入时重装原执行的模型、能力资源、工作位置与权限，保留原输入收据、会话、身份与累计额度。接收时协议和执行时配置分别记录，不把旧输入悄悄解释成新协议。

配方与节点分责：配方提供身份、规则、Skills/MCP/extensions/工具；节点提供任务、验收、接口和运行选择。system prompt、有效工具及其运行预览由同源装配生成；GUI 区分已发送配置与下一次配置，不把声明能力冒充实际加载成功。

节点工作位置可以是项目、准备好的独立 worktree 或其中的目录；显式 worktree 不可静默回退到项目。目录规范化核对真实路径、范围与符号链接。权限、网络和受保护路径受宿主上限约束，不能通过配方或 patch 扩大授权。

main 保留自己的会话与 operation 基础设施，位于 graph 外部；它的结束不由 graph 生命周期控制。Agent checkpoint 与执行恢复由 durable 负责；Graph 保留业务命令、未知用量、模块副作用与 Git 收据的核对，不另设 Agent 恢复器。

## 模块隔离与副作用

规则表达式只处理声明的输入、状态和输出，不执行任意字符串代码。once 锁存与输入状态独立；重开只解除锁存，等待下一次输入。不存在隐含清空、容器调度器或独立工具节点。

自定义代码模块使用隔离执行环境与 CPU、内存、进程、超时、stdout 等上限；宿主拒绝异常或不合协议的输出，保留输入供 main 处理。workspace.command 通过受控 operation broker 运行，记录 prepared/dispatched/settled/uncertain 等发送边界、资源回执、真实结果文件与 digest。已经 settled 的结果从正式存储复用，不重跑命令；未知副作用不能被自动重试掩盖。

默认先自动重试未提交执行 2 次，缺失输出补交 1 次，分别累计并跨重启保留。提交成功后下游可以立即工作，因此提交不可撤回，执行恢复不能再次发送原输入。权限、额度或未知副作用需要明确处理，而不是换一种方式派发。

## 并发、预算与统计

main 与多个 graph 共用全局 Agent 执行名额，最多 10 个正在执行。credential gates 按实际凭据身份限制调用；等待与实际执行分别计时。模块命令占其自身的运行资源，不冒充 Agent 名额。

预算从持久调用事实计量，保留 reservation、in-flight、usage、来源、费用和模型身份。有限额度不把未知消耗计为零；不限额度允许明确标记的估算。复跑、恢复、换模型和配置重绑都不重置消耗。工具调用统计按实际事件计数，provider 重用 call ID 不得吞掉第二次调用。

模型目录支持 small、medium、frontier 与保留的历史 grade 别名。选择使用当前配置的候选、偏好和已记录模型排除事实；实际调用配置冻结，后续配置修改不重写历史 usage 或价格快照。

## Git、共享产物与验收

不可变 artifact 版本属于 graph，子 graph 共用顶层空间；文件、文本、JSON 发布保留来源、作者、修改者与精确引用。普通节点只能修改自己的成果，main 负责协调并可修改全部成果。

代码产物包含真实 commit；worktree 只是访问位置。Git 集成是显式受控路径，最终验收由 [graph-acceptance.ts](../src/core/graph-acceptance.ts)核对真实 check、独立 review 与人工确认。通过状态的路由缓存不更新旧审查的 commit。

最终合入绑定已验证的集成提交。目标变化、脏工作区、未检查的集成提交与未满足验收都要保留现场，不能裸更新 ref 或覆盖人工修改。非代码 graph 仍可完成，不隐含要求 Git 交付。

## 界面与查询

ELK 负责原生对象位置，持久布局快照与局部修订保持已有锚点；[orthogonal-routes.ts](../src/core/orthogonal-routes.ts)在统一格点上避开可见实心节点。展开容器边界透明；折叠子 graph 成为显示边界，使用同一走线算法重新连接外部边，不改变位置或运行事实。

子 graph 公开接口来自实际映射，显示精确名称、协议版本和内部端点；不能从扁平边猜造公开接口。折叠隐藏内部线，保留外部业务连接与跨边界聊天，详情仍显示原始投递和实际聊天双方。展开恢复原路线，嵌套折叠状态独立。

边与模块详情分页显示持久历史及来源、协议、缺失输入、条件结论、实际输出和重开。节点打开独立窗口，显示真实 prompt、会话、队列、工具、产物、累计 token 和时间。大内容显式读取后立即显示历史全文，后台摘要刷新不覆盖全文。

## 当前代码导航

- 定义、持久模型与生命周期：[interface-spec.ts](../src/core/interface-spec.ts)、[kernel-store.ts](../src/core/kernel-store.ts)、[graph-runtime.ts](../src/core/graph-runtime.ts)、[graph-service.ts](../src/core/graph-service.ts)。
- 执行与恢复：[graph-runner.ts](../src/core/graph-runner.ts)、[node-executor.ts](../src/core/node-executor.ts)、[node-turn-driver.ts](../src/core/node-turn-driver.ts)、[kernel-recovery.ts](../src/core/kernel-recovery.ts)。
- Pi 与能力：[kernel-graph-lane.ts](../src/runtime/kernel-graph-lane.ts)、[kernel-node-host.ts](../src/runtime/kernel-node-host.ts)、[agent-context-assembly.ts](../src/runtime/agent-context-assembly.ts)、[capability-library.ts](../src/catalog/capability-library.ts)。
- 模块：[module-runtime.ts](../src/core/module-runtime.ts)、[module-router.ts](../src/core/module-router.ts)、[module-evaluator.ts](../src/runtime/module-evaluator.ts)、[kernel-operation-broker.ts](../src/runtime/kernel-operation-broker.ts)。
- 产物与 Git：[artifact-workspace.ts](../src/core/artifact-workspace.ts)、[graph-acceptance.ts](../src/core/graph-acceptance.ts)、[Git 模块](../src/git/git.ts)。
- 投影与界面：[kernel-views.ts](../src/core/kernel-views.ts)、[kernel-explain.ts](../src/core/kernel-explain.ts)、[node-run.ts](../src/core/node-run.ts)、[layout.ts](../src/server/layout.ts)、[GraphCanvas.tsx](../src/web/GraphCanvas.tsx)、[AgentNodeChat.tsx](../src/web/AgentNodeChat.tsx)。

## 切换与验证边界

ADR 0030 要求所有 graph 入口统一走新内核，旧 graph 及其历史丢弃，旧 DAG、特殊 loop、转换器和旧历史 reader 退役；不删除能力库、模型配置、外部 main 会话或整个数据库。ADR 0011 的每 operation Pi 生命周期已被每节点常驻替代；旧 Fresh/Fork/依赖 handoff 图模型不再适用。历史报告保留证据，不重新授权旧行为。

库级与集成门禁证明其覆盖的行为，不能单独证明默认用户应用已经切换。最终交付还需重建当前包、验证实际 Electron 窗口与默认运行来源，并按完整规格逐项核对。执行说明见 [实施计划](implementation-plan.md)；尚未完成项必须明确保留。
