# pi-subagents@0.73.1 — 工具面与工作流 API（surface）

本笔记只回答一个问题：**pi-subagents 的工具面与工作流 API 长什么样**——`subagent` 工具的参数、
`workflowScript` 里 `runs.run` / `runs.all` / `runs.lanes` 的语义、`validate` / `schedule` 的入口，
以及它和 Graph 的节点 / 边如何对应。**目标读者是我们自己**：我们要学的是「怎么让 agent 学会调用
subagents（在我们这里 = 简单级 graph）」，所以下面每一条都尽量落到「哪个字段 / 哪个 helper 教会了
agent 什么」，而不是复述功能清单。

一手来源（全部可回溯）：

- npm registry 元数据：`https://registry.npmjs.org/pi-subagents/0.73.1`
  （tarball `https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.73.1.tgz`，
  shasum `587cd7d2694b74d926f32afc724bd310c2e33c8b`，`fileCount: 1223`，`unpackedSize: 11183544`）。
- 包内文档：`docs/tool-reference.md`、`docs/workflows.md`（本笔记引用即按包内相对路径）。
- 包内实现：`src/workflows/scripted-workflow.js`、`src/extension/schemas.js`、`src/extension/tool-activation.js`。
- `package.json` 的 `pi` 字段与 `exports` 映射；`CHANGELOG.md` 的 `[0.73.1]` 段。
- GitHub 仓库：`https://github.com/nicobailon/pi-subagents`。

---

## 1. 一个工具，两个阶段：loader 与 schema

`package.json` 里 `pi.extensions = ["./index.js"]`，`pi.skills = ["./skills"]`，
`pi.prompts = ["./prompts"]`。也就是说这就是一个普通 Pi extension，除此之外没有别的注册面。

关键在于**工具的暴露是分两阶段的**，这是「教会 agent 调用 subagent」的第一课
（`src/extension/tool-activation.js`）：

- 新 parent session 先只暴露一个极小的 loader `subagents_enable`，其 prompt snippet 为：
  > "pi-subagents is installed. For authorized specialist, independent-review, or parallel work,
  > call subagents_enable, then subagent. **Authorization must come from the current request or
  > applicable instructions; complexity alone is not authorization.**"
  （`tool-activation.js:136`）
- 调用后返回：
  > "Enabled: subagent. On the next model request, call subagent({action:"list",capabilities:true})
  > for current capabilities. … do not retry it in this one."
  （`tool-activation.js:163`）

`docs/tool-reference.md` 开头把这条写死成一句规范：
> "Direct execution remains the default; task complexity does not grant delegation authority.
> The public `subagent` name and parameters are unchanged after activation."

**对 Graph 的可迁移点（简单档）**：delegation 是**显式授权**才开闸的能力，不是「复杂就自动派发」。
我们简单档的定位是「只服务于 main agent 自己、等价于一个 single subagent」，正好对应这里
`subagents_enable → subagent` 的两步：main agent 说清楚「我需要一个角色帮我查 X」才允许开孩子。

---

## 2. `subagent` 工具的调用形状

`src/extension/schemas.js` 定义 TypeBox schema；`docs/tool-reference.md` 有完整参数表。
要点（都是 agent 实际要填的字段）：

| 参数 | 语义 | 备注 |
|---|---|---|
| `agent` / `task` | 一个直接孩子，或一个管理目标 | `task` 需要 `agent`，且与 `action`、workflow 输入互斥 |
| `action` | 管理/控制动作（`validate`、agent 管理、`status`/`steer`/`stop`/`resume`、`schedule.*`、`mission.*`、`lane.*`、`inspector.*`、`worktree.cleanup`、`doctor`…） | 省略即为「执行」 |
| `workflowScript` / `workflowScriptPath` | 脚本化编排，二者互斥 | 见第 3 节 |
| `context` | `fresh \| fork \| profile` | `worker` 默认 `fresh`；`oracle`/`advisor` 默认 `fork` |
| `model` | `provider/id`，可带 `:high` 之类思考档后缀 | 需先 `{action:"models"}` |
| `isolation` / `worktree` / `baseRef` | `none \| worktree`（`worktree` 需 managed Git worktree），`baseRef` 默认 `HEAD` | 并行写者各自的隔离 |
| `async` | 默认开 | workflow 默认后台；`async:false` 阻塞 parent |
| `acceptance` / `gate` | 证据门 / 一条宿主命令门 | `gate` 归一化成 `verified` acceptance |
| `timeoutMs` / `maxRuntimeMs` | 运行级上限 | composite async 顶层默认无上限（见 workflows.md「Opt-in bounded workflows」） |
| `toolBudget` / `usageBudget` | 工具调用 / 用量预算 | 文档明确：**别给可变写者上紧的硬预算** |
| `mission` / `missionId` | 默认自动建一个 enclosing mission | `mission:false` = 无 mission 且无 `state` 全局 |

`async:false` 这条还有语义细节值得记：前台孩子跑在 parent Pi 进程内，**不加载 parent 的环境
extensions**，但继承它们注册的 providers；需要 MCP 工具的孩子必须后台跑，因为 detached runner
进程才加载 MCP。这是「同一台机器上子代理能力不自动共享」的一条硬边界。

---

## 3. `workflowScript`：`runs.run` / `runs.all` / `runs.lanes`

这是本笔记的核心，也是与 Graph 节点/边最对应的一层。
`docs/workflows.md` 原文定的心智模型：

> "Use direct `{ agent, task }` for one bounded child. Use `workflowScript` when the parent needs a
> stable keyed child, sequence, fanout, steering, retry, or aggregation."

### 3.1 三个原语

- **`await runs.run(key, { agent, task })`** — 顺序一步。返回已完成孩子的
  `{ key, ok, output, runId, structuredOutput, outputReference, artifactPaths, … }`。
  **禁止**从「未 await 的 launch」上读 `.output`；只有高级 rolling fanout 才允许存 promise，
  且每个 promise 之后必须用直接 `await` / `Promise.race` / `Promise.all` 观察。
- **`await runs.all([{ key, agent, task }, …])`** — 普通并行 fanout。返回**有序数组，不是 key map**：
  文档与校验器都硬钉这一点（`scripted-workflow.js:297` 的报错文案：
  "runs.all resolves to an ordered array, not a key map. Use results[0], array destructuring, or
  results.map(...), not results.<key>."）。API 把「用 index 而不是 key 取值」做成了运行时错误，
  这本身就是一种「教 agent 写对编排」的机制。
- **`await runs.lanes(lanes)`** — **并行顺序车道**：多个独立 lane，每个 lane 内部有有序 stage。
  它是 `workflowScript` 里的 helper，**不是新的顶层执行模式**：
  "This helper composes the existing workflow child runner; it does not add a top-level `lanes`
  parameter or a second persistence/cleanup system."（`docs/tool-reference.md`）

代码证据（`src/workflows/scripted-workflow.js`）：

```js
const MAX_LANES = 32;
const MAX_LANE_STAGES = 16;
const MAX_LANE_STAGE_COUNT = 64;
const MAX_LANE_SPEC_BYTES = 64 * 1024;     // canonical JSON 64 KiB
const MAX_LANE_TASK_BYTES = 1024 * 1024;   // task 1 MiB
const MAX_LANE_PATH_BYTES = 32 * 1024;     // cwd/output/sessionDir 32 KiB
```

lane 的 stage key 是 **lane 局部**的，生成的子 key 是 `<lane>.<stage>`（`scripted-workflow.js:427`）；
每个 lane 的第一个 stage 由**同一个** `runs.all(...)` 批次并发拉起，后续 stage 按 lane 顺序推进
（`runLanes()`：`launchRunsAll(firstItems, lanes.map(l => l.key))`）。`resume: "previous"` 表示延续
上一个保留孩子的 session，并要求上一个孩子返回了 `runId`。

失败语义：某个 lane 的某 stage 失败 / 被 stop / detached，或 `structuredOutput.verdict === "blocked"`，
**只阻塞这条 lane**，其后 stage 被标 `skipped`，兄弟 lane 继续（`runLane()` 的 `appendSkipped`）。
**reviewer 的自然语言正文永不被解析**——判定只认 `structuredOutput`。

### 3.2 脚本沙箱与可移植性

`workflowScript` 是「普通 JavaScript 语句体」，用显式 `return` 给结果。沙箱里可用：
`runs.run / runs.all / runs.lanes / runs.steer / runs.status / runs.ref / runs.refs / emit / console /
标准 JS`，以及开 mission 时的 `state`。**没有文件系统、shell、任意 Pi 工具、宿主全局**。

- 只有 package-owned 的具名资源才可能拿到 `runs.host` 授权（`workflow: "review" | "run-ci"`），
  裸 `workflowScript` 是 unknown-provenance，`runs.host` 不可用。
- **嵌套 `async function` / async 箭头 / async 方法被拒绝**（`scripted-workflow.js:1821` 与
  `NESTED_ASYNC_WORKFLOW_ERROR` 常量）；必须用顶层 `await`、普通函数返回 `runs.run(...)`、
  或显式 Promise 链。理由写得很直白："so child-launch tracking stays portable across Node and Bun"。
- `args` 是 bounded plain-JSON，会被**深冻结**并持久化进 run/schedule 证据，因此**不要放秘密**。
- `state.get/set` 让同一 `missionId` 下后续 workflow 共享持久 JSON 值；整个 state 文件硬上限 256 KiB。

### 3.3 steering 与 rolling fanout

`await runs.steer(key, message, { mode: "steer" | "follow_up" | "auto", index?, ackTimeoutMs? })`
只能针对**已经由 `runs.run`/`runs.all` 拉起过的稳定 key**，不接受裸 run id。
receipt 的 `state ∈ {queued, delivered, missed, failed}`。文档反复强调一句清醒的话：

> "For an async child, `delivered` means it consumed the correlated user input; for a foreground
> child, it means the in-process Pi transport accepted the input. **It does not mean the model
> followed it.**"

fire-and-forget 的 steer 会被拒绝：workflow 会在退出前等已观察到的 steering 副作用结算，未 await
的 steering 调用会让 workflow 完成失败（"Unawaited steering calls reject workflow completion after
the side effect settles."）。rolling 模式用 `Promise.race` 抢下一个完成的孩子、`runs.steer` 挑战仍在
跑的 sibling、`Promise.all` 收尾——没有单独的 `runs.start/next/collect`。

**对 Graph 的可迁移点**：Graph 现在的「返工回边」是静态 `loops`；pi-subagents 的等价物是
「先跑的孩子结果 → steer 还在跑的 sibling」。如果我们想让简单档支持「边跑边挑战」，这正是可借的形状。

---

## 4. `validate` 与 `schedule`

### 4.1 `validate`（静态检查，不起孩子）

`{ action: "validate", workflowScript | workflowScriptPath, args?, cwd? }` 返回
`{ ok, errors, warnings? }`，`ok:false` 时工具调用失败。`src/workflows/scripted-workflow.js:1797`
导出 `validateWorkflowScript`；`.d.ts` 的错误结构是
`{ message, line?, column?, kind?: "spawn-budget" | "agent" }`，warning 只有
`{ message, kind: "dynamic-spawn-count" }`。

它检查（`docs/workflows.md` "Validate a script without launching children" 段）：
语法、嵌套 async 的可移植性规则、字面量 `runs.run`/`runs.all` 的 key 与 `baseRef`、
一组 `runs.all` 内重复字面量 key、对已知 `runs.all` 结果的**直接 keyed 访问**、
静态可判定的非 JSON 边界值；并且会**把 `runs.run`/`runs.all`/`runs.lanes` 里的字面量 `agent`
名字拿去和该 cwd/agentScope 发现的 agent 对账**，未知或歧义时报最接近的名字
（例："Did you mean 'reviewer'?"，`CHANGELOG.md` 0.73.0）。

关键纪律：**0.73.0 起，执行 workflow 会先跑同一个 agent-name 检查**，所以拼错 agent 名
「before any child starts」就失败，而不是先跑掉前面几个孩子。
动态 key / 运行时构造的 value 不做静态猜测，留给运行期。

**对 Graph 的可迁移点**：这正是我们「简单档 E2E 前置校验」该有的样子——把
「未知 agent 名、重复 key、越界访问 runs.all 结果」在**派发前**判死；把「教授 agent 正确写法」
从文档挪进校验器，比写在 prompt 里更可靠。

### 4.2 `schedule`

`schedule.create` 只接受 `workflowScript` 或 `workflowScriptPath`，**不接受直接孩子**。
schema 里相关字段（`src/extension/schemas.js:293-303`）：`at`（`+10m` 或带时区的 ISO 时间戳）、
`every`（固定间隔，如 `30m/6h/2d/2w`）、`sessionOnly`、`quiet`、`catchUp`（`none|latest`，默认 latest）、
`overlap`（仅 `skip`）。`on`/`timezone` 是 **Reserved**，日历选择器与 schedule 绑定 mission 都 deferred。
`baseRef` 只在 worktree 分配时解析，且仍要求源 checkout 干净。

配套动作：`schedule.list/show/history/pause/resume/run/run-due/delete`。
`quiet:true` 的周期任务「成功自动触发不唤醒 parent」；失败 / 被停 / 被暂停仍会唤醒 parent。

---

## 5. 与 Graph 节点 / 边的对应关系

对照 Graph 侧的真实形状（`src/core/types.ts`、`src/core/templates.ts`）：

```ts
export interface NodeSpec {
  id: string; kind: 'agent' | 'program'; action: string;
  dependsOn?: string[]; input?: Json; definitionVersion?: string;
  model?: string; role?: 'master' | 'worker'; container?: string;
  routes?: string[]; when?: { node: string; case: string };
  optional?: boolean; verifier?: VerifierConfig; replaces?: string;
  context?: ContextRequest;
}
export interface ContainerSpec { id: string; parent?: string; dependsOn?: string[]; when?: {node:string;case:string}; outputs: string[] }
export interface LoopSpec { from: string; to: string }
```

对应表：

| pi-subagents | Graph | 说明 |
|---|---|---|
| `runs.run(key, {agent, task})` / `runs.all([...])` | `NodeSpec`（`kind:'agent'`，有 `dependsOn`） | 一个 keyed 孩子 ≈ 一个节点 |
| `runs.lanes(lanes)` 的 lane | `ContainerSpec` + 其 `outputs` | 一条车道 ≈ 一个容器；stage 顺序 ≈ 容器内依赖链 |
| `resume: "previous"` | `LoopSpec { from, to }` / 依赖边 | 延续上一个孩子的 session ≈ 返工回边 |
| `runs.run(...).ok / structuredOutput.verdict` | `NodeSpec.when` + `routes` + `VerifierConfig` | 条件路由只认结构化判定，不解析 prose |
| `agent` 名 vs `runs.run` 里 | 模板 `agent(id, action)` | Graph 用 `action`/模板选角色；pi 用 agent 名 |
| `gate` / `acceptance` | `program(id, 'check')` / `graph.verify` | 都要求**宿主执行**的验证命令，且都不信孩子自述 |
| `worktree: true` + `baseRef` | 每任务独立 worktree（我们的 worker worktree） | 并行写者隔离 |
| `mission` / `state.get/set` | 任务的 output / `started_at` 等 | pi 用 mission + 256 KiB state 文件做跨 workflow 共享 |
| `async` 默认开 | 我们的异步节点执行 | 都允许「派发完就返回，稍后收结果」，且都不把 dispatch 回执当完成 |

三处**语义差异**值得记清：

1. **pi-subagents 没有显式节点/边数据结构**。连接关系完全活在 JavaScript 控制流里
   （顺序 = await 顺序，并行 = `runs.all`，条件 = 显式 `if`）；Graph 则是声明式 `nodes` +
   `dependsOn` + `when`/`routes` + `loops`。pi 侧的优势是脚本能表达任意编排，代价是没有全局图可校验、
   Review 面看不到「边」；Graph 侧反之。**这一条正是本次任务要学的东西**：简单档要保留
   「main agent 自己定义的 subagent 角色」，但未必需要把连接关系也声明化。
2. **调度模型不同**：pi 的 `schedule.at/every` 是「延迟 / 周期触发一个 workflow」；
   Graph 的节点调度是 DAG 就绪传播。两者不能直接互换。
3. **失败隔离粒度不同**：pi 的 `runs.lanes` 是 **per-lane** 阻塞（兄弟 lane 继续），
   `runs.all` 默认是「一个孩子失败就在边界抛出」（除非传 config 对象拿到 `{ok:false}` 语义——
   `RUNS_ALL_PERMISSIVE_WARNING`，`scripted-workflow.js:709`）；Graph 用 `optional` + 状态机显式表达。

---

## 6. 版本事实（0.73.1，用于可复核性）

`CHANGELOG.md` 的 `[0.73.1] - 2026-09-27` 只有一个 Highlight：

> "Turning on `subagent` mid-session no longer throws away the prompt cache, so the next message
> no longer resends the whole conversation."

其修复细节对「教 agent 调用 subagent」直接相关：**广告出来的 agent 目录改为独立的
`advertised_subagents` prompt section，由 Pi 追加在对话末尾**，不再重写整个 system prompt。
也就是说：0.73.1 的「agent 目录」在 prompt 里的落点是**会话末尾的一个独立段**，不在 system prompt 里。
这与我们刚刚在 Graph 主线里做的「用户看到的 = 实际注入的」原则是同一类问题，值得单独记一笔。

同一版本还修了：停后台 run 时 runner 已关机却报 "Stop requested"（改为明确失败并要求重试一次）。
依赖：`acorn 8.18.0`、`jiti 2.7.0`、`undici 8.10.0`、`yaml 2.8.3`。

---

## 7. 留给 auth / lessons 两车道的接口

- **auth 车道**：本文只覆盖工具面与 workflow API。`subagents_enable` 的授权闸门、
  `capability-ceiling`（`exports["./capability-ceiling"]`）、`agentContract`、acceptance 与
  `evidenceStatus` 的授权含义，归 auth 车道。
- **lessons 车道**：本文第 3、5、6 节给出的三条可迁移教训（校验器即教学、显式授权才开闸、
  用户所见 = 实际注入）与 rollout/迁移姿势，归 lessons 车道。
