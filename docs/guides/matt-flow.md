# Matt 流程（文档驱动）

这份文档定义本项目规格、任务、实现与审查的文件契约。选择技能先使用 `/ask-matt`；工程规则读取 [CODING_STANDARDS.md](../../CODING_STANDARDS.md)，技能来源与本地适配见 [harness 维护](harness.md)。

首次构建由 main 整理规格与任务，再派发实现和独立审查。跨会话使用规格、关联任务与提交作为交接依据；合流仅处理实际发生的冲突。

项目使用的三个 Agent 配方如下；派发前在运行应用的配方库中核对其实际发布版本与能力绑定：

| 配方 | 名字 | 身份 | 绑定 | 审查 |
| --- | --- | --- | --- | --- |
| `matt-implement` | Dan_implementer | `matt-pocock-implement` | `implement-spec`、`tdd` | medium / 否 |
| `matt-review` | Eve_reviewer | `matt-pocock-review` | `code-review` | medium / **是**（走独立审查通道） |
| `matt-merge` | Frank_merger | `matt-pocock-merge` | `code-review` | medium / 否 |

## 产物与位置（契约）

| 步骤 | 产物 | 位置 |
| --- | --- | --- |
| `/grill-with-docs` | 共识与术语（懒创建） | 根 `CONTEXT.md`、`docs/adr/` |
| `/to-spec` | 规格 | **`docs/specs/<slug>.md`**（必填：`# 标题`、≥1 个 `## 小节`、正文 ≥ 200 字符） |
| `/to-tickets` | 任务 | **GitHub Issues**（`chenx0414/graph`），每条 issue 正文必须指回 `docs/specs/<slug>.md` 或 slug，并带分诊标签（见 [标签映射](triage-labels.md)） |
| `/implement-spec` | 实现 | 该 slug 的提交/改动，**commit message 里引用 task 号 `(#<n>)`** |
| `/code-review` | 审查 | 对照规格与任务审查变更（前提：上面三者齐备） |
| 无 slug | 合流 | 两条车道的冲突与**两边都活着的**合并结果（前提：真的有一处冲突） |

`<slug>` 一律小写字母、数字、连字符。

## 机械闸门

```bash
node scripts/matt-flow.mjs <slug> --stage spec        # 只查规格
node scripts/matt-flow.mjs <slug> --stage tickets     # 规格 + 任务
node scripts/matt-flow.mjs <slug> --stage implement   # 规格 + 任务 + 实现（默认）
node scripts/matt-flow.mjs <slug> --stage review      # 规格、任务、实现齐备才放行
node scripts/matt-flow.mjs <slug> --json              # 机器可读
node scripts/matt-flow.mjs --stage merge <ours> <ref> # 两侧真的相撞才放行
node scripts/matt-flow.mjs --stage merge              # 看当前工作树里未完成的合并
```

`--stage merge` 与其它四条不同：它**不收 slug**（撞击与规格无关），查的是「这次合并到底有没有冲突」。
不带 ref 时读当前工作树（`MERGE_HEAD` + 未合并文件），并拒绝冲突之外的任何改动（包括未跟踪文件）——
那正是合流判定会拒绝的东西，提前说清就不必让 Agent 白做一轮。

- 退出码 0 = 该阶段的前提齐备；非 0 = 缺什么，**逐条**打印出来。
- 它只检查**前置产物是否存在**，不评价写得好不好，也**绝不自己编**一份产物。
- 离线或测试时用 `--tickets <json>` 喂一份 `gh issue list --json number,title,body,labels` 的输出，
  解析路径与线上完全一致。`gh` 不可用或未登录时**明确失败**，不会静默通过。

## 阶段用途与派发

| 时机 | 检查 | 完成条件 |
| --- | --- | --- |
| 规格写完 | `--stage spec` | 规格文件满足格式要求 |
| 首次派发实现前 | `--stage tickets` | 规格与关联任务存在 |
| 实现产生提交后 | `--stage implement` | 规格、任务和引用任务号的实现记录可对应 |
| 派发独立审查前 | `--stage review` | 规格、任务、实现三者齐备 |
| 处理合并冲突前 | `--stage merge <ours> <theirs>` | 两侧确实存在冲突 |

`implement` 已包含实现记录检查，不能用它作为首次实现的前置条件。某个已发布 Agent 配方若仍要求开工前执行该阶段，应核对并更新其身份提示；文档更新不会自动修改已发布配方。

脚本检查产物的存在与关联，不能证明任务分诊已就绪、阻塞关系已解除、实现符合规格或审查已经通过。派发 main 仍须根据 [任务平台约定](issue-tracker.md)读取任务及其阻塞关系；审查者实际运行 `/code-review`。

## Graph 中的检查

同一阶段命令可以作为 graph 的显式检查。v2 使用命令模块，声明方式读取 [Graph v2 规格](../specs/graph-rebuild-v2.md)及正在运行的应用所提供的接口文档。旧 `kind: program`、`dependsOn`、`graph.command` 示例属于旧内核格式。

检查使用实际工作副本；需要读取 GitHub 时，核对该执行的 `gh`、凭据与网络能力，按 [权限与恢复](../agent/permissions-and-recovery.md)处理。

## 交付证据

- 共识落在规格文件中，才能作为跨会话交接依据。
- 实现提交的 commit message 引用任务号 `#<n>`，供闸门关联任务。
- 合流 Agent 不说「我合并好了」就算数：判定看的是 Git 里的合并提交本身，
  丢掉任何一侧、留下冲突标记、或动了冲突之外的文件，都会让合并被 `--abort` 并照旧 block。
