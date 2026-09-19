# Graph 共享 Agent Work 空间研究报告

日期：2026-09-19

状态：研究完成，结论已形成；尚无 ADR，也未进入实施。

## 1. 结论

Graph 需要新增“共享 work 空间”，但不应把它实现成一个所有 Agent 都可并发读写的全局裸目录。建议采用：

**任务级、发布式、不可变版本的 artifact workspace。**

产品文档已经把“共享空间”定义为存放任务说明、证据与产物的空间，代码修改仍在各自工作副本中产生，见 [graph-mvp.md](../graph-mvp.md#L75) 与 [CONTEXT.md](../../CONTEXT.md#L21)。因此需要讨论的不是“要不要在产品里加入共享空间”，而是 **如何把已经确认的共享空间合同落成一个安全、可发现、可审计的物理协议**。

它的核心契约是：

- 每个 Agent 仍只在独立工作副本和私有 scratch 中写代码、草稿和日志。
- 所有 Agent 默认可以读取同一 task 下已经发布的 artifact。
- 写入共享空间不是直接修改公共文件，而是通过 `artifact_publish` 发布一个新版本。
- 结构化 `ResultHandoff`、`Evidence` 和 artifact 元数据继续承担控制面与审计作用；共享空间只承担大内容、跨节点发现和可浏览产物。
- 正式依赖、审查和验收引用精确 `artifactId + version + digest`，不能静默跟随“latest”。
- 跨 task 的复用另做显式 promotion，不能默认污染所有任务。

现有实现已经能支持“明确的前驱到后继交接”和“程序检查证据”，但还不能支持“非直接依赖节点主动发现前驱产物”“多个节点围绕同一逻辑产物形成版本历史”“用户或 Main Agent 浏览任务产物”。因此应扩展现有 `Artifact / Evidence / ResultHandoff`，而不是再建立一套与它们竞争的机制。

## 2. 场景分类

| 场景 | 是否必须共享空间 | 建议机制 |
| --- | --- | --- |
| 实现节点把完成结果交给直接依赖的下游 | 否 | 现有 `ResultHandoff` + 精确 `artifactRefs` |
| 独立审查只读取固定实现版本 | 否 | 现有 `evidence_only`，artifact 引用必须含精确 digest |
| 研究 Agent 产出文献列表，写作者和审查者都可按主题发现 | 是 | 任务级 artifact registry，发布 `source-list@1` |
| 多个并行节点产出候选，汇总节点需要统一浏览和比较 | 是 | 共享 namespace + 版本 + producer/provenance |
| Plan、设计说明或报告需要迭代 | 是，但不能原地改 | 逻辑名不变、每次发布新 version；formal consumer 固定版本；Plan 的调度权威仍是 proposal/graph revision，artifact 只保存说明与附件 |
| Review Agent 的报告要交给返工实现或 Main Agent | 部分是 | 报告作为不可变 artifact；控制流仍由 graph edge 决定 |
| Agent 私有 scratch、临时下载、工具缓存 | 否 | 私有 operation/instance 目录，按 TTL 清理 |
| 同一项目多个 task 复用资料 | 暂不需要任务级共享 | 后续项目级 knowledge store + 人工/策略 promotion |
| 用户或 Main Agent 浏览任务全部产物 | 是 | workspace 查询与只读 UI，不能靠遍历 Agent 私有 worktree |

研究文献是最明显的需要场景：检索 Agent 不应把大量结果直接塞进所有后继模型的 prompt；它应发布一个具有来源、schema 和摘要的 artifact，其他 Agent 按需读取。Plan、Review Report 同理，但必须区分“可迭代逻辑对象”和“某个已冻结版本”。

## 3. 现有机制盘点

### 3.1 私有工作副本

Git-backed task 的 integration worktree 位于 `stateDir/worktrees/<taskId>/integration`，每个 Agent instance 另有 worktree；代码结果通过 instance branch 合入 integration branch。见 [GitIntegration.prepareTask](../../src/git/integration.ts#L220) 与 [GitIntegration.workspace](../../src/git/integration.ts#L239)。

这个边界适合代码改动，不适合共享文档与研究报告：

- 共享内容若直接写进 instance worktree，会被 Git 当业务改动提交和合并。
- 每个 instance 的 worktree 不能作为其他 Agent 的稳定读取根。
- raw scratch 不适合作为正式 artifact，也没有统一 schema、配额和审计。

### 3.2 ResultHandoff 与 ContextHandoff

`ResultHandoff` 已包含 objective、outcome、workSummary、changes、decisions、verification、knownLimits、openQuestions、nextActions，并绑定 source node、instance、operation、activation、outputVersion 和 operation result digest。见 [types.ts](../../src/core/types.ts#L40) 与 [predecessor-handoff.ts](../../src/core/predecessor-handoff.ts#L395)。

Fresh context 的 `artifactRefs` 目前由 incoming dependency sources 展平得到，见 [execution.ts](../../src/core/execution.ts#L526)。`renderPredecessorHandoffs` 只把直接依赖 projection 渲染给模型，见 [predecessor-handoff.ts](../../src/core/predecessor-handoff.ts#L456)。

这能保证直接依赖的精确交接，但存在三个缺口：

1. 没有依赖边的节点无法发现同 task 的已发布 artifact。
2. `changes` 只是摘要和引用，不是可查询 artifact 目录。
3. artifact 没有稳定逻辑名、version、mediaType、size、trust 和生命周期。

### 3.3 Artifact

`ArtifactInput` 当前只有 `id + absolute path + SHA-256 digest`，见 [types.ts](../../src/core/types.ts#L174)。结果结算会校验 ID 唯一、路径绝对、digest 为 SHA-256，见 [operation-lifecycle.ts](../../src/core/operation-lifecycle.ts#L782) 和 [operation-lifecycle.ts](../../src/core/operation-lifecycle.ts#L837)。

它已经具备了“内容身份”的基础，但缺少：

- `logicalKey` 与版本 lineage。
- MIME type、size、schema、tags、producer role。
- visibility、trust、retention 与 tombstone。
- task-scoped 发现、分页、查询和订阅。
- 与 `Evidence`、`ResultHandoff` 的外键关系。

现有 artifact 路径大多是 producer 机器上的绝对路径；但 Agent 的 `read/list_dir` 只允许访问自己的 worktree 和显式 capability read roots，见 [agent-tools.ts](../../src/runtime/agent-tools.ts#L69)。所以后继 Agent 即使从 handoff 看到绝对路径，通常也无法直接读取该文件。这个路径只适合当前宿主内部记账，不适合作为共享协议；未来应以稳定 `artifactId/version/digest` 为正式引用，路径只作为本机 materialization。

### 3.4 Evidence

`EvidenceInput` 绑定 acceptance、summary、artifact path 和 digest。结果结算要求 Evidence 只能由被分配的 program check 产生，见 [operation-lifecycle.ts](../../src/core/operation-lifecycle.ts#L832)。命令检查会把 stdout/stderr 写入检查文件，再生成 digest，见 [program-adapters.ts](../../src/core/program-adapters.ts#L113)。

Evidence 不应改造成通用文件共享：

- Evidence 表达“某验收项由哪个程序、在哪个 commit/activation 上被证明”。
- Review Report、Research Result 和 Plan 首先是 artifact；只有经过 verifier 形成正式结论后，才成为某 acceptance 的 Evidence。
- 共享空间可以保存 evidence 对应的原始输出，但不能让任意 Agent 直接写 `evidence/`。

### 3.5 SQLite 与 Briefing

`result_handoffs` 已有独立表和 source identity 索引，见 [store.ts](../../src/core/store.ts#L328)。Context Handoff 会冻结 package digest 和 constraints digest，见 [context.ts](../../src/core/context.ts#L278) 和 [context.ts](../../src/core/context.ts#L304)。

Briefing 当前只列出 dependency artifacts，见 [briefing.ts](../../src/catalog/briefing.ts#L3)。这防止无关 artifact 自动污染上下文，但也意味着模型没有“按需列出同 task artifact”的入口。

### 3.6 结论：现有能力能满足什么

| 能力 | 现状 |
| --- | --- |
| 直接前驱结果交接 | 已满足 |
| evidence-only 独立审查 | 已满足 |
| 精确 digest 与版本失效 | 已满足 |
| Program check evidence | 已满足 |
| 跨非直接依赖发现 | 不满足 |
| 同一逻辑 artifact 多版本 | 不满足 |
| 大文件与二进制共享 | 仅有 path/digest，缺少 registry |
| 浏览、检索、配额、清理、审计 | 不满足 |

## 4. 外部系统证据

### 4.1 Google A2A：Artifact 是 task output，不是消息历史

A2A 明确区分 Message 和 Artifact：Message 用于发起任务、澄清、状态和追加输入；任务结果应通过关联到 Task 的 Artifact 返回，见 [A2A Specification: Messages and Artifacts](https://a2a-protocol.org/latest/specification/#37-messages-and-artifacts)。

A2A Artifact 必须具有 task 内唯一 `artifactId`，由至少一个 Part 组成；Part 可以承载 text、raw file、URL 或 structured data，并带 media type，见 [A2A Artifact](https://a2a-protocol.org/latest/specification/#417-artifact) 与官方 [a2a.proto](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto)。其 streaming update 还定义了 `append` 与 `lastChunk`，说明大 artifact 应有明确的发布完成语义，见 [TaskArtifactUpdateEvent](https://a2a-protocol.org/latest/specification/#422-taskartifactupdateevent)。

对 Graph 的启发：

- Artifact 归属于 task，不应只存在于某条聊天消息。
- 大内容应引用稳定 artifact，不应靠 Message 传递。
- 流式写入必须有 finalization，不能把部分文件当成已发布版本。

### 4.2 MCP：URI Resource、发现与 roots

MCP Resources 用唯一 URI 表示文件、数据库 schema 或应用数据；client 可通过 `resources/list` 发现、`resources/read` 读取、`resources/templates/list` 发现参数化资源，并可选订阅更新，见 [MCP Resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)。

官方 filesystem server 使用 allowed directories 或 MCP Roots 限制所有文件操作，见 [MCP Filesystem Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)。roots 会在初始化时替换 allowed directories，并可通过 `roots/list_changed` 动态更新。

对 Graph 的启发：

- 共享 artifact 应有稳定 URI，不应以裸绝对路径作为公共身份。
- 读取接口可以借鉴 MCP Resource：list metadata、read content、可选 subscribe。
- filesystem root 只是暴露方式，不是版本与权限协议本身；不能通过给所有 Agent 同一个 RW root 解决协作语义。

### 4.3 OpenAI Agents SDK：session 是会话历史，不是 artifact store

OpenAI Agents SDK 的 Session 在每次 run 前取 conversation history、run 后保存新 item，见 [Agents SDK Sessions](https://openai.github.io/openai-agents-python/sessions/)。Handoff 被建模为 tool，可用 `input_filter` 控制下一 Agent 看到的历史，见 [Agents SDK Handoffs](https://openai.github.io/openai-agents-python/handoffs/)。

RunResult 暴露 `final_output`、`new_items`、`last_agent`、streaming state 等 surface，见 [Agents SDK Results](https://openai.github.io/openai-agents-python/results/)。

对 Graph 的启发：

- session/history 负责连续对话，不应承担大文件、版本和共享目录。
- handoff 不应等于共享全部历史；Graph 的 `result_handoff` / `evidence_only` 与官方 `input_filter` 的思路一致。

### 4.4 Google ADK：Artifact service 独立于 session state

ADK 把 Artifact 定义为按 filename 标识、自动版本化的数据，可作用域到 session 或跨 session 的 user；Artifact service 负责 save、load、list keys、list versions、delete，并返回 version 或带 canonical URI 的 metadata，见 [ADK Artifacts](https://google.github.io/adk-docs/artifacts/)。

ADK 明确建议小配置和会话数据放 session state，大二进制、报告、图片和缓存放 artifact；Artifact 不直接存在 agent 或 session state 中。其 session/state/memory 分层见 [ADK Sessions](https://google.github.io/adk-docs/sessions/)。

对 Graph 的启发：

- 采用 task-scoped artifact service 是成熟设计。
- 逻辑名 + version + canonical URI 比纯绝对路径更适合共享。
- session-scoped 与 cross-session/user-scoped 要显式分层。

### 4.5 LangGraph：thread state 与 cross-thread store 分层

LangGraph persistence 同时提供：

- Checkpointer：保存单个 thread 的 graph state，用于恢复、human-in-the-loop、time travel 和 fault tolerance。
- Store：保存跨 thread 的 application-defined key-value，用于用户偏好、事实和 shared knowledge。

见 [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) 与 [LangGraph Stores](https://docs.langchain.com/oss/python/langgraph/stores)。

对 Graph 的启发：

- 任务运行状态、handoff 和共享知识不应混成一张表或一个目录。
- “task 内共享”与“跨 task 长期共享”是两个 scope，不能一步合并。

### 4.6 外部设计综合

各系统的共同点不是“大家共享一个可写目录”，而是：

1. 大内容与 conversation/session 分离。
2. artifact 有稳定 ID、URI、媒体类型和版本。
3. discovery 与 read 是显式动作。
4. task/thread/session scope 与长期 store scope 明确区分。
5. 写权限和根目录必须由 host 控制。

因此，Graph 应使用 task-scoped artifact workspace，而不是全局 mutable filesystem。

## 5. 建议架构

### 5.1 四个平面

| 平面 | 职责 | 是否可变 | 默认可见范围 |
| --- | --- | --- | --- |
| Private work copy | 代码、构建、临时文件、Agent scratch | 是 | 所属 instance/operation |
| Structured handoff | 目标、摘要、决策、验证、限制、artifact refs | operation 结算后冻结 | 按 graph edge 投影 |
| Task artifact workspace | 报告、计划、检索结果、交付文件、证据正文 | 逻辑名可变，版本不可变 | 同 task 已发布内容默认可读 |
| Evidence ledger | acceptance 与程序验证结论 | 只追加、可失效 | graph verifier、Main Agent、审计 |

结构化 handoff 负责“告诉下游发生了什么”；artifact workspace 负责“内容在哪里、有哪些版本、谁能读”；Evidence 负责“哪个验收被什么证明”。三者不能互相替代。

### 5.2 逻辑 URI

建议正式引用：

```text
graph://tasks/{taskId}/artifacts/{namespace}/{name}@{version}
```

示例：

```text
graph://tasks/01J.../artifacts/research/semantic-scholar-papers@1
graph://tasks/01J.../artifacts/plans/implementation@3
graph://tasks/01J.../artifacts/reviews/impl-commit-abc@2
graph://tasks/01J.../artifacts/deliverables/final-report@1
```

路径中的 `namespace` 和 `name` 必须是规范化 slug，不允许 `..`、绝对路径或平台保留名。原始文件名、扩展名、MIME、标题和描述放 metadata。

### 5.3 建议 namespace

```text
inputs/       # 用户/宿主输入；Agent 默认只读
plans/        # plan、设计说明、步骤
research/     # 文献、来源、检索结果
reviews/      # 审查报告、证据审查
deliverables/ # 最终或中间交付文件
summaries/    # Main Agent 汇总
evidence/     # 仅宿主/程序写；Agent 只读
archive/      # retired/tombstone
```

写权限按 role 和 graph policy 分配，不按目录名“约定”：

- `research/*`：research 类节点可写。
- `plans/*`：master/planner 节点可写；consumer 只读。
- `reviews/*`：review 节点可写。
- `deliverables/*`：声明的 producer 或 master 可写。
- `evidence/*`：host/program only。
- `inputs/*`：用户/宿主 only。

### 5.4 物理存储

建议放在 Graph protected state，而不是项目 worktree：

```text
$GRAPH_STATE/artifacts/
  objects/sha256/<prefix>/<digest>          # 不可变内容
  tasks/<taskId>/staging/<operationId>/     # 私有、可清理
  tasks/<taskId>/views/                     # 生成的只读物化视图
  tasks/<taskId>/manifest.json              # 可选，便于非 SQLite 工具检查
```

SQLite 保存权威 metadata：

```text
artifacts(
  id, task_id, namespace, name, logical_key, version,
  object_digest, size, media_type, schema_kind, schema_version,
  producer_node_id, producer_instance_id, operation_id,
  activation_id, output_version, visibility, trust, state,
  supersedes_id, created_at, retired_at, metadata
)

artifact_links(
  artifact_id, subject_kind, subject_id, relation
)

artifact_events(
  cursor, task_id, artifact_id, type, data, timestamp
)
```

`objects/` 是内容身份，`views/` 只是本机 convenience path。正式引用仍是 URI + digest，不能把 view path 当成跨机器稳定身份。

### 5.5 发布协议

工具名建议使用 `artifact_*`，不要使用 `workspace_*`。现有代码中的 `workspace` 已专指 Agent 私有工作副本；共享协议若复用该词，会让模型和实现都难以区分“我的 worktree”与“任务共享产物”。

1. Agent 在私有 staging 写完整内容。
2. 调用 `artifact_publish`，提交逻辑名、namespace、media type、schema、source path、tags 和可选 `expectedVersion`。
3. Host 校验路径、symlink、大小、MIME、schema、namespace ACL 和 quota。
4. Host 计算 SHA-256，原子移动到 object store，再插入 `artifacts` 行。
5. 同一 `logicalKey` 已存在时，追加 version，不覆盖旧文件；`expectedVersion` 不匹配返回 `artifact_conflict`。
6. 发布结束后生成只读 view，并写 `artifact.published` event。
7. 下游只能读取已 finalization 的 version；staging 内容不可见。

该协议允许逻辑对象继续演化，同时保证任何已冻结引用不会变化。

### 5.6 版本与冲突

- 版本不可变；`latest` 只用于人类浏览和探索，不用于 graph edge、review 或 evidence。
- 每个 `logicalKey` 维持一个 head version；publish 用 compare-and-swap 更新。
- 冲突时不做隐式 merge。保留两个候选，由 producer 或 master 发布一个注明 `supersedes` 的新版本。
- Review、verification 和 `ResultHandoff` 引用精确 version 和 digest。
- 返工产生新 version 后，旧 activation/evidence 不自动复活。

### 5.7 防污染

- Published artifact 默认标为 `unverified`；review 后标 `reviewed`；验收后标 `accepted`。
- `trust` 是 metadata，不会自动提升；只有 host/verifier 能提升。
- Artifact 内容是 data，不是 agent instruction。模型读到外部文本时，必须保留 provenance 和 warning。
- `research/` 可以包含不可信网页摘录；不得自动提升到 `evidence/`。
- Secrets 不得写入 artifact；需要凭据时只保存 credential reference，不保存 value。
- 同 task 默认可读，但敏感 artifact 可设 `visibility=task|review|owner|user`。
- Independent review 只能读取 frozen versions，不能读取 producer 的 mutable staging。

### 5.8 权限

权限应在 operation admission 时冻结，并与现有 access policy 分开：

- `artifact.read`: task-scoped read 或指定 visibility。
- `artifact.publish`: 按 task、role、namespace 和 producer identity。
- `artifact.retire`: 默认只有 producer/master；被 evidence 引用的版本只能 tombstone。
- `artifact.promote`: 跨 task/project promotion，默认需要用户或 Main Agent 提案批准。

“完全访问”只扩大 host filesystem 访问，不应自动取消 artifact 的版本、provenance 和 task isolation 规则。Graph 正式状态仍属于受保护控制面。

### 5.9 配额、保留与审计

- 分别限制单 artifact、单 task 总字节、单 logicalKey 版本数、每 operation publish 次数。
- 超限 fail closed，不截断、不静默覆盖。
- object 以 digest 去重；引用计数归零并过 retention 后才能 GC。
- Evidence/Handoff 引用过的版本不得物理删除，只能 `retired`/tombstone。
- Staging 在 operation 失败或超时后按 TTL 清理。
- 记录 publish、link、retire、promote 和 content consumed 事件；不必记录每次普通 list。
- 大 artifact 内容不入 conversation stream、不自动入 briefing，只列 metadata。

### 5.10 与现有机制集成

- `ResultHandoff.changes` 保持现有字段，增加可选 `artifactId`、`version`、`uri`。
- `ContextHandoffPackage.artifactRefs` 从 path/digest 扩展为 immutable artifact ref。
- `EvidenceInput.artifact` 增加 `artifactId`，旧 path/digest 保留兼容。
- `briefing` 只列可见 artifact metadata 和按需读取提示，不注入全文。
- `contextView` 显示 artifact version、producer、digest 和 trust。
- Main Agent 通过 `artifact_list/get` 读取，不用遍历 instance worktree。

## 6. 工具接口草案

### 6.1 查询

```json
{
  "name": "artifact_list",
  "arguments": {
    "namespace": "research",
    "prefix": "semantic-scholar",
    "schema": "source-list@1",
    "tag": "peer-reviewed",
    "trust": "reviewed",
    "includeRetired": false,
    "limit": 50,
    "cursor": null
  }
}
```

返回 metadata、URI、version、digest、producer 和 summary，不返回大正文。

### 6.2 元数据与正文

```json
{
  "name": "artifact_get",
  "arguments": {
    "artifactId": "artifact-uuid",
    "version": 3
  }
}
```

```json
{
  "name": "artifact_read",
  "arguments": {
    "uri": "graph://tasks/t/artifacts/research/papers@3",
    "maxBytes": 262144
  }
}
```

`artifact_read` 必须有大小上限、range 和 text/binary 区分。二进制默认返回可 materialize 的只读路径或 blob reference，不把 base64 塞进模型上下文。

### 6.3 发布

```json
{
  "name": "artifact_publish",
  "arguments": {
    "namespace": "research",
    "name": "semantic-scholar-papers",
    "sourcePath": "/private/staging/papers.json",
    "mediaType": "application/json",
    "schema": "source-list@1",
    "summary": "Semantic Scholar filter results",
    "tags": ["literature", "semantic-scholar"],
    "expectedVersion": 0,
    "requestId": "publish-..."
  }
}
```

`requestId` 保证重试幂等。返回值必须包含 artifactId、version、URI、digest 和是否 superseded。

### 6.4 生命周期

```json
{
  "name": "artifact_retire",
  "arguments": {
    "artifactId": "artifact-uuid",
    "reason": "superseded by a corrected source list",
    "requestId": "retire-..."
  }
}
```

跨 task promotion 不应成为第一阶段工具；需要时单独设计 `artifact_promote` 和用户审批。

## 7. 风险与反例

### 7.1 全局可写目录会产生丢失更新

两个 Agent 同时写 `research/papers.json` 或 `plans/implementation.md`，后写会覆盖先写。仅靠文件锁无法表达 provenance、review 和 evidence。

反制：immutable version + CAS head + explicit supersedes。

### 7.2 所有 artifact 自动注入会污染 prompt

文献搜索结果可能包含外部指令、过期信息或恶意文本。如果把所有 artifact 都放进 briefing，context 会爆炸并扩大 prompt injection 面。

反制：list/read 显式化；briefing 只放 metadata；外部内容标 `unverified`。

### 7.3 `latest` 会破坏可复现性

Review 在 v1 上通过，但 consumer 读取 v2 后误以为仍被验证。

反制：formal edge、review 和 evidence 只能引用精确 version + digest；latest 仅供人类浏览。

### 7.4 共享目录位于项目 worktree 会污染交付

Artifact 会被 Git commit，甚至被错误合入目标分支。

反制：放在 protected Graph state；代码交付继续走 integration branch。

### 7.5 删除 artifact 可能破坏 evidence

清理逻辑名或旧版本会让历史 review/evidence 无法解释。

反制：被引用版本只 retire，不 hard delete；GC 只处理无引用的 object。

### 7.6 跨 task 共享会成为污染面

一个任务的错误假设或敏感资料被其他任务自动读取。

反制：第一阶段不跨 task；promotion 必须显式、带来源和审批。

### 7.7 Full Access 与 artifact invariant 混淆

用户开启完全访问，不等于允许绕过 Graph 的版本、ACL 和 audit。

反制：把 host filesystem access 与 artifact protocol 分开；Graph state 仍受保护。

## 8. 分阶段落地建议

### P0：协议与失败关闭

- 定义 ArtifactRef、ArtifactVersion metadata、URI 和 namespace/ACL。
- 增加 SQLite schema 与 migration。
- 实现 hash、path traversal、symlink、size、schema、CAS、quota 单元测试。
- 明确 `latest` 不可用于 formal edge。

出口：没有共享读写 UI，也能证明非法 publish 全部失败关闭。

### P1：任务级 read/publish MVP

- `artifact_list/get/read/publish/retire`。
- private staging → immutable object → metadata transaction。
- task-scoped default read，role/namespace write ACL。
- Conversation/Node UI 显示 artifact tree、version、producer 和 digest。

出口：Research Agent 发布 source list，Writer 和 Reviewer 能分别读取同一版本。

### P2：Graph 集成

- `ResultHandoff`、Context Handoff、Briefing 和 Evidence 接受 ArtifactRef。
- 返工/activation 失效同步到 artifact link。
- Independent review 只读 evidence-only frozen versions。
- Main Agent 可以按需浏览和汇总，不自动注入全文。

出口：图上的 review 和 evidence 能追溯到精确 artifact version，旧版本失效时 fail closed。

### P3：生命周期与配额

- retention、GC、tombstone、quota、staging TTL。
- publish/retire/promote/consume 事件和审计页面。
- 冲突恢复和 crash recovery。

出口：并发 publish 不丢失版本，进程崩溃后不会暴露 half-published artifact。

### P4：项目级知识 promotion

- 将稳定 artifact 显式提升到 project/user knowledge store。
- 搜索、标签、semantic index 作为后续能力，不进入任务级一致性路径。

出口：跨 task 复用需要明确批准，且不影响原 task 的 frozen evidence。

## 9. 测试与验收出口

| 范围 | 必须证明 |
| --- | --- |
| Path safety | `..`、absolute path、symlink、hardlink、device file 不能越出 staging/object root |
| Integrity | publish 后 digest、size、MIME 与内容一致；篡改后读取失败 |
| Versioning | 同 logicalKey 可形成 v1/v2；旧 version 不变；CAS 冲突保留双方 |
| Formal refs | review/evidence 固定 version；latest 改变不会改变旧结论 |
| Isolation | task A 不能读取 task B，除非显式 promotion |
| Permission | role/namespace ACL 生效；evidence 不能由普通 Agent 写 |
| Concurrency | 两 operation 同时 publish 无 lost update；requestId 重试幂等 |
| Crash recovery | staging 中断不产生可见 version；object/metadata 不出现半提交 |
| Context | briefing 只含 metadata；大 artifact 不自动进入 prompt |
| Lifecycle | 被引用 artifact 不可 hard delete；无引用 object 可 GC |
| UI | artifact tree、版本、producer、digest、retire 状态可查看 |
| Production | Research → Writer → Review → Rework 的真实图使用同一 task workspace 完成闭环 |

## 10. 开放问题

1. 默认 task artifact quota 和单文件上限是多少？
2. task 完成后 artifact 保留多久，用户是否可导出到项目目录？
3. `artifact_publish` 是否允许模型自定义 namespace，还是由 role policy 固定？
4. `artifact_read` 对大文本是否支持 range 和摘要缓存？
5. 是否需要把 workspace 暴露成 MCP Resources，供外部 Agent 读取？
6. Plan 是否允许注释式并行编辑；若需要，采用 patch artifact 还是 CRDT 子服务？
7. Project-level promotion 的审批主体是用户、Main Agent 还是二者组合？
8. Artifact `trust` 是否需要在 UI 上显示为 gate，而不仅是标签？
9. Evidence 是否保存 artifact ID 作为正式外键，还是继续以 path/digest 为兼容主体？
10. 是否需要对研究来源做 citation schema 和去重规则，而不是只保存通用 JSON？

## 11. 建议决策摘要

建议接受以下产品与架构方向：

1. 增加共享 work 空间，但定义为 task-scoped artifact workspace。
2. 不做所有 Agent 共写的 mutable filesystem。
3. Published version 不可变；逻辑对象通过新版本演化。
4. Private worktree 继续负责代码，integration branch 继续负责交付。
5. ResultHandoff 负责控制流与摘要，Artifact 负责内容，Evidence 负责验收证明。
6. 所有 formal consumer 引用精确 artifact version 和 digest。
7. 第一阶段只支持 task-scoped 共享，跨 task promotion 后置。
8. 权限、配额、清理和审计由 host 实现，不交给模型约定。

这能让文献检索、计划、审查报告和交付文件真正被其他 Agent 发现和复用，同时保留 Graph 已有的上下文隔离、审查独立性和精确证据能力。

## 外部来源

- [Google A2A Specification](https://a2a-protocol.org/latest/specification/)
- [Google A2A proto](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto)
- [MCP Resources Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [MCP Filesystem Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
- [OpenAI Agents SDK Sessions](https://openai.github.io/openai-agents-python/sessions/)
- [OpenAI Agents SDK Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [OpenAI Agents SDK Results](https://openai.github.io/openai-agents-python/results/)
- [Google ADK Artifacts](https://google.github.io/adk-docs/artifacts/)
- [Google ADK Sessions, State and Memory](https://google.github.io/adk-docs/sessions/)
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangGraph Stores](https://docs.langchain.com/oss/python/langgraph/stores)
- [LangGraph Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)
