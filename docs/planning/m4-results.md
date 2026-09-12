# M4 代码集成与自动合并

日期：2026-09-12。对应 [实施计划 G12–G13](../implementation-plan.md#m4-代码集成与自动合并)。基于 M3 的提交 `fed519f`。本轮把任务集成分支、每实例工作副本、验收证据绑定和目标分支合入接到 Task Runtime；非 Git 项目仍走 M1 的完成路径。

## 可运行结果

```sh
pnpm test:m4
pnpm check
```

最终复验中 `pnpm check` 通过：TypeScript 检查及 19 个文件、93 项测试，其中 M0 27 项、M1 22 项、M2 27 项、M3 8 项、M4 9 项。`git diff --check` 无格式错误。测试使用真实临时 Git 仓库与磁盘 SQLite，scripted 外部动作，不读取项目 `.env`，不调用收费模型。

## 入口

- 确认任务时，若项目根目录是 Git 仓库，则创建 `graph/task/<taskId>` 集成分支及对应 worktree；否则跳过 Git。
- Agent 在 `operation.workspace` 中写入；程序检查和人工检查使用集成分支工作树。
- 实例完成后由 Git 模块串行提交并合入集成分支；冲突保留双方副本，打开 `execution_failed`。
- 全部节点成功、验收证据有效、且程序拥有的独立审查门通过后合入目标分支：目标在任一 worktree 检出时检查该工作区并快进；未检出则带旧值 `update-ref`。
- 内建程序动作 `graph.human_check`：打开 `human_check`，确认绑定当前 activation 与集成提交；用户 `acknowledge` 后才产生验收证据。

## G12

| 出口 | 证据 |
| --- | --- |
| 并行实例互不覆盖 | `tests/m4/worktrees.test.ts` 左右节点写入不同 worktree，合入后目标分支同时有两个文件 |
| 冲突保留失败现场 | 同文件冲突后任务仍 `running`，问题含冲突路径，双方副本内容仍在 |
| 任务/节点提交关联 | 有效验收证据带 `commitSha`，与 `view().integrationSha` 一致 |
| 半完成 Git 可恢复 | 关闭前目标已快进到集成提交，重开后核对完成；集成分支 HEAD 与库中 SHA 不一致时按工作树核对 |

Git 写入在 SQLite 事务外执行；实例分支使用 `graph/copy/<taskId>/<nodeId>`，避免与集成分支 `graph/task/<taskId>` 的 ref 路径冲突。调用隔离用户 Git 配置（pager、gpg、hooks）。

## G13

| 出口 | 证据 |
| --- | --- |
| 目标脏工作区等待 | 未跟踪文件使合入打开 `git_dirty`；清除后 acknowledge 再合入，用户文件不被覆盖 |
| 目标分支变化先重检 | 检查后目标新增提交，先并入集成分支，旧证据作废，检查再跑一次再合入 |
| 独立审查后才合入 | `graph.verify` 消费 reviewer 的结构化报告后才合入；Agent JSON `verdict` 不是通过门 |
| 人工检查等待用户 | `graph.human_check` 在 acknowledge 前不完成任务 |
| 未检出目标用条件更新 | 当前检出其他分支时更新 `main` 引用，工作区仍停在其他分支 |
| 代码变化使证据失效 | 晚到的并行提交更新集成 SHA 后，已通过的程序检查作废并重跑 |
| 验收检查命令不可被修订削弱 | 修订不能改写已确认验收项的 check input；`tests/m4/command-check.test.ts` 拒绝 `node --test` → `node --version`，另一修订在不改检查的前提下仍可加节点 |
| 合并后落账前崩溃 | 目标已等于集成 SHA 时恢复视为已合并并完成任务 |

Graph 状态目录若位于目标工作树内，不计入脏工作区。

## 持久化

schema 9：`tasks.integration_branch/integration_sha/target_sha`，`evidence.commit_sha`，以及 `worktrees`、`git_ops`、`git_commits`。

## 本轮边界

未对使用者配置的真实供应商做收费契约请求。合入门槛是已确认图中的全部节点与有效验收证据；独立审查由提案里的审查节点承担，内核不另加默认审查步骤。Git 模块管理集成分支、实例副本和目标引用；Agent 工作树仍共享仓库的 `.git`，受限执行边界在命令与 MCP 派发前拒绝写授权内已存在的 `.git` 条目，普通工具不能改写 refs、index 或 worktree 链接文件。已确认验收项的检查 input 在修订中固定，改写检查命令必须回到用户确认。合并冲突保留实例副本，集成分支上的冲突合并会中止以便再试。需要改已确认需求的冲突走 `execution_failed`，不另开需求修订通道。本机 Web 见 [M5 报告](m5-results.md)。
