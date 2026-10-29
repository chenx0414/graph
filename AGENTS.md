# Agent instructions

- 探索、设计、修改或审查代码，以及提交或推送前，读取 [CODING_STANDARDS.md](CODING_STANDARDS.md)，按当前工作阶段执行。
- 操作 GitHub Issues、Pull Requests 或辨认 `#编号` 前，读取 [任务平台约定](docs/agents/issue-tracker.md)。
- 分诊或调整分诊标签前，读取 [标签映射](docs/agents/triage-labels.md)。
- 用 pstack 技能（`/skill:poteto-mode` 及其 playbook）给节点分配模型或思考档位前，读取 [pstack 角色与模型映射](docs/agent/pstack-models.md)。

- 测试编写仅允许真正的 E2E，禁止新增或改写单元、集成测试；本规则适用于我和所有子 Agent。细则见 [测试编写规则](CODING_STANDARDS.md#测试编写规则)。

- Keep every source file at or below 500 LOC. Tests, docs and CSS are exempt. Markdown is documentation, not source. Split a source file before completion if your change takes it over the limit.

- worktree 不遗留：在 worktree（含 subagent 的 .claude/worktrees/agent-*）里做的任务，完成时必须删除该 worktree 及其分支。它专用的 cargo target 目录一并删掉。删除前二选一：合并进 main；或不合并时先把未提交改动提交到该分支，打 archive/<worktree 名> tag 存档，再 git worktree remove + git branch -D。编排 subagent 的会话负责收尾它派生的 worktree。确需保留的（待用户裁决、有冲突待解）在最终回复里点名路径与原因，不得默默留下。
