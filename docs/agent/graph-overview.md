# Graph Overview

Graph 是 main 管理的本地 Agent 协作运行空间，用于完成项目中的任务。正式术语和契约见 [执行模型](execution-model.md) 与 [管理入口](graph-v2.md)。

## 职责

用户确认需求、验收和授权范围。main 调查项目、设计声明式 graph、选择配方与模型、管理运行并处理问题；main 位于 graph 外部，完成某个 graph 不结束它的会话。

Agent 节点处理具体任务，拥有独立会话、串行队列、工作位置和预算。配方定义身份、规则与能力；节点定义本次任务、验收和接口。模块处理判断、汇合、映射和受控宿主操作。边连接具名接口；投递是一次实际信息。共享产物保存不可变版本。子 graph 复用定义，运行实例独立。

## 开展任务

1. main 调查需求并明确验收，选择 [设计范例](../design-graph-examples.md) 的结构。
2. 使用已发布配方的精确版本，完整定义并校验协议、节点、模块、连接和公开接口。
3. 按任务授权使用 graph_create，或提交 propose_graph 草稿供用户确认；准备完成后显式 graph_send 启动。
4. Agent 发布产物并通过 submit 发送具名输出；main 读取公开结果，检查执行与模块记录并处理失败。
5. 满足验收后提出 complete，等待工作排空。代码交付还需精确 commit 检查、独立审查与确认后的 Git 集成。

## 会话目标（/goal）

`/goal <目标>` 把一个持续目标写进会话，而不是发成一条要模型解释的消息。目标**没有预算**：`/goal <目标> +N` 照常设定目标但 N 被忽略（回执写「已忽略 +N：目标无预算上限」），裸 `/goal +N` 只回「目标现在没有上限」且不改任何状态。`/goal` 查看当前目标，`/goal pause` / `resume` 暂停或恢复，`/goal done [备注]` 标为完成，`/goal clear` 清除。每条命令在会话里留一行可见记录（`kind=goal`）。

只有 `active` 目标会进入 master 那一轮的 prompt（"Standing goal" 段，只写「已用 N tokens，未设上限」）；暂停、额度用尽、验收中与已完成的目标不进入。每轮结算的 usage 计入目标的 `usedTokens`。历史数据里可能还有 `budget_limited` 行：读出来归一为 `paused`，复活走 `/goal resume`，不再有任何预算熔断。HTTP 面为 `GET/POST /api/conversations/{conversationId}/goal`。

设目标就是派活：`/goal <目标>`（无论是一条新对话的第一条消息，还是对话中间的一条）会立刻从这个目标起一轮——会话里留一条可见的「开始执行这个目标：…」指令，模型带着 Standing goal 段开始推进，不需要人再补一条消息。`/goal resume` 同样立刻起一轮（暂停或额度用尽是「停一下」，恢复就是「接着干」，不该等人再补一条消息）。`pause`/`done`/`clear`/仅查看与已被忽略的 `+N` 不额外起轮。

控制台里对话顶部有一张目标卡片：目标原文、状态、已用 tokens 与操作按钮（暂停、恢复、带备注标记完成、清除），没有预算数字也没有进度条；状态含 `usage_limited`（额度用尽，可恢复）。斜杠命令面板里有「设定目标」一项，选中会把 `/goal ` 写进输入框。卡片每 4 秒刷新一次。会话里由目标自动产生的指令行（`source.kind` 为 `goal_start` / `goal_continue` / `goal_acceptance`）按系统风格行渲染，不占用户气泡——那些话不是用户说的。

### 停止条件

目标自己续跑：一轮干净结束后，只要目标仍是 `active`，下一轮就从这个目标起，会话里留一条「继续推进目标：…」指令。**没有任何轮数上限**：刹车是模型的收口报告与用户，不是计数器。

| 停止条件 | 结果 |
|---|---|
| 模型 `goal` 工具 `complete` | 进入独立验收（`verifying`），不是终点 |
| 模型 `goal` 工具 `blocked`（同一阻碍连续 ≥3 个续跑轮） | `paused`，留一行等用户裁决 |
| provider 额度/容量耗尽（HTTP 429/503） | `usage_limited`，可 `/goal resume` |
| 用户 `pause` / `clear` / 改目标 | 按命令改变状态，不再续跑 |
| 这一轮问了人、已有排队消息、这一轮没有可记账的 usage | 不续跑 |
| 历史数据里预算用尽 | 不续跑（`budget_limited` 读出即 `paused`） |

### 独立验收（complete 之后）

`complete` 只是声明，不是完成。模型调 `complete` 时记一条 `goal.acceptance_requested` 事件、状态置 `verifying`，并起一轮**独立验收**：单独的 prompt，输入是目标原文、完成声明、实施轮的最后答复与已用 tokens，验收方自己用工具复核工作区改动、文件、测试输出与 artifact 内容，产出必须是结构化的 `VERDICT: pass|fail` 加逐条理由。三条路径缺一不可：

- **pass** → `completed`；终态报告含验收结论与逐条理由，以及**含验收轮自身 usage 在内**的目标已用 tokens。
- **fail** → **不置 completed**；记 `goal.acceptance_failed`（带理由指纹），状态回 `active`，失败理由写进下一轮续跑指令回流。同一失败理由连续 ≥3 轮未解决，按 blocked 同一门槛转 `paused`（复用事件流指纹计数，不新增常量）。
- 验收器自身失败（provider 错误 / 无输出 / 解析不出 pass|fail）→ **不得算 pass**，记 `goal.acceptance_error`，当轮不推进也不完成。

验收轮与实施轮用同一个模型，所以独立性受限：`goal.acceptance_requested` 事件里显式写 `sameModel: true` 与两个模型 id，不靠暗示。`verifying` 只是既有 `status` 列的新取值，没有新列、没有数据迁移（SQLite 无法改 CHECK 约束，取值表随 `usage_limited` 一起在同一次表重建里放开）。

## 查看当前事实

通过 read_system_capabilities/inspect_graph_system 查看实际配置与应用位置；通过 graph_inspect、node_run、节点窗口及 list_problems 查看正式运行记录。system prompt、有效工具和实际环境对用户可见。旧报告只说明当时的运行，不能证明当前状态。
