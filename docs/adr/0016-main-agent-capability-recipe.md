# Main Agent 使用版本化能力配方

状态：2026-09-18 已实施。

## 背景

Main Agent 直接面对用户并持续执行规划、建图、调用 subagents、模型选择、监控和汇报。此前这些角色能力由 `master` 角色和 bootstrap prompt 固定提供，Main Agent 本身没有可查看、可编辑的 Agent 配方，因此不能像其他 Agent 一样组合资源库能力。

## 决策

- Agent 配方新增 `mode: "main"`。Main Agent 配方固定使用 id `main`，可以初始不引用能力，用户可继续组合 Skills、MCP、Pi extensions 和 Prompt。
- `main` 配方编译为版本化 `main@N` 定义。新建 Main Agent 实例使用最新已编译版本；已经创建的实例继续保留原定义版本。
- `presets/bootstrap/master/agent.md` 同时作为 `main` bootstrap 身份 Prompt 来源，仍属于不可删除的 Graph bootstrap。
- 规划、建图、调用 subagents、模型选择、监控、问题处理和用户汇报对应的宿主工具由 `master` 角色强制启用，不能从配方移除；生成的 `tool.md` 会列出实际可调用工具。
- Main Agent 配方保存后立即编译，使后续新建对话使用新版本。删除 Main Agent 配方被拒绝，避免运行入口失去定义。
- 配方文件不可解析时不自动覆盖用户文件，运行时回退到 `master@1`。

## 后果

- Main Agent 与 subagent 共享同一套“配方引用能力、编译为定义、按定义装载能力包”的规则。
- 角色级工具仍是权限边界，不会被用户配置成任意能力；用户配置扩展的是能力组合，不是宿主权限。
- 同一对话保持定义版本稳定，配方更新不会追溯改变已有 Main Agent 实例。
