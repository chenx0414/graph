# Graph Agent 上下文模型一手研究

研究日期：2026-09-17

实现状态：本报告提出的 Continue/Fresh/Fork、handoff、预算作用域与 lineage 已落地；正式决策见 [ADR 0014](../../adr/0014-agent-context-continuity.md)。

研究基线：

- Graph 分支 `feat/app-ux`，当前 HEAD `79861e9928845621dc05633f5ce20a3c64447029`。
- Pi 三个包精确锁定为 `@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent` `0.85.1`，见 `package.json:45-47`。
- Pi `v0.85.1` tag 对应 commit `d981de1229ef899957bbe968bc8dcda02a21f477`，本次用 `git ls-remote` 核对；GitHub 源码引用固定到该 commit。
- 本报告只使用仓库锁定版本的已安装源码/类型/README/examples、固定版本 GitHub 源码，以及 Anthropic/Claude Code 官方产品文档。OpenAI `developers.openai.com`、`platform.openai.com` 在本次环境返回 HTTP 403，因此没有把 OpenAI 二手说明或未打开的链接当作证据；OpenAI/Codex 特有结论不在本报告中成立。

## 结论摘要

### 合理部分

1. **三分类方向合理。** Claude Code 官方当前把 subagent 明确分成非 fork 与 fork：普通 subagent 从“fresh, isolated context window”开始，fork 才继承完整主会话；fork 会放弃普通 subagent 的输入隔离。Pi 也同时提供新 session、指定 leaf 提取新 session、以及同文件 tree navigation，足以实现这两类语义。[Claude Code subagents: Manage subagent context](https://code.claude.com/docs/en/sub-agents#manage-subagent-context)、[Fork the current conversation](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation)
2. **“探索产生大量临时 Context”应优先 Fresh。** Anthropic 的 context engineering 明确把 sub-agent 架构列为隔离深层工具搜索、只把 condensed summary 返回主 Agent 的方法；multi-agent research 文章也说明 subagent 使用独立 context window，适合并行探索和压缩结果。主 Agent 不应承接搜索日志、测试输出和临时文件读取。[Effective context engineering: Sub-agent architectures](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、[Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
3. **“独立判断需要 Fresh”方向合理，但 Fresh 本身不等于独立。** Fresh 只保证初始 transcript 隔离；若 system prompt、工具、证据副本、模型和 provider cache 仍相同，仍可能产生相关性偏差。独立验证必须再定义“只看冻结证据、不看父 transcript、必要时排除实现模型”的策略。
4. **主 Agent 连续执行合理。** main 适合用户对话、需求澄清、全局规划和跨轮决策。这里的“连续”应定义为同一 `AgentInstance` 和同一持久 session 跨 operation 恢复，不应定义为常驻一个 Pi OS 进程。Graph 当前每次 operation 启动独立 Pi 进程，见 `src/runtime/pi-adapter.ts:383-403`、`src/runtime/pi-process.ts:117-120`。

### 需要修正的部分

1. **不要把“继承完整 Context”等同于复用同一个 session。** Pi 的持久 fork 是“复制指定 branch 到新 session file，产生新 session ID”，不是让两个 Agent 共享同一个可变 session。并行 Agent 共享同一 session file 未见锁支持，且各 manager 会缓存完整 entry index；不得把它作为并发分支机制。相关实现见 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1088-1199`、`...:739-767`。
2. **Fork 不应默认用于探索。** 普通探索应 Fresh；Fork 应用于“必须保留共同前缀的路径连续分支”，例如从同一实现现场并行尝试两个修复、继续一个已有但未总结的调试路径，或 fork 后直接调用父会话中已建立的私有工作状态。Claude Code 也把 fork 描述为继承完整会话的例外，并指出它放弃了普通 subagent 的输入隔离。[Claude Code: Fork the current conversation](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation)
3. **Fork 不能被当成“更便宜”。** Claude Code 的 fork 因 system prompt、tools 和消息前缀完全相同而可复用 prompt cache；Pi 会把 session ID 传给 cache-aware backend，但 fork 产生新 session ID，provider 是否仍命中、如何计费取决于供应商和缓存策略。Graph 只能按实际 usage 结算，不能预先假定 fork 命中缓存。[Pi `agent-session.js:1254-1271`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L1254-L1271)、[`agent.d.ts:49-50`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/types.ts#L49-L50)
4. **Fork 的“完整上下文”必须拆成四个轴。**
   - transcript：当前 leaf 上的有效 messages；
   - runtime state：model、thinking level；
   - identity/instructions：Agent definition、system prompt、capability bundle、tools；
   - authority/resources：workspace、task grants、预算、审计范围。

   Pi session JSONL 只稳定承载 transcript 和 model/thinking 历史，不承载 ResourceLoader、Skills、MCP、extensions、system prompt 或 Graph 权限。见 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:232-236`、`docs/adr/0011-isolated-pi-process-capability-bundles.md:24`。
5. **现有 Graph 术语里的 `decision_digest` 不是哈希。** 它实际保存的是用户已审阅的 decision/constraint 文本快照：`src/core/store.ts:165-169`、`src/core/task-runtime.ts:921-927`。新模型应把 summary text、handoff digest 和 evidence digest 分开，否则审计语义会混淆。
6. **模型不能任意选择 Fork/Fresh。** 模型可以提出 `purpose`、所需事实和是否要求独立性，实际 mode 必须由 Graph 的 resolver 按结构条件选择并记录原因。
7. **ADR 0004 需要显式适配。** 当前约束是 Agent 实例与 Agent 节点一一对应，见 `docs/adr/0004-agent-node-identity.md:1-5`。Fork 若产生自己的 session、预算、结果和审计线，应成为新的 Agent node + `AgentInstance`，而不是让一个实例对应多个节点；或者引入会改变该 ADR 的新实体。MVP 应选前者。

### 当前可实现程度

| 能力 | 判定 | 原因 |
| --- | --- | --- |
| main 跨轮连续 | 支持 | 同一 instance、同一 session file 恢复；每次 operation 新进程，见 `src/runtime/pi-instance.ts:111-116`、`src/runtime/pi-adapter.ts:383-407`。 |
| Fresh subagent | 支持 | 新 instance 目前使用 `SessionManager.create`，加载独立 capability prompts，再发送 briefing，见 `src/runtime/pi-instance.ts:111-159`、`src/core/execution.ts:546-590`。 |
| 独立 review 的新 session | 支持，但独立性仍有限 | 当前 reviewer 已会排除实现用过的模型，见 `src/core/execution.ts:367-407`；尚未把“不得注入父 transcript、只能用冻结证据”做成正式策略。 |
| Fork 上下文快照 | 需适配 | Pi 有 `createBranchedSession` / `forkFrom` / `AgentSessionRuntime.fork`，但 Graph 没有 context mode、parent instance、source leaf、source digest、budget scope 或 lineage 事件。 |
| 同 session 的并行 fork | 不适合 | Pi 没有公开并发写保证；同一 session file 被多个 manager/process 同时追加会产生 lost update 风险。 |
| 让模型自行选 mode | 不适合 | 选择结果会影响成本、隔离、权限和审计，必须由程序按策略解析。 |

## 精确定义

下表把 `main` 定义为“继续同一条已有会话线”，把 `Fork` 定义为“从某条已有会话线的冻结 leaf 复制出一棵新会话线”，把 `Fresh` 定义为“只用冻结 handoff package 启动新会话线”。

| 维度 | main | Fork Subagent | Fresh Subagent |
| --- | --- | --- | --- |
| 输入 | 当前用户消息、当前 session 的完整有效上下文、运行态 briefing | 源 session 在指定 leaf 的有效上下文快照；另加任务 delta 或 steering。不能在复制 transcript 后再注入一份重复摘要 | 冻结的 handoff package、task、acceptance、decision/constraint、artifact references、必要的文件位置；没有父 transcript |
| 会话来源 | 已有 `SessionManager.open(sessionFile)` | 从源 session file 按 source leaf 提取 root-to-leaf path，写入新的 session file | `SessionManager.create` 新建空 session |
| `完整上下文` 的确切含义 | 同一 session 的当前 leaf 与继续写入的同一 history | root 到 source leaf 的有效 context，包含当前 compaction 后的 summary + kept messages；不包含 system prompt、tools、capability binding 或 task grants | 无 transcript 继承；只有 handoff 中显式列出的内容和 capability bundle |
| 持久化 | 原 file 与原 session ID 继续追加 | 新 file、新 session ID；原 file 不修改；新 header 的 `parentSession` 仅记录源路径 | 新 file、新 session ID；没有 source session |
| 身份 | 保持原 `AgentInstance` | 新 `AgentInstance`，并关联 source instance / source session / source leaf | 新 `AgentInstance`，并关联 handoff version |
| 并行 | 同一 instance 只能有一个 active run；可与其它 instance 并行 | 新 session file 后可并行；写入型任务仍需独立 worktree，避免代码写冲突 | 新 session file 后可并行；同样需要 worktree 隔离写入 |
| 隔离 | 无 context 隔离；依赖同一 conversation/history | 初始上下文相同，创建后与源 session 分叉；这不是独立判断 | 初始 transcript 隔离；但 model、prompt、tools、evidence、cache 仍可能相关 |
| 恢复 | 按原 session ID/file 恢复全部有效历史 | 按 fork session ID/file + source digest + capability digest 恢复；不能只凭可变路径恢复 | 按 fresh session ID/file + handoff digest 恢复；没有父 session 也可恢复 |
| 模型切换 | 同一 session 内追加 `model_change`，实例与额度不变 | 默认保持源 model/thinking 与 capability digest，以保证连续性/缓存前缀；若换 model 或 prompt，则记录为 rebrand，不再声称“完整继承” | 按新 AgentPolicy 选择 model/thinking；与源 Agent 无关 |
| 工具与权限 | 按原 instance 的 definition、capability 与任务 grants 执行 | 默认取源 tool policy 与任务 grant ceiling 的交集；不得因 fork 扩权。若 Graph 定义升级，fail closed，不静默重绑 | 由新 definition 决定工具；task grants 仍受原任务上限约束，安装能力不等于授权 |
| 计量 | 继续累计到原 instance / budget scope | 新 instance 记账，但必须挂在共享 `BudgetScope` 或显式子预算下，禁止用 fork 重置额度 | 新 instance 记账；挂在 handoff 所属预算域或计划分配的子预算下 |
| 审计 | 原 operation、node entries、session 连续 | 记录 parent instance、source session ID/file、source leaf、source context digest、新 session ID、模式选择原因 | 记录 handoff version/digest、artifact refs、source evidence；明确没有 transcript lineage |
| 主要失败模式 | 长历史污染、compaction 丢细节 | 复制了过多临时上下文；source 后续变化与 child 不一致；cache/成本判断错误 | 摘要失真、缺少隐含上下文、把“新 session”误当作真正独立验证 |

### 为什么“复制 messages”优于“复用同一 session”

Pi 的持久 fork 机制是复制式而不是共享式：

- `createBranchedSession(leafId)` 取 root 到 leaf 的 path，重建 parent 链，只复制该 path，生成新 session ID/file，并把 `parentSession` 指向旧 file。见 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1088-1199`。
- `forkFrom(sourcePath, targetCwd)` 把 source 的所有非 header entries 复制到新 file，生成新 session ID/file，并把 `parentSession` 指向 source。见 `...:1264-1303`。
- `AgentSessionRuntime.fork()` 在持久模式下也是通过 `createBranchedSession` 或 `newSession({ parentSession })` 替换为另一个 session；它不是让两个 runtime 复用同一 session。见 `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js:174-250`。
- `SessionManager.branch()` 和 `AgentSession.navigateTree()` 才是同 file tree 内移动 leaf；它们不产生新 session ID，也不是可并行的 subagent fork。见 `.../session-manager.js:1044-1086`、`.../agent-session.js:2471-2616`。

因此 Graph 的 Fork 应定义为：

```text
source session at immutable leaf
  -> extract active branch
  -> create new session file + new session ID
  -> reconstruct effective messages/model/thinking
  -> validate child context equals frozen source context
  -> then append delta/task
```

不是：

```text
parent session file
  -> two concurrent Agent processes append to the same file
```

### Fresh 在 Pi 上具体是什么

Fresh subagent 在当前 Graph 中已经是：

1. 新 Agent instance 使用新的 state dir。
2. `SessionManager.create(workspace, sessionsDir)` 创建空 session。
3. `DefaultResourceLoader` 根据新 Agent definition 生成 system prompt、skill 和 extension 环境。
4. Graph 生成 task briefing，并作为第一条 user prompt 发送。

对应实现为 `src/runtime/pi-instance.ts:111-159`、`src/runtime/capabilities.ts:344-379`、`src/catalog/briefing.ts:4-53`、`src/runtime/pi-adapter.ts:410-448`。因此 Fresh 不需要新的 Pi API；需要的是把它从“默认路径”变成有显式 identity、version 和 audit 的一等上下文模式。

## Pi API 事实表

| 事实 | 源码/官方来源 | 对 Graph 的含义 |
| --- | --- | --- |
| `createAgentSession()` 创建单个 `AgentSession`；session 管理 lifecycle、message history、model、compaction、event stream。 | `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:46-68` | 一个 Pi session 是对应一个 Agent 执行上下文的基本单位。 |
| `AgentSession` 公开 `prompt/steer/followUp/subscribe/setModel/compact/navigateTree/dispose`；new/resume/fork/import 在 `AgentSessionRuntime`。 | `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:66-167` | Graph 可继续用一 operation 一 session；fork 要经 runtime/session manager，不应自行改消息数组。 |
| `SessionManager.create/open/continueRecent/inMemory` 分别表示新 session、指定恢复、最近恢复、内存 session。 | `node_modules/@earendil-works/pi-coding-agent/examples/sdk/11-sessions.ts:9-43`、`dist/core/session-manager.d.ts:319-334` | Fresh 是 create；main/rework 是 open；不要用 continueRecent 恢复多实例。 |
| `createAgentSession()` 会从已有 session 恢复 messages、model、thinking；ResourceLoader 是另一个输入，不从 session 自动恢复。 | `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:80-131`、`...:239-267` | Fork 必须同时冻结 session snapshot 和 capability bundle。 |
| `buildSessionContext()` 只返回 `messages`、`thinkingLevel`、`model`。 | `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:117-124` | 不能把 session 当作工具权限、Agent identity 或 Graph grant 的持久化载体。 |
| JSONL 是 append-only tree；entry 有 `id`/`parentId`，leaf 决定当前 path。 | `node_modules/@earendil-works/pi-coding-agent/docs/session-format.md:1-3`、`...:174-185`、`...:306-317` | Fork 的 lineage 应记录 leaf 和 entry 范围，而不是只记录文件名。 |
| `createBranchedSession(leafId)` 只把 root-to-leaf path 提取到新 file，生成新 ID，并重链 parent；原 file 不改。 | `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1088-1199` | 这是 Graph Fork 最合适的 MVP primitive。 |
| `forkFrom()` 复制 source 的全部非 header entries，并把目标 cwd 写到新 header；新 session 的 active leaf 在加载时由最后一行 entry 推出。 | `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1264-1303`、`...:686-707` | 不应在已经 tree-branch 的 source 上无 leaf 地使用 `forkFrom` 实现“从当前 leaf fork”。优先 `createBranchedSession(sourceLeaf)`。 |
| 同 session tree navigation 会移动 leaf，可追加 `branch_summary`；它不是新 session。 | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2471-2616` | 适合单 Agent 交互式探索；不适合 Graph 的并行分支身份。 |
| session 加载时没有单独的持久 leaf pointer；`_buildIndex()` 遍历 entries 并把最后一个 entry 设为 leaf。 | `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:686-707` | Graph 若以后使用同文件 tree，必须额外持久化 active leaf，或只在 append 后恢复。 |
| 模型切换会更新 `agent.state.model`，并往同一 session 追加 `model_change`。 | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1254-1271` | main/rework 换模型保持 identity；fork 换模型则破坏“同 prompt/tool/cache prefix”假设。 |
| 手动 compaction 会追加 `compaction` entry，再从 session context 重建 `agent.state.messages`；自动 compaction 走同一 summary/entry 模式。 | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1474-1542`、`...:1614-1829` | Fork 复制的是“compaction-aware 有效上下文”，不是保证所有原始 prompt/tool result 都会再次发给模型。 |
| Pi 在 SDK 创建 `Agent` 时把 `sessionManager.getSessionId()` 传给 `Agent`；core Agent 把 `sessionId` 转发给 cache-aware backend。 | `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:226`、`node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts:49-50` | 新 session ID 可能影响 provider session affinity；是否影响 prompt cache/账单必须按 provider 实测。 |
| 某些兼容 provider 可配置 `sessionAffinityFormat`，用 session ID 发 affinity header；不是所有 provider/transport 都启用。 | `node_modules/@earendil-works/pi-coding-agent/docs/models.md:479-481` | Graph 不能统一承诺 fork 会共享缓存。 |
| `DefaultResourceLoader` 的 `systemPrompt/appendSystemPrompt` 与 session 分离；自定义 system prompt 走单独拼接分支。 | `node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.d.ts:67-118`、`dist/core/system-prompt.js:7-34` | Fork 若要保持相同 prompt/tool schema，必须复用精确 capability bundle digest。 |
| `systemPrompt`、tools、capability binding、Skill、MCP、extension 不写入 session JSONL；Graph 当前用实例 manifest 及 capability digest 补足。 | `docs/adr/0011-isolated-pi-process-capability-bundles.md:12-24`、`src/runtime/pi-instance.ts:56-63`、`...:91-100` | Fork 的持久恢复需要 Graph manifest，不能只依赖 Pi。 |
| Pi 官方 subagent 示例默认完整 Fresh：新 `pi` process、`--no-session`、新 system prompt、显式 tools，再把 `Task:` 作为 prompt。 | `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/README.md:1-12`、`.../index.ts:300-350` | 官方示例没有把父 transcript 复制给普通 subagent；这支持 Fresh 作为探索默认。 |
| Pi 没有内建 subagent orchestration；官方示例由 extension 自己 spawn、并行调度、汇总和 abort。 | `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts:540-710`、`docs/sdk.md:5-14` | Agent graph、预算、权限、恢复仍必须由 Graph 管理。 |
| Session 文件是 append-only JSONL；fork/clone 会复制部分 entries，而不是把原 file 压缩成共享引用。 | `node_modules/@earendil-works/pi-coding-agent/docs/session-format.md:1-3`、`dist/core/session-manager.js:1088-1199` | 大量 fork 会复制 context 和磁盘占用，需要保留策略。 |

## 一手材料对分类的支持与反驳

### Claude Code 支持“Fork vs Fresh”分类

Claude Code 官方明确写出两种模式：

- 普通 subagent 从 fresh isolated context window 开始，不看到 conversation history、已调用 Skills 或已读文件；主会话只传一个 delegation summary。
- Fork 继承整个 conversation，连同主会话的 system prompt、tools、model 和 message history；这是例外而不是默认。Fork 的工具调用仍不回写主 conversation，只回传最终结果。

来源：[Manage subagent context](https://code.claude.com/docs/en/sub-agents#manage-subagent-context)、[Fork the current conversation](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation)。

这对 Graph 的直接支持是：

- `Fresh` 与 `Fork` 是两个不同产品语义，不应只靠“新 session 还是旧 session”隐藏在 adapter 中。
- Fork 的优点是无需重述背景和可能复用相同前缀 cache；缺点是放弃 context 隔离。
- Fresh 适合大型日志、测试输出、资料读取和独立调查。

### Anthropic context engineering 反驳“Fork 是探索默认”

Anthropic 官方给出的原则是“find the smallest set of high-signal tokens”，并把 sub-agent architectures 描述为：子 Agent 在 clean context window 中完成专门任务，返回 condensed summary，主 Agent 保留高层协调上下文。[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

Anthropic multi-agent research 进一步说明：

- 每个 subagent 拥有自己的 context window 和 distinct tools/prompts/trajectory；
- breadth-first 搜索和并行资料调查是良好场景；
- multi-agent 的实测 token 消耗远高于 chat；
- 长任务接近 context 限制时，可以 spawn fresh subagents with clean contexts，并通过 handoff 保持连续性；
- 大结果应写入 filesystem，只把 lightweight references 回传，避免“game of telephone”。

来源：[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)。

结论：探索默认 Fresh；Fork 只在“精确共同前缀本身是完成任务所必需”时使用。

### Fresh 与“独立验证”之间还差一层策略

Fresh 提供的是 transcript isolation，不自动提供判断独立性。Graph 的独立验证至少需要：

- 不向 verifier 注入实现 Agent 的 transcript；
- 只给冻结 artifact、acceptance、decision/constraint 和明确的证据 schema；
- 模型选择继续排除该轮实现所用模型；
- 不共享实现 Agent 的私有工具状态；
- 记录 verifier 看到的 handoff digest、artifact digest、model 和 capability digest。

当前的模型排除已有实现基础，见 `src/core/execution.ts:367-407`；当前 review 输入也可以通过 `briefing()` 只拿依赖 artifacts 而不是父 transcript，见 `src/catalog/briefing.ts:4-53`。缺的是“必须 Fresh、必须 evidence-only、必须记录独立性事实”的一等规则。

## 选择启发式

### 三值模式，不用模型自选

模型中应有一个程序 resolver，输入结构化 request，输出唯一 mode：

```ts
type ContextRequest = {
  purpose: "discuss" | "explore" | "implement" | "review" | "verify" | "rework";
  source?: { instanceId: string; leafId: string };
  neededFacts: Array<
    | { kind: "artifact"; ref: string }
    | { kind: "decision"; ref: string }
    | { kind: "file"; ref: string }
    | { kind: "transcript_range"; from: string; to: string }
    | { kind: "tool_call"; ref: string }
  >;
  independence: "none" | "fresh" | "model-excluded";
};
```

模型只可提出 `purpose`、`neededFacts` 和独立性要求；不能直接指定 `mode`。

### 可执行判定规则

```text
resolveContext(request, graphState):
  1. If purpose == "rework" and target node already owns an instance/session:
       return CONTINUE with that instance.

  2. If independence != "none":
       require neededFacts has no transcript_range/tool_call;
       return FRESH with evidence-only handoff.

  3. If neededFacts contains transcript_range or tool_call:
       require source exists and exact capability/tool policy can be inherited;
       return FORK from source leaf.

  4. If source exists and request explicitly says "continue this branch from the exact prior state":
       return FORK.

  5. Otherwise:
       return FRESH with artifact/decision/file references.
```

程序还应额外校验：

- `FORK` 必须有有效 source instance、source session、source leaf 和可计算的 source context digest。
- `FORK` 默认必须使用与 source 相同的 Agent definition、capability digest、tool policy 和 model/thinking；不同则必须记录 `rebranded=true`，不再保证 cache prefix 或完整继承。
- `FRESH` handoff 必须包含 acceptance、decision/constraint、artifact refs 和输出 schema；缺项 fail closed。
- `review/verify` 不得仅因“新 session”就标为独立；必须满足 independence policy。
- `fork` 写入型任务必须使用独立 worktree；只读探索可以共享 read-only workspace。
- `fork` 不得创建新的预算逃逸口：子 instance 必须共享 `BudgetScope`，或从父预算显式划分子预算。

### 典型任务选择

| 任务 | 默认选择 | 原因 |
| --- | --- | --- |
| main 对话的下一轮 | CONTINUE | 用户需要同一对话身份和完整历史。 |
| 实现节点返工 | CONTINUE | ADR 0004 要求回到原实例与 session。 |
| 仓库搜索、日志分析、测试输出归纳 | FRESH | 高临时 token、结果可压缩；避免污染主/父上下文。 |
| 独立 code review、安全审查、事实核验 | FRESH + independence policy | 需要初始判断隔离，但仍需独立模型/证据策略。 |
| 从同一调试现场并行尝试两个修复 | FORK | 两个方向都依赖同一精确共同前缀。 |
| 继续已有但未总结的调试分支 | FORK | summary 会损失 call ID、隐式状态或路径依赖细节。 |
| 基于冻结 artifact 的替代实现 | FRESH | 只要 inputs/acceptance 足够，不应复制实现 Agent 的私有推理。 |
| 只是“将原 Agent 换个模型再问一次” | 不由 context mode 决定 | 这是 model policy；若仍用同一 transcript，应定义清楚是否允许缓存与同源偏差。 |

### 禁止的判定方式

- 禁止由 LLM 输出 `"mode":"fork"` 后直接执行。
- 禁止仅凭“上下文大”就 fork；大而无关的上下文通常应 fresh。
- 禁止仅凭“新 session”就声称独立。
- 禁止把 fork 当作预算重置。
- 禁止 fork 后同时复制完整 transcript 和同内容的摘要。
- 禁止多进程同时打开同一个 session file。

## Graph 落地方案

### 建议的一等领域对象

保持现有 `FeatureTask`、`GraphRevision`、`AgentInstance`、`Operation`、`Evidence`，新增：

| 对象 | 责任 | 关键字段 |
| --- | --- | --- |
| `ContextHandoffVersion` | 冻结一次 Fresh/独立验证所需的摘要、事实、artifact refs 和输出约束 | `id,version,taskId,purpose,summary,decisionRefs,artifactRefs,outputSchema,digest,createdBy,createdAt` |
| `AgentContextBinding` | 每个 Agent instance 的 context origin 与恢复契约 | `id,instanceId,mode,sourceInstanceId,sourceSessionId,sourceSessionFile,sourceLeafId,sourceContextDigest,handoffId,capabilityDigest,modelPolicyDigest,toolPolicyDigest,budgetScopeId` |
| `ContextResolution` | 程序对 Fork/Fresh/Continue 的正式决定 | `id,taskId,nodeId,requestId,requestedPurpose,requestedFacts,independence,selectedMode,reasonCode,constraintsDigest,decidedAt` |
| `BudgetScope` | 防止 fork 重置预算，支持父子/同源分支共享上限 | `id,rootTaskId,totalBudget,used,ownerKind,ownerId` |
| `ReviewIndependencePolicy` | 正式定义 review 独立性 | `freshRequired,evidenceOnly,excludedModels,allowedTools,reportSchema` |

不建议把 `contextMode` 只塞进 `NodeSpec`。NodeSpec 是图和定义投影；真正的 source session、leaf、digest 和预算属于 instance/binding，不能在 supervisor 改图时被隐式覆盖。

### 建议新增事件

沿用现有 `store.event()` 扁平事件风格：

| 事件 | 何时写 | 关键 payload |
| --- | --- | --- |
| `context.requested` | supervisor/程序请求一个 Agent 工作现场 | `purpose,neededFacts,independence,sourceHint` |
| `context.mode_selected` | resolver 做出决定 | `mode,reasonCode,sourceInstanceId,handoffId` |
| `context.handoff_frozen` | Fresh package 冻结 | `handoffId,digest,artifactRefs,decisionRefs` |
| `context.branch_created` | fork session 已创建并验证 | `sourceSessionId,sourceLeafId,newSessionId,sourceDigest,newDigest` |
| `context.branch_resumed` | 恢复 fork/fresh session | `instanceId,sessionId,bindingId` |
| `context.rejected` | 结构条件不满足 | `reason,requiredFacts,policy` |
| `review.independence_checked` | verifier 派发前 | `implementerModels,verifierModel,handoffDigest,transcriptIncluded=false` |

这些事件都要与 operation/dispatch 在同一事务边界内登记，不能只写在 UI 日志中。

### 建议 schema 迁移

当前 `PRAGMA user_version` 为 21，见 `src/core/store.ts:31-36`、`...:247-256`。建议 migration 22：

```sql
CREATE TABLE context_handoffs(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  summary TEXT NOT NULL,
  package TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id,version)
);

CREATE TABLE context_bindings(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  node_id TEXT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  mode TEXT NOT NULL CHECK(mode IN ('continue','fork','fresh')),
  source_instance_id TEXT REFERENCES instances(id),
  source_session_id TEXT,
  source_session_file TEXT,
  source_leaf_id TEXT,
  source_context_digest TEXT,
  handoff_id TEXT REFERENCES context_handoffs(id),
  capability_digest TEXT,
  model_policy_digest TEXT,
  tool_policy_digest TEXT,
  budget_scope_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE context_resolutions(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  node_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  requested_purpose TEXT NOT NULL,
  requested_facts TEXT NOT NULL,
  independence TEXT NOT NULL,
  selected_mode TEXT NOT NULL CHECK(selected_mode IN ('continue','fork','fresh')),
  reason_code TEXT NOT NULL,
  constraints_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id,request_id)
);

CREATE TABLE budget_scopes(
  id TEXT PRIMARY KEY,
  root_task_id TEXT NOT NULL REFERENCES tasks(id),
  total_budget INTEGER,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

同时给 `instances` 增加 `budget_scope_id` 和 `parent_instance_id`，但不回填虚假的 fork 祖先或 context mode；历史行继续显示“未记录”。当前 `node_sessions` 只有 `instance_id/session_id/session_file`，不足以支持 lineage，见 `src/core/store.ts:211-212`。

### Runtime resolver 与 adapter

建议新增一个内部 `ContextResolver`，接口只暴露：

```ts
resolve(input: ContextRequest): Promise<{
  mode: "continue" | "fork" | "fresh";
  instancePlan: { instanceId: string; nodeId: string; budgetScopeId: string };
  sessionPlan:
    | { kind: "open"; sessionFile: string }
    | { kind: "branch"; sourceSessionFile: string; sourceLeafId: string; childSessionDir: string }
    | { kind: "create"; childSessionDir: string };
  handoff?: ContextHandoffVersion;
  capabilityDigest: string;
  toolPolicyDigest: string;
  reasonCode: string;
}>;
```

`ContextResolver` 隐藏 Pi `SessionManager` 细节，但 adapter 必须执行：

1. `continue`：现有 `openPiInstance` 路径。
2. `fresh`：现状新 instance + `SessionManager.create` + briefing。
3. `fork`：
   - 打开 source session；
   - 使用 `SessionManager.open(sourceFile, childSessionDir, workspace)`；
   - 调 `createBranchedSession(sourceLeafId)`；
   - 用 child manager 创建 AgentSession；
   - 在任何新 prompt 前比较 source/child 的 `buildSessionContext()` canonical digest；
   - capability digest、model/thinking 和 tool policy 必须与 source 一致，除非显式 rebrand；
   - 之后才把 delta/task 作为新 user message 追加。

### MVP 边界

MVP 应实现：

- `ContextHandoffVersion`、`AgentContextBinding`、`ContextResolution`、`BudgetScope`；
- `continue` / `fresh` 全套 lineage 与事件；
- fork 只做单次 `createBranchedSession` 快照，不复用同 session；
- fork 写入必须独立 worktree，只读任务可共享工作区；
- source context digest 验证；
- capability/tool policy 默认继承同一 digest；
- review 必须 Fresh + evidence-only + 现有 model exclusion；
- fork budget 共享 scope；
- 不开放递归 fork、branch merge、同 file tree UI。

MVP 不实现：

- 同一 session file 并发；
- 任意历史 leaf 的选择 UI；
- 自动将 fork subtree 合并回原 branch；
- recursive subagent depth；
- cross-project fork；
- provider-specific cache 复用优化；
- session GC/分支压缩；
- 让模型直接调用 fork primitive。

完整版可以在 MVP 上增加：

- 版本化 branch tree 与显式 merge/absorb；
- 从 named checkpoint 或 operation 起点 fork；
- resume/steer subagent；
- branch summary 与结构化 handoff 双轨；
- provider cache affinity 实测与路由优化；
- session retention、加密和跨机器迁移；
- 多层 lineage UI 与预算归因；
- 跨项目 fork 的 workspace/rebase policy。

## 风险清单

| 风险 | 具体机制 | 必要控制 |
| --- | --- | --- |
| 缓存/成本误判 | Fork 产生新 session ID，provider affinity/cache 不保证复用；复制大 prefix 会重复输入 token。 | 记录 actual `cacheRead/cacheWrite/input`；不预扣缓存命中；逐 provider 实测；只有同 model/prompt/tools/history 时才允许称为 cache-preserving fork。`[未验证假设]` Pi 各 provider 在 new session ID 后的精确 cache 行为仍需真实账单验证。 |
| 上下文污染 | Fork 继承旧错误、废弃假设、失败 tool output、过期 plan。 | 默认 Fresh；Fork 前要求 exact transcript facts；compact/purge 不改变原始审计；handoff 明确冻结 source leaf。 |
| 重复上下文 | Fork 复制 transcript 后又把同一历史摘要作为 prompt 注入。 | Fork 后只注入 delta/task；summary 只用于 Fresh 或作为压缩已有 session 的正式 compaction entry。 |
| 分支不可追溯 | Pi header 只保存 `parentSession` path，不保存 source leaf 或 digest；entry ID 会跨 fork 复制。 | Graph 记录 source instance/session/leaf/digest、new session ID、handoff digest；UI 按领域 ID 而非仅文件路径展示。 |
| 并发写冲突 | 两个 process 打开同一 append-only session file；未见 Pi 提供跨 process 写锁。 | 禁止共享 session file 并发；每次 fork 生成新文件；SQLite/Graph 只允许一个 owner。 |
| Fork 后工具权限 | system prompt、tools、capabilities 和 grants 不在 session JSONL 中，Pi 不替 Graph 继承权限。 | Fork 默认复用同 capability/tool policy digest，task grants 取交集；扩展工具必须重新经 Graph gate；权限不能因 fork 扩大。 |
| 摘要失真 | Fresh handoff 可能漏掉隐式约束、精确 tool-call 状态或未成文决策。 | 结构化 schema、artifact refs、digest、source refs；不能从最终一段自然语言回答替代完整 handoff；对路径依赖任务改 Fork 或要求 checkpoint。 |
| session 文件增长 | JSONL append-only，fork 复制路径，compaction 追加 summary 而不重写原历史。 | 保留审计原文；对可清理的 session 建立 retention policy；区分原始 session、compaction checkpoint 和派生 fork；在删除前保留 digest 和必要 artifact。 |
| review 独立性不足 | Fresh 只隔离 transcript；同模型、同证据、同 prompt 或 provider cache 仍可能同源偏差。 | Fresh + evidence-only + model exclusion + 独立 report schema；记录 verifier 看到的 digest；必要时使用不同 provider/model 和独立复现证据。 |
| 预算逃逸 | Fork/Fresh 新 instance 若各自获得完整预算，可绕过父 instance 上限。 | 所有同源 Agent 共享 `BudgetScope` 或显式划分子预算；fork 不计为新任务的免费额度。 |
| Definition 升级导致伪 fork | source session 恢复后 capability digest 变了，system prompt/tools 不再相同。 | Fork 默认 fail closed；只有显式 rebrand 才允许新 digest，并记录不再具备完整继承/cache 保证。 |
| main 过长 | 主 Agent 累积几十轮对话和工具结果，影响决策质量。 | 主 Agent 保留高层计划；探索与验证转 Fresh；compaction 和 structured note-taking 作为独立机制，不把 fork 当万能治理。 |

## 最终判断

Graph 提出的模型在方向上成立，尤其与 Claude Code 当前的普通 subagent/fork 区分、Anthropic 的 context engineering，以及 Pi 的 session primitives 吻合。建议保留三分类，但作以下定稿：

- `main` 是同一 Agent instance/session 的连续执行，不是常驻进程。
- `Fresh` 是普通探索、摘要式任务和无路径依赖实现的默认。
- `Fork` 是从一个冻结 leaf 复制出新 session 的路径连续分支，只用于 transcript 本身不可替代的场景。
- 独立验证使用 `Fresh + evidence-only + independence policy`，不能只标 Fresh。
- Fork/Fresh 都必须形成新 Agent instance 和新 session；默认不得多进程共享同一 session file。
- mode 由 Graph 程序 resolver 选择，模型只能提供 purpose/facts/independence request。
- 现有 Pi 与 Graph 已经足以支持 Continue/Fresh；Fork 需要新增领域对象、SQLite migration、lineage 事件、预算 scope 和 adapter 快照校验后才能成为可用产品能力。
