# ADR 0025：任务级共享产物空间

日期：2026-09-19

## 状态

已接受。

## 背景

Graph 已有独立 Agent worktree、结构化 `ResultHandoff`、`Evidence` 和逻辑上的“共享空间”，但 artifact 仍只有 producer 本机绝对路径与 digest。下游 Agent 的文件工具不能读取其他实例的 worktree，非直接依赖节点也没有发现文献集、Plan、Review Report 等产物的入口。

把所有 Agent 挂到同一个可写目录会产生覆盖、污染、越权和不可复现问题。代码协作必须继续使用 Git worktree 与 integration branch。

## 决策

- 新增任务级 `ArtifactWorkspace`。内容按 SHA-256 存放在 Graph 受保护状态目录，SQLite 保存逻辑身份、版本、provenance、schema、ACL、生命周期和审计事件。
- Artifact 使用 `graph://tasks/{taskId}/artifacts/{namespace}/{name}@{version}` 表示；项目级提升使用 `graph://projects/{projectId}/...`。
- Published version 不可变。同一 `namespace/name` 通过新 version 演进；普通 Agent 请求带 `expectedVersion` 的 compare-and-swap，冲突不隐式合并。
- Agent 通过 `artifact_list/get/read/publish/retire` 使用共享空间；Main Agent 另有 `artifact_promote`。`publish` 接受私有 workspace 文件或直接文本内容。
- 写入 namespace 按 role 限制；`inputs` 和 `evidence` 不向普通 Agent 开放。Published artifact 默认 task 内可读，项目提升后才对同项目其他 task 可见。
- `ResultHandoff`、Context Handoff 和 Evidence 可以引用精确 `artifactId + version + digest`；绝对路径只作为本机 materialization，不再是跨 Agent 的正式身份。
- 大内容只以 metadata 进入 briefing，正文必须显式 `artifact_read`，避免 prompt 污染和上下文膨胀。
- 单文件、单任务总量、版本数和每 operation 发布次数由宿主配额限制；被引用的版本只能 retire/tombstone，不能物理删除。
- 对话 Web 增加“共享产物”页签，展示 namespace、版本、信任状态、provenance、digest、内容预览、下载和版本事件。

## 后果

文献检索 Agent 可以发布 `research/source-list@1`，写作者、审查者和用户都能读取同一冻结版本；Plan、Review Report 和交付文件也不再依赖私有 worktree 偶然存在。

共享空间不取代任务图、handoff 或 Evidence。控制流仍由正式图边决定，验收仍由 Evidence 规则决定，artifact 只提供内容发现与版本化。项目级提升是显式动作，不会把某次任务的错误或敏感资料自动扩散到其他任务。

## 增补（2026-09-30）：一个交付物发一次，失败必须留下原因

形状 A 复跑（任务 `68543fed`）量出两条与本 ADR 直接相关的缺陷：

**一、声明了 `deliverable` 的节点必然产出两份逐字节相同的版本。** 7 个节点里只有 review-a/b/c 声明了 deliverable，也只有它们出现「同名两版本、digest 相同」（`341eaad270` / `62cdf31714` / `14e5b5d323`），两次来自同一个 operation：一次是节点自己用 `artifact_publish` 发的，一次是 harness 结算时按声明补发的。原因是补发只检查「文件存在且非空」，不看同名最新版本是否已经是这些字节。**声明 deliverable 的语义是「怕节点忘了发」，不是「一定发两遍」**，所以：`ArtifactWorkspace.head()` 提供最新版本的 digest，`publishDeliverable` 在字节相同时**不新增版本**——版本链只表示「内容变了」。验收证据仍按**磁盘上的文件内容**登记，与是否新增版本无关。

**二、`publish` 的「源文件必须位于本次操作的工作副本内」只能靠撞墙试出来。** 27 次 `artifact_publish` 里 7 次失败，全部是节点把报告写在 `/tmp` 再发布；而失败在记录里只剩一个布尔（`node_entries` 只有 `{isError:true}`、`tool-calls/*.jsonl` 只有 `isError` 与耗时），原因只存在于模型自己的下一句话里。因此：工具描述**开门见山**写明该约束并把 `content` 作为替代，拒绝消息给出**改法**（「写进工作副本再发布，或直接用 content 正文」），并且**任何工具失败都把原因写进记录**（`node_entries.data.message` 与结果行文本，有界截断；`message.tool` 事件同样带上）。
