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

tag 是标签而非路径：任意文种都可以（例如 `编码`、`已知问题`），写入时统一小写并限长 60 字符；而 `namespace`、`name`、`prefix` 仍要求小写 ASCII slug，因为它们会进入 artifact URI。

容量：单个逻辑制品最多 1,000 版（按版本号算，退役不释放，超限报 `artifact_quota`），单次操作最多发布 32 个制品；真正的容量闸门是任务级字节配额（256 MiB，内容按 digest 去重）。所以「长期演进的一份文档」是合法用法：同一 `namespace/name` 持续发新版即可，引用时带上 `version`。

### 节点声明的交付物（`NodeSpec.deliverable`）

节点可以在规格里**声明它要产出的文件**，由 harness 在**节点成功结算时**发布成 task 级制品（`producer` = 该节点）：

```json
"deliverable": { "path": "notes/x.md", "namespace": "research", "name": "x-notes", "title": "…", "summary": "…" }
```

这样交付物**不依赖节点自己记得调用 `artifact_publish`**；反过来，**声明的文件不存在或是空的，节点就不会 `succeeded`**（原因写在结果里）——图许诺了一个文件，「通过了但没有文件」是缺陷，不是通过。

规则：

- `path` 必须是**相对路径**，不得以 `/` 开头、不得含 `..` 或空段（发布时会在节点工作区内解析，越界会被拒）；
- `namespace` 只能是 `plans`、`research`、`reviews`、`deliverables`、`summaries`；
- `namespace` 与 `name` 是小写 ASCII slug；`title`（≤300）与 `summary`（≤2000）可选且非空。

### 谁能看见一份制品

- **task 级**：发布它的那个任务，**以及同一会话内所有任务**。所以派发子任务的 main agent **不需要晋升**就能读到子任务交回的制品。
- **project 级**（晋升后）：本项目**未来的任务**也能发现它。
- **不跨越会话**：没有显式晋升，什么都不会跨出会话边界。

`artifact_promote` 只对 master 开放，且只能晋升**调用方自己任务工作区**里能看见的制品。**不要给每个子任务的产物都晋升**：晋升是把一份制品变成项目级共享知识，会给之后所有图看见，应当是「这份结论值得成为项目记忆」的显式判断。

### 重新发布一份已有制品

对象库里的字节是**不可变的**，落盘权限是 `0444`。由此：

- **要改内容就重新发布**：文本制品 `artifact_read` 直接返回正文，改好用 `artifact_publish` 的 `content` 发新版——不要在副本上原地编辑。
- 若某条路径必须经过文件（比如脚本生成），**`cp` 过来的副本仍然是只读的**：先 `chmod u+w`，否则用 `edit` 或脚本写它会以 `PermissionError` 失败，而这个报错不会告诉你真因是「源文件只读」。
- 版本号由发布推进（`expectedVersion` 做 compare-and-swap）：退役不释放版本号，也不删字节。

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

## Worktree 与分支清理

- 任务进入终态（completed / abandoned）后它的工作副本不会自动消失：`git worktree list --porcelain | sed -n 's/^worktree //p'` 取**整行**路径（路径含空格，`awk '{print $2}'` 会截成 `/Users/macmini/Library/Application`），确认在 `<stateDir>/worktrees/` 下后用 `git worktree remove --force` 逐个移除，最后 `git worktree prune` 清理失效注册。
- 循环里绝不放 `rm -rf` 兜底：失效注册交给 `git worktree prune`。
- 已并入主线的 `graph/*` 分支用 `git branch -d` 清理，保留最近几个便于追溯。

## 推送失败不等于闸门失败

推送失败时先读日志里的**闸门判定行**，不要把它当成门禁失败重跑一遍；遇到 `RPC failed ... HTTP2 framing layer` 之类的传输层错误，用 `git -c http.version=HTTP/1.1` 重试。
