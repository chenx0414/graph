# Issue tracker: GitHub

任务与规格存放于 GitHub Issues，使用 `gh` CLI 操作。

## 目标仓库

**`chenx0414/graph`**（`git remote -v` 里的 origin）。在仓库内运行 `gh` 时
它会自己推断，不必显式传 `--repo`；只有在仓库外操作时才传 `--repo chenx0414/graph`。

## 操作约定

- **创建**：`gh issue create --title "..." --body-file <file>`。多行正文写进临时文件，用 `--body-file`。
- **读取**：`gh issue view <number> --comments`；同时看正文与标签。
- **列表**：`gh issue list --state open --json number,title,body,labels,comments`，按需加 `--label` / `--state`，用 `--jq` 收敛字段。
- **评论**：`gh issue comment <number> --body-file <file>`
- **加/去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

GitHub 的 issue 与 PR **共用一套编号**：看到裸 `#42` 时先用 `gh pr view 42` 判断，
失败再退回 `gh issue view 42`。

标签含义见 `triage-labels.md`。

## Pull requests as a triage surface

**PRs as a request surface: no.**（外部 PR 不当作需求入口；`/triage` 会读这一行。
哪天要改，把 no 改成 yes，并按 `gh pr` 的等价命令处理。）

## Wayfinding（`/wayfinder` 使用）

- Map 是一张带 `wayfinder:map` 标签的 Issue，正文放 Notes / Decisions-so-far / Fog。
- 子任务是挂在 Map 下的 sub-issue；该能力不可用时，改为在 Map 正文的任务列表里登记，
  并在子任务正文首行写 `Part of #<map>`。
- 子任务类型标签：`wayfinder:research` / `wayfinder:prototype` / `wayfinder:grilling` / `wayfinder:task`。
- 阻塞关系用 GitHub **原生 issue dependencies**（UI 可见的那个）：
  `gh api --method POST repos/chenx0414/graph/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，
  其中 `<blocker-db-id>` 是**阻塞者的数字数据库 id**（`gh api repos/.../issues/<n> --jq .id`），不是 `#number`。
  查 `issue_dependencies_summary.blocked_by`（只含未关闭的阻塞项）就是当前的闸门。
  该能力不可用时，退回在子任务正文首行写 `Blocked by: #<n>, #<n>`。
- 前沿（可领取）＝ Map 下未关闭的子任务里，去掉有未关闭阻塞项的、再去掉已有 assignee 的，按 Map 顺序取第一个。
- 领取：`gh issue edit <n> --add-assignee @me`（本次会话的第一次写操作）。
- 完成：`gh issue comment <n> --body "<answer>"` → `gh issue close <n>` → 在 Map 的 Decisions-so-far 追加结论摘要与链接。

## 技能说“发布到任务平台” / “获取相关任务”

创建 GitHub Issue / `gh issue view <number> --comments`。
