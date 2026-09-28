# pi-subagents@0.73.1 — 授权模型：agent 如何获得调用 subagents 的权限

调研断点：`research-auth`（简单级 graph 的 3 个互不依赖派生 agent 之一）
一手来源：npm registry 元数据 + 包内 tarball 源码/文档。

- 包与版本：`pi-subagents@0.73.1`，`dist.tarball = https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.73.1.tgz`，
  `integrity = sha512-IklOqw67DtvIWQFKxFJpDFXsOGcq8RGYZEbokykD5Kvfs9aa/du1cW2NEJ5xx4GUgN2LVt3vAq5IdzEMo7YwJw==`
  （来源：`https://registry.npmjs.org/pi-subagents/0.73.1`；`gitHead = 8a403efba6975988cc0488ec8bb941db5ef1a19e`；repo `https://github.com/nicobailon/pi-subagents`）。
- 本地复现制品的 tarball 校验和：`sha256 a9db0457bc18398490733a1d6a6735e8cccbf702716a56474e4a0b33e000b8f0`（`pkg.tgz`，解包目录 `package/`）。

## 一、两个概念必须分开：激活（availability）与授权（authority）

pi-subagents 把「工具在不在模型手上」和「agent 有没有资格委托」拆成两层，这是它整个授权模型的骨架：

1. **激活层（工具面）**：`subagents_enable` 只是把完整的 `subagent` 工具从「已注册但未激活」变成「下一个模型请求可见」。它**不启动任何子 agent，也不授予授权**。
2. **授权层（决策语义）**：是否应该用 subagent，由 **当前请求或适用的 user/project 指令**决定；**任务复杂度本身永远不构成授权**。

两条都在包内一手文档里逐字出现：

- `docs/tool-reference.md:5`：“In a fresh parent session, `subagents_enable({})` makes the full `subagent` tool available on the immediately following model request **without launching work**. Pi may call it when delegation is authorized by the current request or applicable instructions, or to manage existing runs. **Direct execution remains the default; task complexity does not grant delegation authority.**”
- `README.md:47`：“When your request or applicable instructions authorize delegation, Pi can call the loader itself; the unchanged `subagent` tool is available on the next model request. **Complexity alone does not authorize delegation.**”
- `docs/configuration.md:81`：“Calling `subagents_enable({})` preserves unrelated active tools and exposes `subagent` on the next model request. It **does not launch a child or infer authority from prompt keywords**.”

## 二、`subagents_enable` 的作用与语义（源码级）

实现位于 `src/extension/tool-activation.js`（v0.73.1 tarball）。

- 常量：`LOADER_NAME = "subagents_enable"`、`SUBAGENT_NAME = "subagent"`（第 6–7 行）。
- 工具注册（`registerSubagentToolActivation`，约 126–180 行）：
  - 参数为空对象 `Type.Object({})`，注释说明“a stray one (DeepSeek sends `{ action: "enable" }`) must not fail validation”——即多余参数被忽略（对应 CHANGELOG 第 71 行修复 #2483）。
  - `description` 逐字写明语义：“Enable pi-subagents delegation and management tools without launching work. Call when delegation is authorized by the current request or applicable user/project instructions, or when managing existing runs. **Direct execution is the default; complexity alone never authorizes delegation.** Full tools are available on the next model request.”
  - `promptSnippet`：“pi-subagents is installed. For authorized specialist, independent-review, or parallel work, call subagents_enable, then subagent. **Authorization must come from the current request or applicable instructions; complexity alone is not authorization.**”
  - `execute()`：先确认 `subagent` 在 `getAllTools()` 里（否则返回 `isError` “Cannot enable unavailable tools: subagent.”），再 `setSelection(pi, true)`，然后**校验 `getActiveTools()` 真的包含 `subagent`**，否则报 “Activation failed: subagent.”。成功后才 `advertisedPrompt()` 并返回文本 “Enabled: subagent. On the next model request, call subagent({action:"list",capabilities:true}) …”。
- `setSelection`（约 96–102 行）：**保留当前活跃工具**，只增删 `subagent`，并保证 loader 自身仍在活跃列表里。
- 版本门槛：动态激活要求宿主 Pi ≥ `0.86.1`（`MINIMUM_DYNAMIC_TOOLS_VERSION = [0, 86, 1]`）。宿主不支持时（`unsupportedDynamicToolsReason`）**回退为一直可见的 `subagent`** 并打一条 warning，而不是禁用功能。
- 选择被记录进原生 tool-selection（`hasNativeToolSelection` 检查消息上的 `toolsAdded`/`toolsRemoved`；`applyRecordedSelection` 在 `session_start` 与 `session_tree` 上恢复）。因此**已激活的会话保持激活，冷会话保持冷启动**；没有记录的老历史则保持 eager 可见。

生命周期汇总（`docs/configuration.md:81`）：在 Pi ≥ 0.86.1 的“fresh unrestricted parent”上，初始活跃的是 `subagents_enable`、`bg_wait`、`subagent_supervisor`，而 `subagent` 已注册但未激活。

提供方限制（`docs/configuration.md:85` / CHANGELOG:36）：某些 provider 会把整个 prompt 的工具列表固定（例如把 Pi 工具桥接到别的 agent SDK），此时 `subagent` **要到下一个 user prompt 才出现**；`subagents_enable` 的返回文案会明确告知，以免模型在同一 prompt 里反复重试。操作者可加 `--exclude-tools subagents_enable` 让 `subagent` 一开始就常驻。

## 三、delegation authority 由什么授予

**授予来源只有两类，且都不是“难/大/风险高/工具调用多/配方合适”：**

- `src/extension/tool-description.js`（`SUBAGENT_SAFETY_GUIDANCE`，逐字）：“Direct parent execution is the default. Invoke subagents only when delegation is authorized by **the operator's current request or applicable user/project instructions**; **task size, complexity, risk, tool-call count, or recipe fit do not independently authorize delegation.**”
- `src/extension/tool-description.js`（`SUBAGENT_TOOL_PROMPT_GUIDELINES`）：“Do not invoke subagents unless the operator requested delegation directly or through applicable instructions.”
- `docs/agents.md:535`：bundled skill “is automatically available to the parent agent … **Availability is not automatic routing or permission to delegate**: the parent works directly unless the operator requests delegation in the current request or through applicable user/project instructions.” 该 skill **只给编排者，子 agent 永远拿不到**（子上下文被显式过滤掉 parent-only 编排说明）。
- `docs/configuration.md:93`（`toolDescriptionMode`）：工具描述里的元数据“explains use **after operator-authorized delegation**; it does not route ordinary work to children or independently authorize delegation.”

也就是说：**“授权”是一个关于指令的判断，而不是一个可被模型自行推断的能力开关。** 工具是否可见（enable）≠ 是否被授权（authority）；模型即使已激活 `subagent`，在未被授权时默认仍应直接执行。

## 四、直接执行与委托的默认关系

默认关系明确偏向“直接执行”：

- 默认：`Direct parent execution is the default`（tool-description.js / tool-reference.md / README.md 三处一致）。
- 委托是**例外**，且即便被授权，也要求“用最小的有界子任务”：`docs/agents.md:535`：“Once authorized, use the smallest bounded child or workflow whose evidence, independent review, specialization, parallelism, or isolation benefit earns its overhead.”
- 子 agent **不是**编排者：“Ordinary child subagents are not orchestrators; only configured fanout within depth/session limits.”（tool-description.js）默认嵌套限两层：main → subagent → sub-subagent（`docs/workflows.md:534`）。
- 单独的 `subagent_supervisor` 需要 fanout 授权，否则启动即报错：“Requesting `subagent_supervisor` without fanout authorization fails at launch with an actionable error.”（`docs/workflows.md:522`）

## 五、与“授权/权限”相邻、但其实是不同层的机制（避免误读）

- **`authorityPolicy`（`docs/configuration.md:529`）**：这是一个**固定动作映射**（`discardWorktree`、`destructiveCleanup`、`spawnBudgetGrant`、`scheduleCreate`、`stopRun`、`steerRun`、`inspectorOpen`、`projectOpen`），每项取值 `"auto" | "confirm" | "forbid"`；“Confirm-required control actions fail closed without an interactive UI.” 它管的是**危险控制动作**是否要人确认，**不是**是否允许委托。
- **capability ceiling / 工具预算**：`src/api/capability-ceiling.js` 只是 re-export `runs/shared/capability-ceiling.js` 的注册与求交逻辑；`allowNestedSubagents`（`docs/agents.md:350`）才是“授权子 agent 具备嵌套能力”的显式开关。这些是**能力边界**，与“本次是否授权委托”正交。
- **workflow 内的 host 权限**：`runs.host` 只由**具名资源**授予；“inline `workflowScript`/`workflowScriptPath` remain raw, unknown-provenance inputs, so their `runs.host` calls are unavailable through the public execution boundary.”（`docs/tool-reference.md:26` / `docs/workflows.md:97`）——这是 workflow 沙箱的权限边界，不改变“委托是否被授权”。
- **`preflight`/agent 选择**：`AGENT_SELECTION_GUIDANCE` 强调 “executable, non-disabled agents only; external-cli requires runner.available === true … preflight is authoritative.”（tool-description.js）——这是**可选 agent 的资格校验**，也不是委托授权本身。

## 六、可迁移结论（对我们的“简单级 graph”）

1. **把「可见/可调用」与「该不该用」拆开**：我们可以学习它用一个小 loader 先做轻量可用化，再靠指令授权决定行为；但要注意我们的 subagent = 简单级 graph，是 main agent 主动调用来帮自己干活的，所以“授权来源”本就可以是 main agent 自己（它选择现有配方或自定义配方），这一点与 pi-subagents 的“必须 operator 授权”并不冲突——我们的 operator 授权形态不同。
2. **默认直接执行，委托要有理由**：任何“复杂度/规模自动触发委托”的规则都应避免，否则会出现无授权的自发委派；应把授权写成显式判据（当前请求或适用指令）。
3. **激活≠授权，工具面变化不应静默**：`subagents_enable` 明确回报“下一个模型请求生效”，并对 provider 会把工具列表固定一整个 prompt 的情况给出显式文案，值得我们借鉴——避免模型在同一 prompt 反复重试。
4. **嵌套要设深度与“子不是编排者”的边界**：默认两层上限 + 子上下文剥离 parent-only 编排说明，是很好的防“无限套娃/角色混淆”设计。

## 七、证据索引（一手来源）

- npm registry：`https://registry.npmjs.org/pi-subagents/0.73.1`（tarball / integrity / gitHead / repository / peerDependencies 中 `@earendil-works/pi-ai >= 0.86.1`）
- 包内源码（tarball 解包后路径）：
  - `src/extension/tool-activation.js`（`subagents_enable` 全实现、版本门槛、选择恢复）
  - `src/extension/tool-description.js`（`SUBAGENT_SAFETY_GUIDANCE`、`SUBAGENT_TOOL_PROMPT_GUIDELINES`）
  - `src/api/delegation.js` / `src/api/delegation.d.ts`（extension-to-extension 委托事件协议）
  - `src/api/capability-ceiling.js`（能力上界 re-export）
- 包内文档：
  - `docs/tool-reference.md:5`、`:26`、`:139`
  - `docs/configuration.md:81`、`:85`、`:93`、`:529`
  - `docs/agents.md:350`、`:535`、`:539`
  - `docs/workflows.md:522`、`:534`
  - `README.md:47`
  - `CHANGELOG.md:13/36/70/71/72/104/127`（激活语义与历史修复）
- 复现命令：
  ```bash
  curl -sL https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.73.1.tgz -o pkg.tgz
  tar xzf pkg.tgz && grep -rn "subagents_enable\|delegation authority" package/docs package/src
  ```
