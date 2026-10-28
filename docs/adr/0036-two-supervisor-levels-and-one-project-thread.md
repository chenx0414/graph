# ADR 0036：两级主管与每项目唯一长期 thread

日期：2026-10-28

## 状态

已接受。实现证据见 [Orchestration Engineer 实施记录](../planning/orchestration-engineer-implementation-2026-10-27.md)；2026-10-28 完整 `node --run check` 通过。

## 背景

[ADR 0009](0009-conversation-first-master-entry.md) 让每个会话拥有自己的 anchor 任务与主管，用户可以为一个项目开任意多个会话。那是“会话优先”的正确起点，但它把“用户管理会话”当成了产品前提。

现在的前提变了。用户只面对一个全局主管，由它把想法分给项目；每个项目只有一个长期 thread，由项目主管在该 thread 内组织多个 graph。若仍允许同一项目出现第二个主管会话，委派、问题、归档与恢复都会出现两个“负责人”，而它们的数据又都挂在会话上。

[ADR 0018](0018-main-agent-problem-routing.md) 的 `questions.owner` 只有 `user` 与 `main`，表达不了一级项目主管。执行问题需要先由项目主管处理，处理不了再升级到全局主管，最后由全局主管决定是否打扰用户。

## 决策

### 1. 会话角色就是主管身份

`conversations` 增加 `role`，取值为 `global`、`project`、`history`：

- `global` 不属于任何项目，全局唯一。
- `project` 必须绑定项目，每项目唯一。
- `history` 保留旧会话的读取与审计，不再接受派发。

唯一性由部分唯一索引保证，且不排除归档项目：

```sql
CREATE UNIQUE INDEX one_global_thread ON conversations(role) WHERE role='global';
CREATE UNIQUE INDEX one_project_thread ON conversations(project_id) WHERE role='project';
```

主管的执行实例、anchor 任务、预算和恢复继续复用 ADR 0009 的会话执行链，不新建第二套。

### 2. 全局入口与项目入口分开

全局主管使用新的独立会话，不拿一个旧的无项目会话冒充用户的全局记忆。项目主管在项目创建时生成，项目入口返回该项目唯一的 thread。项目已有的历史会话保留 `legacy` 读取，不会被提升为项目主管，也不需要用户先选择其中一个。

### 3. 工作请求是长期 thread 内的独立单位

一个项目 thread 会连续讨论多个任务，因此新增 `work_requests` 与 `work_request_revisions`：目标、项目、来源、验收、修订与暂停状态都属于工作，不属于会话。草稿与确认按 work 作用域去重，一个工作的修订不会让另一个工作的草稿失效。

工作状态为 `clarifying → ready → dispatched → completed`，取消是独立终态。同一工作可以有多个 graph，用 `graph_key` 做稳定去重；返工仍 patch 原 graph，不借新图重置额度。

### 4. 所有正式动作走同一个协调入口

草稿确认走 `StartGraph`。控制台与主管的直接建图走 `GraphCreate`，两者共享同一批受理事实：项目准入、graph owner、按 `requestId` 的幂等回执、Git 准备与恢复；草稿路径另外校验工作修订。旧入口按 `active_task` 把后到的 graph 置为 `queued` 的串行分支被移除；资源名额与凭据并发限制仍由执行内核负责。

控制原语拆开：`QueueMessage`、`SteerTurn`、`InterruptTurn`、`PauseNode`、`ResumeNode`、`StopGraph`。停止指定 agent 的含义是中断当前执行并暂停该节点队列，保留身份与历史；停止 graph 是另一个动作。引导与停止绑定 execution ID 与代次，旧指令不会落到下一轮。

### 5. 问题分阶段路由

`questions` 增加 `route_stage`（`project`、`global`、`user`）与 `route_revision`；`owner` 继续表示当前处理方，用于既有策略与收件箱。节点问题先唤醒项目主管，项目主管带证据升级到全局主管，全局主管无法解决才整理成用户问题。只有全局主管面向用户提问。

权限扩大、预算追加与人工验收仍是用户专属决策。主管成为 handler 不等于获得批准权。

### 6. 归档暂停工作，不关闭主管

`ArchiveProject` 先封闭项目工作准入，再持久暂停全部未完成 graph、未派发工作与推进意图；归档覆盖所有子 graph，不隐藏侧栏了事。主管保留控制对话，可只读解释状态和处理恢复指令，但不能继续业务写入。

`RestoreProject` 只解除项目归档，不清除工作、graph 与节点的暂停位。恢复旧工作必须有一条当前主管轮次内的真实用户消息作为依据；自动唤醒或 agent 自报“用户要求继续”不能代替它。

### 7. 恢复不重放未知副作用

继续使用 PiG 的三分判据：完成回执用于结算，不重复问模型；未发送输入按冻结配置恢复；已发出而结果未知的调用先由主管核查，无法确定再由全局主管问用户。归档与暂停优先于可恢复性。

项目主管在项目创建时生成，不从历史会话中选择，也不自动转交旧会话的未完成工作。历史会话保留原 transcript、预算与来源供读取；旧 graph、消息与通知不迁移到新主管。

## 后果

- ADR 0009 的“每个会话都可以是 main”收窄为“全局主管唯一、每项目一个项目主管”。会话仍是执行与账本的载体，但不再是用户管理的入口。
- ADR 0018 的 `owner` 保留，新增阶段与升级路径；只表达一层的旧查询需要改为从项目与阶段推导当前 handler。
- 用户侧默认打开全局入口；项目打开固定 thread；节点仍可直接对话。
- 归档不释放唯一约束，因此解除归档后不会产生第二个项目 thread。
- 旧项目已有多个会话时，不提升其中任何一个；新主管创建后，历史会话仍按原内容读取。

## 证据

- 设计与取舍：[实现设计](../planning/orchestration-engineer-design-2026-10-27.md)。
- 代码现状与产品约束：[现状审计](../planning/orchestration-engineer-audit-2026-10-27.md)。
- 验收记录与逐项证据：[实施记录](../planning/orchestration-engineer-implementation-2026-10-27.md)。
- 真实 E2E：`tests/e2e/orchestration-*.test.ts`、`tests/e2e/desktop-shell.test.ts`。
