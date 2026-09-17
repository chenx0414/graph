# 能力包注入独立验收：不关闭，带可分派返工

日期：2026-09-17。被测分支 `feat/app-ux`，规格提交 **`6e053ab1bf18e486107fe7a9dc676fd9b21f36d4`**（`docs: research Pi subagent capability injection`），实现提交 **`c78276a2927d4b58b5f0d30c4a8f085e4664c4b8`**（`feat: inject capability bundles into isolated Pi processes`）。工作树 `/Users/macmini/workspace/13-Graph`。固定比较：`git diff 6e053ab...c78276a`。

依据 [Pi 子 Agent 能力注入研究](../pi-subagent-capabilities-2026-09-17.md) 第 6 节、[ADR 0011](../adr/0011-isolated-pi-process-capability-bundles.md)、[ADR 0008](../adr/0008-definition-bound-capability-loading.md)。审查身份：独立验收，不是实现方。未改产品源码、未合入、未发布、未调用付费模型。

| 审查轴 | 结论 | 剩余缺陷 |
| --- | --- | --- |
| Standards | 有条件通过（1 个硬违规 + 若干判断项） | S01 节点详情英文 `bundle` |
| Spec | 不通过 | R01 digest 缺省 fail-open；R02 扩展工具允许名单 fail-open；R03–R06 规格模型未写完 |

**整包不关闭。** 核心隔离路径已落地且独立复验通过，但 ADR 0011 的 fail-closed 与研究 6.2/6.4 的允许名单仍有可利用缺口。第三方 agent 按下面 P1 修完后再交独立复验。

## 规格钉住的交付

`6e053ab` 是研究，不是 UI 设计。后续实现应满足：

1. 生产每次 Agent operation 在独立、受 OS 限制的 Pi 进程中跑 `AgentSession`，不在守护进程内直接创建。
2. 宿主保留凭据、模型请求、usage、pause/预算/权限/未知用量/恢复、真实工具、实例身份、capability digest、会话 manifest。
3. 子进程只收到模型元数据（无凭据）、显式 Skill 路径、显式 Pi extension 入口、`agent.md` + Graph 生成的 `tool.md`、工具 JSON schema 代理。
4. `tool.md` 是 Graph 约定；即使绑定了自定义 `tool.md`，也要在后方追加权威 inventory。Skill 自动描述从 system prompt 隐藏。
5. 每 Agent 独立 `SessionManager` / `ResourceLoader` / Pi 进程 / 工作目录。`SettingsManager.inMemory`，关闭默认发现。
6. 恢复按原定义版本重解析同一能力包；session JSONL 不保存能力绑定；digest 不一致 fail closed。
7. 安装能力不等于扩大任务权限。Pi extension 工具先过宿主 `tool_call` 门；命令/MCP/Graph extension 仍由宿主受限 executor 执行。

## 本次独立验证

- Node **24.20.0**；`tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`git diff --check 6e053ab..HEAD` 均为 rc=0。
- 针对测试 8/8 通过：`tests/console/capability-bundle.test.ts`、`tests/m0/pi-process.test.ts`、`tests/console/presets.test.ts`。
- 全量 **80 文件 / 411 项通过**，本次独立执行一轮，69.39 秒。
- 独立探针 `digest-mismatch-probe.mts`（非实现方测试）：
  - 先写 digest A 再以 digest B 打开：抛 `Persisted capability bundle does not match the Agent definition`（`pi-instance.ts:107`）。
  - 再以**省略 digest** 打开同一 `stateDir`：**成功打开**（fail-open）。
  - 以相同 digest A 打开：成功。
- 生产路径 `src/runtime/pi-adapter.ts` 使用 `openPiProcess`，不再在宿主内 `openPiInstance`。
- `controlledOpenAIStream` 仍在宿主；子进程 `apiKey` 为占位符。实现方测试断言 `Bearer host-only-key` 只出现在宿主请求。
- 全量测试弄脏了 9 张 `master-agent-entry/*.png`，已按被测 HEAD 恢复。工作区跟踪文件干净。

证据：[capability-bundle-independent](acceptance-evidence/capability-bundle-independent/)。

## 已关闭（本轮可保留）

| 项 | 独立证据 |
| --- | --- |
| 独立 Pi 进程 + 不同 identity/tool.md 不串 | `pi-process.test.ts` 两进程 `processId` 不同，system prompt 互不含对方文案 |
| Pi extension 在子进程注册并真正执行 | 同文件：provider 请求含 `extension_probe`，inspect.messages 含 `extension-probe-ok` |
| 凭据不进子进程 | 同文件：`authorizations == ['Bearer host-only-key']` |
| 定义版本解析 Skills / pi-extension / agent.md / tool.md，并产出 digest | `capability-bundle.test.ts` |
| 预设绑定 `prompts.agent` / `prompts.tool` | `presets/manifest.json` + `presets.test.ts` |
| 生产拼装 Mode B：`systemPrompt=agent.md`，`appendSystemPrompt` 含绑定 tool.md **加上** Graph inventory | `capabilityPrompts()` 固定追加 `# Capability awareness` |
| 每 Agent 独立 loader/session/inMemory settings、关闭默认发现 | `openPiInstance` |
| 绑定能力缺版本/未安装 fail closed | `loadCapabilities` 抛 `capability_unavailable`；不把未写版本的绑定解析成「最新版」 |
| JSONL 仍只是会话，不存 Skills/MCP/extensions | manifest 另存 `instance.json` |
| 安装 ≠ 授权、远程 MCP 仍按 `mcp:id:tool` grant | 既有 `tests/m3/mcp-boundary.test.ts` 全量仍绿 |
| 压缩/暂停/预算/未知用量门仍在宿主 | 全量 `tests/console/compaction.test.ts` 仍绿 |

## Standards

（Standards 轴原文要点，不与 Spec 轴混排。）

### Issue S01 — 硬违规

- File: `src/web/NodeDetail.tsx`（`bundle {digest}`）
- 规则：用户可见文案用中文（仓库 Agents/实现约定）。
- 现状：节点详情写英文 `bundle`。
- 修复：改为中文，例如「能力包」或「能力摘要」，并补 UI 断言。

### 判断项（不单独阻塞）

- `tool_gate` 用空 `dispatch` 做暂停/额度门，真正执行在子进程：与 ADR 0011 字面相符，但不是工具名允许名单（见 Spec R02）。
- digest 两边都缺时不抛：相对 ADR fail-closed 偏软（见 Spec R01）。
- `loadCapabilities().digest` 与 `capabilityPrompts().digest` 同名不同载荷；生产只持久化后者。
- `pi-adapter.ts` 重复展开 `allowWorkspaceChange`。
- `capabilities.ts` / `pi-adapter.ts` 超过 200–400 行典型值，未到 800。

**Standards 统计：硬 1（S01），判断若干。**

## Spec

（Spec 轴原文要点。）

### R01 — 实现错误（P1）

规格/ADR：「digest 不一致时 fail closed」；「缺版本时不能静默降级」。

```106:107:src/runtime/pi-instance.ts
  if (manifest?.capabilityDigest && options.capabilityDigest && manifest.capabilityDigest !== options.capabilityDigest) {
    throw new Error(`Persisted capability bundle does not match the Agent definition ...`);
```

`pi-process.ts` 把缺省写成 `''`；`pi-worker.ts` 把空字符串当成「未提供」省略。独立探针：省略 digest 重开同一实例成功。v2 manifest 被删掉 digest 字段、或调用方漏传时，会换一套能力包继续原会话。

关闭标准：manifest `version >= 2` 时必须有非空 digest；缺、空、或与当前定义重解析结果不同，一律拒绝。补测试覆盖 mismatch / omitted / same 三种。

### R02 — 实现错误（P1）

规格 6.2.6 / 6.4.3：`tools` 只放行 bundle 产生的工具名；允许名单不是卸载 extension，但未声明的工具不得变成可调用。

现状：

- `createAgentSession` 未传 `noTools: "all"` + `tools`；靠事后 `setActiveToolsByName`。
- `piExtensionTools.length === 0` 时 worker **不传**该字段，`allowedExtensionTools` 为 `undefined`，扩展注册的**全部**工具都会激活。
- 宿主 `tool_gate` 只做 pause/预算，不核对声明名。

关闭标准：声明列表是唯一允许名单（空列表 = 零扩展工具，不是「全放行」）。宿主 `tool_gate` 拒绝不在 `piExtensionTools` 中的名字。补测试：`capability.json` 未声明的 `registerTool` 不得出现在模型 tools，且 `tool_gate` 拒绝它。

### R03 — 部分缺失（P2）

规格 6.1 / 6.2.7：`CapabilityBundleVersion` 含 skills/mcp/extensions/prompts/`toolPolicy`/`runtimePolicy`；manifest 记录 bundle digest、Pi version、session file、model/thinking、实际 tool names，恢复逐项核对。

现状：`instance.json` 只有 `{binding, workspace, sessionFile, sessionId, capabilityDigest?}`。生产 digest 是 prompt 拼装哈希，不是 bundle 版本对象。不要另起一套与能力库并行的配置系统；在现有 catalog/loadCapabilities 上补字段与核对即可。

### R04 — 部分缺失（P2）

规格 6.2.5：Pi extension 工具名 `ext_<capabilityId>_<toolName>`。MCP 仍是 `mcp_*`；Pi extension 使用裸名（测试里的 `extension_probe`）。

### R05 — 范围外 knobs（不记缺陷，需文档）

隐藏 extension `graph-capability-gate`、`hideSkillDescriptions`、`activateExtensionTools`、`pi-worker.json` 把 prompt/模型元数据/工具 schema 写到实例目录。JSONL 本身仍干净。`pi-worker.json` 不得含凭据；`toPiModel` 当前不含 apiKey，独立测试覆盖了宿主持 key。

### R06 — 未测缺口（P1 测试，随 R01/R02）

实现方测试未覆盖：digest 省略、未声明扩展工具、`capabilityPrompts` 追加 inventory、Mode B `disableModelInvocation` 后 system prompt 不再含 `<available_skills>`。生产走 worker，Mode B 在 `pi-worker.ts` 为 true；`openPiInstance` 默认 false，仅测试夹具直连时才会漏。

**Spec 统计：P1 两条行为错误（R01、R02），P2 模型/命名未写完（R03、R04），S01 文案。**

## 给第三方实现 agent 的返工包

工作位置：`/Users/macmini/workspace/13-Graph`，分支 `feat/app-ux`，基线 `c78276a`。不要改 `main`，不要删 `feat/unified-console`，不要付费供应商调用，不要重做已关闭的 U00–U11 / K01–K05。只修本报告 P1；P2 除非用户明确扩大范围。

### P1-A  digest fail-closed

- 改 `openPiInstance` 恢复：`manifest.version >= 2` 时 `capabilityDigest` 必有且非空，并与本次传入值逐字相等。
- 空字符串不得再被 worker 当成「未提供」。
- 测试（先红后绿）：复用独立探针三种情况；生产 adapter 路径也要在第二次 operation 换 bundle 时失败。

### P1-B  扩展工具允许名单

- `piExtensionTools` 缺省语义改为「无声明工具」，不是「不过滤」。
- `tool_gate` 核对该名单。
- 测试：扩展注册 `secret_tool`，manifest 只声明 `extension_probe`；模型请求 tools 不含 `secret_tool`；直接 `tool_gate` 返回 allowed=false。

### P1-C  节点详情中文

- 修 S01；现有 `tests/console/node-detail-ui.test.ts` 或节点投影测试加一句中文断言。

### 验证命令

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
node --run typecheck
./node_modules/.bin/vitest run tests/m0/pi-process.test.ts tests/m0/pi-instance.test.ts tests/console/capability-bundle.test.ts tests/console/presets.test.ts tests/console/node-detail-ui.test.ts tests/m3/capabilities.test.ts
./node_modules/.bin/vitest run
```

全量必须保持绿。若 vitest 再次改 `docs/planning/acceptance-evidence/master-agent-entry/*.png`，按当前 HEAD 恢复，不要把截图噪声提交进来。

### 关闭标准（下一轮独立验收）

1. 独立复跑 typecheck + 全量 vitest 绿。
2. 独立探针：mismatch 拒绝、omitted 拒绝、same 通过。
3. 未声明扩展工具不可调用。
4. 节点详情无英文 `bundle`。
5. 诚实清单：P2（完整 CapabilityBundleVersion、`noTools:"all"`、`ext_` 前缀、manifest 的 Pi version/model/tools）若未做，必须写明未做，不得标已完成。

## 已认可限制（不作为本轮 P1）

- 研究 6.1 的完整 `runtimePolicy` 对象未建模；沙箱仍走现有 `acquireRestrictedExecutor`。
- 未做真实付费供应商 + 真实第三方 Pi extension 包。
- `openPiInstance` 仍给测试夹具直连宿主进程；生产 adapter 已改进程隔离。
- 未发布定义仍走 briefing-only 空包（缺的是定义，不是绑定版本）。绑定了但未安装的能力已经 fail closed。

## 收尾

未修改产品源码。独立探针与本报告在规划目录；`*-independent/` 证据目录已被 gitignore。跟踪工作区在复原截图后干净。

**两轴统计：Standards 硬 1；Spec P1 2、P2 2。整包不关闭。**
