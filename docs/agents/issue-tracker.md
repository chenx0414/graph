# Issue tracker: GitHub

任务与规格存放于 GitHub Issues，使用 gh CLI 操作。

## 目标仓库

当前仅初始化了本地 Git，尚未指定 GitHub 仓库。
后续从 git remote -v 确定目标仓库，或使用用户明确指定的
owner/repo，并通过 --repo owner/repo 传入。

目标仓库未明确时，需要发布的内容先准备为本地草稿，
待用户指定仓库后再发布。

## 操作约定

- 创建：gh issue create --title "..." --body-file <file>
- 读取：gh issue view <number> --comments；同时检查正文与标签。
- 列表：gh issue list，按任务需要过滤状态和标签。
- 评论：gh issue comment <number> --body-file <file>
- 标签：gh issue edit <number> --add-label / --remove-label
- 关闭：gh issue close <number>

多行正文写入临时文件，通过 --body-file 提交。
标签含义见 triage-labels.md。

技能要求“发布到任务平台”时，创建 GitHub Issue。
技能要求“获取相关任务”时，读取对应 Issue 及评论。

## Pull requests as a triage surface

PRs as a request surface: no.

## Wayfinding

- Map 使用带 wayfinder:map 标签的 Issue。
- 子任务关联为 sub-issue；不可用时使用 Map 中的任务列表，
  并在子任务正文记录 Part of #<map>。
- 子任务类型使用 wayfinder:research、wayfinder:prototype、
  wayfinder:grilling 或 wayfinder:task 标签。
- 阻塞关系使用 GitHub 原生 issue dependencies；不可用时
  在正文记录 Blocked by: #<number>。
- 所有阻塞项关闭后，任务才可领取。
- 按 Map 顺序选择未关闭、无阻塞、未分配的任务。
- 领取时先将任务分配给当前执行者。
- 完成时评论记录答案、关闭任务，并在 Map 的
  Decisions-so-far 中追加结论摘要及链接。
