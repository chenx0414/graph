# Artifacts, Handoff and Git

## 工作位置与代码交付

节点 workspace 决定使用项目目录还是已准备的私有 worktree，具体声明与权限见 [graph-v2.md](graph-v2.md#节点工作目录与权限)。system prompt 和运行快照显示本次实际位置；相对路径以它为基准。普通节点不能写另一节点工作目录或共同 Git metadata。

代码产物通过 workspace_commit 保存真实 commit；worktree 路径只提供访问位置。显式 Git 集成汇集到 integration branch，最终检查、独立审查与用户确认均绑定精确提交。路由保留的旧通过状态不能证明后来的代码版本。

## 输出与审查引用

节点调用 submit 的具名输出承载工作摘要、结论及精确产物引用。接收者按自己的输入协议读取；内容需要稳定版本时先发布产物再发送引用。独立审查读取明确的任务、验收及实际审查版本；节点不从另一节点 transcript 自动继承历史。审查模型独立性和最终验收由宿主核实。

## Shared Artifact Workspace

Artifact 属于顶层 graph，发布版本不可变；普通节点只能修订自己的成果，main 可修订所有自己管理的成果。修订保留原作者并记录修改者，产生新版本。正式引用使用：

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

### 节点声明的交付物（`NodeDefinition.deliverable`）

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

- **graph 级**：内部节点共享顶层 graph 的产物空间；main 可读取自己拥有的 graph，其他拥有者不能借用身份访问。子 graph 的成果记录发布节点和所属子 graph。
- **project 级**（晋升后）：本项目**未来的任务**也能发现它。
- **不跨越会话**：没有显式晋升，什么都不会跨出会话边界。

`artifact_promote` 只对 master 开放，且只能晋升**调用方有权管理的 graph 工作区**里能看见的制品。**不要给每个子任务的产物都晋升**：晋升是把一份制品变成项目级共享知识，会给之后所有图看见，应当是「这份结论值得成为项目记忆」的显式判断。

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
