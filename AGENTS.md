# Agent instructions

- 探索、设计、修改或审查代码，以及提交或推送前，读取 [CODING_STANDARDS.md](CODING_STANDARDS.md)，按当前工作阶段执行。
- 操作 GitHub Issues、Pull Requests 或辨认 `#编号` 前，读取 [任务平台约定](docs/guides/issue-tracker.md)。
- 分诊或调整分诊标签前，读取 [标签映射](docs/guides/triage-labels.md)。
- 用 pstack 技能（`/skill:poteto-mode` 及其 playbook）给节点分配模型或思考档位前，读取 [pstack 角色与模型映射](docs/agent/pstack-models.md)。

- 测试编写仅允许真正的 E2E，禁止新增或改写单元、集成测试；本规则适用于我和所有子 Agent。细则见 [测试编写规则](CODING_STANDARDS.md#测试编写规则)。

- Keep every source file at or below 500 LOC. Tests, docs and CSS are exempt. Markdown is documentation, not source. Split a source file before completion if your change takes it over the limit.

- worktree 不遗留：在 worktree（含 subagent 的 .claude/worktrees/agent-*）里做的任务，完成时必须删除该 worktree 及其分支。它专用的 cargo target 目录一并删掉。删除前二选一：合并进 main；或不合并时先把未提交改动提交到该分支，打 archive/<worktree 名> tag 存档，再 git worktree remove + git branch -D。编排 subagent 的会话负责收尾它派生的 worktree。确需保留的（待用户裁决、有冲突待解）在最终回复里点名路径与原因，不得默默留下。

## 门禁分层

`node --run check` 是**激活门禁**（快层）：静态检查加 `check:affected`，后者按改动区域选层——纯后端改动不跑浏览器层 `tests/m8`，`src/web`/`src/core`/`desktop` 改动才跑它，改 `scripts`/`tests`/`presets`/`docs`/`package.json`/vitest 配置则跑全套。用 `GRAPH_CHECK_PLAN_ONLY=1 node --run check:affected` 可以只读“这次会跑哪一层、因为哪些文件”。

快层里只有跑测试的那一半排队：`check:backend`/`typecheck`/`lint`/`check:harness` 只写本工作区，两个会话可以同时跑；`check:affected`/`check:evidence` 会起守护进程、用共享暂存目录，仍走 `check-queue.py` 的机器级 slot。以前整个快层都在那把锁里，所以别人一在检查，你的激活就得等——等的还不是共享资源。

## 测试只许断言确定的事实

一个测试能不能过，只能取决于产品的行为，不能取决于墙钟或机器负载。具体到写法：

- 不写 `sleep`，也不靠“等得够久”让状态变成预期的（用状态轮询，但轮询的对象必须是产品事件最终会落定的值）。
- 不比耗时、不比重试次数（`retries_used`）、不比 `workerActive` 这类随调度变化的字段，也不比整行记录。要比就比合同：同一个执行 id、同一个 submission、同一份产物的摘要。
- “没有重跑”用产物摘要与执行 id 证明，不用计数器证明。
- 拿不准就问：这条断言在慢机或高负载下会不会翻转？会翻转就换成确定的等价断言，而不是把它放进隔离名单。

`node --run check:full` 是**全量确认**（慢层，约 5–12 分钟）：包含 `check:tests` 与 `check:baseline`。**重载确认后它会自己跑**：`AckRestart` 确认提交生效时启动后台会全量，日志落在 `state/rsi/reports/async-full-<activationId>.log`；失败会往本会话追一条带来源标记的消息、标出“回归”还是“环境故障”，并唤醒主控——所以不再需要人记得手动跑。（守护进程在跑之前重启会丢掉这次后台确认，那就靠下一次激活补上。）`tests/quarantine.json` 里的时序敏感用例每次仍会跑并逐条打印，只是不阻塞门禁；`GRAPH_STRICT_SUITE=1` 时恢复严格，隔离项连续全绿后就把它移出名单。

这一次全量以前靠人肉跑，结果就是“忘了就等于没跑”；现在由重载确认自动触发，宿主侧拥有窗口服务，能看到浏览器层的真结果。如果还是本机手工跑，浏览器层会报 `Process failed to launch!`——实测同一次里 38 个文件 / 123 条用例因这个原因变红，而非浏览器层的用例照旧全绿，所以本机兜底跑出来的全量不能当回归判定。`tests/env-layers.json` 就是为这件事存在的：声明哪些文件需要窗口服务，能力不可用时如实跳过并打印。
