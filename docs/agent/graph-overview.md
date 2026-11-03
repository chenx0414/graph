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

`/goal <目标>` 把一个持续目标写进会话，而不是发成一条要模型解释的消息；`/goal <目标> +5000` 同时设 token 预算。`/goal` 查看当前目标，`/goal +N` 追加预算，`/goal pause` / `resume` 暂停或恢复，`/goal done [备注]` 标为完成，`/goal clear` 清除。每条命令在会话里留一行可见记录（`kind=goal`）。

只有 `active` 目标会进入 master 那一轮的 prompt（"Standing goal" 段）；暂停、预算用完或已完成的目标不进入。每轮结算的 usage 计入目标的 `usedTokens`；达到预算即转 `budget_limited` 并留一条可见提示，目标不再注入，但会话本身仍可继续（预算停的是目标，不是对话）。HTTP 面为 `GET/POST /api/conversations/{conversationId}/goal`。

设目标就是派活：`/goal <目标>`（无论是一条新对话的第一条消息，还是对话中间的一条）会立刻从这个目标起一轮——会话里留一条可见的「开始执行这个目标：…」指令，模型带着 Standing goal 段开始推进，不需要人再补一条消息。只改变既有目标的命令（`pause`/`resume`/`extend`/`done`/`clear`/仅查看）不额外起轮，免得一次恢复就花掉没人要求的模型调用。这一轮结算的 usage 同样计入目标预算。

控制台里对话顶部有一张目标卡片：目标原文、状态、已用/预算与进度条，并可直接暂停、恢复、追加预算、带备注标记完成、清除；斜杠命令面板里有「设定目标」一项，选中会把 `/goal ` 写进输入框（键盘 ↑/↓ + Enter 同样可选）。卡片每 4 秒刷新一次，所以一轮跑完后的用量与预算熔断会自己出现。

尚未实现：目标自动续跑（一轮结束后目标不会自己再起下一轮），仍要手动发消息推进。

## 查看当前事实

通过 read_system_capabilities/inspect_graph_system 查看实际配置与应用位置；通过 graph_inspect、node_run、节点窗口及 list_problems 查看正式运行记录。system prompt、有效工具和实际环境对用户可见。旧报告只说明当时的运行，不能证明当前状态。
