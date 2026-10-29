# Agent instructions

- 探索、设计、修改或审查代码，以及提交或推送前，读取 [CODING_STANDARDS.md](CODING_STANDARDS.md)，按当前工作阶段执行。
- 操作 GitHub Issues、Pull Requests 或辨认 `#编号` 前，读取 [任务平台约定](docs/agents/issue-tracker.md)。
- 分诊或调整分诊标签前，读取 [标签映射](docs/agents/triage-labels.md)。
- 用 pstack 技能（`/skill:poteto-mode` 及其 playbook）给节点分配模型或思考档位前，读取 [pstack 角色与模型映射](docs/agent/pstack-models.md)。

- 测试编写仅允许真正的 E2E，禁止新增或改写单元、集成测试；本规则适用于我和所有子 Agent。细则见 [测试编写规则](CODING_STANDARDS.md#测试编写规则)。

- Keep every source file at or below 500 LOC. Tests, docs and CSS are exempt. Markdown is documentation, not source. Split a source file before completion if your change takes it over the limit.

- worktree 不遗留：在 worktree（含 subagent 的 .claude/worktrees/agent-*）里做的任务，完成时必须删除该 worktree 及其分支。它专用的 cargo target 目录一并删掉。删除前二选一：合并进 main；或不合并时先把未提交改动提交到该分支，打 archive/<worktree 名> tag 存档，再 git worktree remove + git branch -D。编排 subagent 的会话负责收尾它派生的 worktree。确需保留的（待用户裁决、有冲突待解）在最终回复里点名路径与原因，不得默默留下。

## 门禁分层

`node --run check` 是**激活门禁**（快层）：静态检查加 `check:affected`，后者按改动区域选层——纯后端改动不跑浏览器层 `tests/m8`，`src/web`/`src/core`/`desktop` 改动才跑它，改 `scripts`/`tests`/`presets`/`docs`/`package.json`/vitest 配置则跑全套。用 `GRAPH_CHECK_PLAN_ONLY=1 node --run check:affected` 可以只读“这次会跑哪一层、因为哪些文件”。

快层里只有跑测试的那一半排队：`check:backend`/`typecheck`/`lint`/`check:harness` 只写本工作区，两个会话可以同时跑；`check:affected`/`check:evidence` 会起守护进程、用共享暂存目录，仍走 `check-queue.py` 的机器级 slot。以前整个快层都在那把锁里，所以别人一在检查，你的激活就得等——等的还不是共享资源。

`node --run check:full` 是**全量确认**（慢层，约 4–5 分钟）：包含 `check:tests` 与 `check:baseline`。激活重载之后必须跑一次并把结果写进汇报；失败不当场阻塞重载，但要开一条后续任务把回归收尾。`tests/quarantine.json` 里的时序敏感用例每次仍会跑并逐条打印，只是不阻塞门禁；`GRAPH_STRICT_SUITE=1` 时恢复严格，隔离项连续全绿后就把它移出名单。

这一次全量要走**宿主检查通道**（`apply_rsi_change` 带 `changes: []` 和 `check:full`），不要在自己的 bash 里跑：Agent 的受限执行器没有窗口服务，浏览器层 `tests/m8` 会报 `Process failed to launch!`。实测同一次里 38 个文件 / 123 条用例因这个原因变红，而非浏览器层的用例照旧全绿——所以本机跑出来的全量不能当回归判定，只能在报告里如实标注为环境受限。
