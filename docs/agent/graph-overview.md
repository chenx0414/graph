# Graph Overview

Graph 是 main 管理的本地 Agent 协作运行空间，用于完成项目中的任务。正式术语和契约见 [执行模型](execution-model.md) 与 [管理入口](graph-v2.md)。

## 职责

用户确认需求、验收和授权范围。main 调查项目、设计声明式 graph、选择配方与模型、管理运行并处理问题；main 位于 graph 外部，完成某个 graph 不结束它的会话。

Agent 节点处理具体任务，拥有独立会话、串行队列、工作位置和用量记录。配方定义身份、规则与能力；节点定义本次任务、验收和接口。模块处理判断、汇合、映射和受控宿主操作。边连接具名接口；投递是一次实际信息。共享产物保存不可变版本。子 graph 复用定义，运行实例独立。

## 开展任务

1. main 调查需求并明确验收，选择 [设计范例](../design-graph-examples.md) 的结构。
2. 使用已发布配方的精确版本，完整定义并校验协议、节点、模块、连接和公开接口。
3. 按任务授权使用 graph_create，或提交 propose_graph 草稿供用户确认；准备完成后显式 graph_send 启动。
4. Agent 发布产物并通过 submit 发送具名输出；main 读取公开结果，检查执行与模块记录并处理失败。
5. 满足验收后提出 complete，等待工作排空。代码交付还需精确 commit 检查、独立审查与确认后的 Git 集成。

## 没有会话内目标

此前 `/goal` 能把一个持续目标写进会话，并在会话里自己续跑、自己验收。这条路径已经删除：目标只能成图，图里做规划、实现与审查。会话里没有目标行、没有目标卡片、没有 `goal` 工具，也没有 `GET/POST /api/conversations/{id}/goal`——想推进一件事，就给它建一张图。

## 查看当前事实

通过 read_system_capabilities/inspect_graph_system 查看实际配置与应用位置；通过 graph_inspect、node_run、节点窗口及 list_problems 查看正式运行记录。system prompt、有效工具和实际环境对用户可见。旧报告只说明当时的运行，不能证明当前状态。
