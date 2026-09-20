# Artifacts, Handoff and Git

## Worktree

每个 Agent instance 使用独立 Git worktree。代码修改在自己的 worktree 中产生，不能直接写另一个 Agent 的目录或共同 Git metadata。

任务 integration branch 汇集所有实例的修改。最终通过整体检查和独立审查后，才合入用户确认的目标分支。

Graph 的 host 路径因任务和 Agent 不同。System prompt 的 `<cwd>` section 给出当前 operation 的实际 worktree；相对路径以该目录为基准。

## Result Handoff

正常实现交接使用结构化 `result_handoff@1`，至少包含：

- objective；
- outcome；
- work summary；
- changes；
- decisions；
- verification；
- known limits；
- open questions；
- next actions。

下游 Fresh Agent 默认只读取直接依赖的 handoff，不继承前驱 transcript。

## Evidence Only

独立审查和验证使用 `evidence_only`：只读取 acceptance、evidence、artifact 和精确版本，不读取前驱自由文本、transcript 或隐藏推理。

## Shared Artifact Workspace

Artifact 是任务级、发布式、不可变版本。正式引用使用：

```text
artifactId + version + digest
```

适合发布：

- plans；
- research source lists；
- review reports；
- generated documents；
- 不适合直接进入 Git 代码分支的交付物。

不要用 artifact 替代任务图控制流或 evidence。Artifact 只承载内容、版本和发现。

## Evidence

Evidence 证明某个 acceptance 在具体输入和提交上是否通过。它必须绑定：

- acceptance id；
- program check；
- input/version；
- commit 或 digest；
- 原始输出或可验证 artifact。

旧证据不能验证新代码；目标分支变化后必须重新集成并重检受影响证据。

## Git Integration

- Graph 管理 worktree、branch、merge 和 refs。
- 普通命令不能写 `.git` metadata。
- 目标分支变化先纳入 integration branch 并重检。
- 目标工作区脏时等待处理，不覆盖人工修改。
- 只有验收和独立审查通过才合入。
- 合并后记录精确 commit、evidence 和审查范围。

如果 Git 操作结果不明，按 recovery 规则核查，不进行破坏性 reset 或 checkout。
