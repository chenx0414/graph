# 技能沉淀与进化 实现规格（v1，2026-09-26）

上游研究：`docs/research/hermes-skill-self-learning-2026-09-26.md`（Hermes Agent 的机制与迁移评估）。
本规格把评估结论落成可实现的四阶段（P1–P4），P5 明确不做。

**目标线**：实现分支从 `13-Graph` 的 `main` 拉出；验收通过后由主 Agent 收敛到运行线（`graph-rsi` 的 `rsi/product-line`）+ 门禁 + `app:build`/`app:verify` + 重载 + 现场自验。
**不新增依赖**；不改 SDK；不引入第二套技能加载器（技能仍由 Pi SDK 原生加载）。
**测试总则**（依 rules）：E2E 优先、可重复产物；单测只测外部行为；不为了过门禁弱化断言；check 节点不得开监听端口、不开真实长驻进程。

---

## 0. 术语与现状（实现者必须先读的既有事实）

| 事实 | 位置 |
|---|---|
| 技能来源（按优先级自动发现）：Agent 自己的目录 `~/.graph/agents/<recipe>/skills`（recipe 绑定技能以 symlink 镜像进来）、`~/.agents/skills`、**项目级** `<cwd>/.agents/skills` 与 `<cwd>/.pi/skills` | `src/runtime/agent-skills.ts`（`agentSkills`/`nativeSkillDirs`） |
| 技能在提示词里的呈现 | SDK 的 `formatSkillsForPrompt`，`<available_skills>` 块；`disable-model-invocation: true` 的技能**不进**该块 |
| 能力库 | `<capabilityRoot>/skills/<id>/{SKILL.md,capability.json,...}`；`capability.json` 有 `id/kind/version/name/description/source/tags/importedAt` |
| 配方绑定 | `~/.graph/agent-combinations.json` + `POST /api/catalog/combinations`（见 `docs/agent/agent-recipes.md`） |
| 工具调用遥测 | `tool_calls(id, instance_id, task_id, node_id, role, tool, ms, is_error, created_at)`；worker 车道额外走 `<stateDir>/tool-calls/<instanceId>.jsonl` spool（`src/runtime/tool-call-spool.ts`），读取时按字节偏移增量吸入 |
| 程序节点动作 | `graph.command`（`input: {command, args}`）、`graph.verify`、`graph.human_check` | `src/core/execution.ts:405-420`、`src/core/program-adapters.ts` |
| 受限 Pi 实例接缝 | `openPiInstance({... allowedToolNames, systemPrompt, skillFolder, skillPaths, stream, model, forkFrom ...})` | `src/runtime/pi-instance.ts:57-144` |
| 落「等待使用者」的问题 | `kind: 'waiting'`（见 `operation-lifecycle.ts:727`） |
| 提示词库 | `<graphHome>/prompts/**`（键如 `rules/*.md`、`tools/main.md`、`runtime/worker.md`），控制台「Agent 上下文」可读可改 |
| 现有检查入口 | `node --run check` = typecheck + lint + test + check:evidence |

**本轮不做**（写了理由，避免实现者顺手扩范围）：
- **不加 Hermes 式 `skill_manage` 工具**：Agent 已有 `write`/`edit`，缺的是**契约与校验**，不是又一个写入口（奥卡姆）。
- **不做 curator 式确定性归档**：Graph 的技能由 recipe 显式绑定，不存在「无界写入导致窄技能堆积」的成因；误伤低频关键技能的风险大于收益。
- **不做 LLM 伞化合并**。
- **不自动改库内/上游技能**：库技能与 `imported` 技能一律只读；要改必须由使用者批准（见 P3 的提案门）。

---

## P1 技能写作契约 + advisory lint

### 交付
1. `scripts/skills-lint.mjs`（新），`package.json` 增加 `"skills:lint": "node scripts/skills-lint.mjs"`。
2. `docs/agent/skill-authoring.md`（新）：写清「技能放哪、front-matter 契约、怎么验收、沉淀与晋升的边界」。
3. `tests/console/skills-lint.test.ts`（新）。

### 行为
- **检查范围**（**默认只查自著技能**，其余一律跳过）——这是实测后的修正：仓库里现有 22 个项目技能中 15 个不符合下面这套契约（多为描述不含触发条件句式，另有两个描述超 300 字符），它们是**使用者导入的技能**，不是我们写的；把规则套上去既越界，又会逼实现者去改上游内容。
  - **自著技能**（唯一默认对象）：SKILL.md 的 front-matter 声明 `created-by: graph-agent`（放哪都认：`<root>/.agents/skills/*`、`<root>/.pi/skills/*`、能力库 `<capabilityRoot>/skills/*`）。
  - `--all` 才会把范围内的**其它**技能也纳入，且只跑下面的**硬规则**，不跑建议规则。
  - `imported`/上游/`bundled` 技能在任何模式下都**不做**建议规则检查。
- **规则**分两层（都输出 `warn`，默认不阻断）：
  - **硬规则**（自著技能一律；`--all` 时扩展到全部）：`missing-frontmatter`、`name-mismatch`、`description-too-long`（>300）、`oversized-body`（>24,000）、`references-sprawl`（>60）、`references-incident-named`。
  - **建议规则**（**仅自著技能**）：`description-not-triggering`、`incident-log-shape`。

  完整判据：
  | 规则 id | 判据 |
  |---|---|
  | `missing-frontmatter` | 缺 `name` 或 `description` |
  | `name-mismatch` | front-matter `name` 与目录名不一致 |
  | `description-not-triggering` | `description` 不含触发条件：**大小写不敏感**匹配 `/use when\|use for\|use before\|use this when\|use this skill when\|when the user\|when you\|何时\|当你\|适用于/`（实测：这个句式表比首版更宽，否则连仓库里合规的技能也会被误判） |
  | `description-too-long` | `description` > 300 字符 |
  | `oversized-body` | 正文（去 front-matter 后）> 24,000 字符（`read` 会整篇进上下文） |
  | `references-sprawl` | `references/` 下文件 > 60 |
  | `references-incident-named` | `references/` 文件名以 `YYYY-MM-DD` 开头或含 `-incident-`/`-session-` |
  | `incident-log-shape` | 正文里 `#\d{3,}`（PR/issue 号）或 ISO 日期出现 > 3 处 |
- **退出码**：默认 0（advisory，像 Hermes 一样只警告）；`--strict` 下有任何 warn 则 1。
- **输出**：人类可读；`--json` 输出 `{skills:[{path,name,warnings:[{rule,message}]}], summary}`；`--root <dir>` 可指定根（默认 cwd）。
- **不进 `node --run check`**（advisory；`check` 只跑 P3 的沉淀 E2E 与既有测试）。

### 验收（A1）
- 仓库内新增**好样本 fixture** `tests/fixtures/skills/good/**`（一份带 `created-by: graph-agent` 的合规范技能）：`node scripts/skills-lint.mjs --root tests/fixtures/skills/good --strict` 退出码 0、零 warn。
- 默认范围下对仓库现有（非自著）技能零 warn——这是范围的直接后果，不是运气：`node scripts/skills-lint.mjs --root . --strict` 退出码 0。
- 测试用临时目录构造 8 类坏样本（外加两个反例：非自著技能不进建议规则；`--all` 时进硬规则），每条规则**各命中一次**（黑盒跑脚本、断言 stdout/`--json` 与退出码）。

---

## P2 技能使用遥测（谁被读过、多久没读）

> 修正：**不是零埋点**。`tool_calls` 目前不记录目标路径，无法反推「读了哪个技能文件」。需要一列。

### 交付
1. **迁移 38**：`ALTER TABLE tool_calls ADD COLUMN target TEXT`；`SCHEMA_VERSION` 37 → 38；迁移测试。
   - `target` = **有界**目标串（≤256 字符）：`read`/`edit`/`write`/`ffgrep`/`ffind` 的 `path` 参数（相对项目根可读化），其它工具 `NULL`。
   - 同一条提取规则用于 master 直写路径**与** worker spool（spool 行增加 `target` 字段；`tool_call_spools` 偏移逻辑不变）。
2. `src/runtime/skill-usage.ts`（新）：`skillUsage(store, {stateDir, projectRoot, capabilityRoot})` →
   `{ skills: [{id, name, path, reads, lastReadAt, neverRead, source: 'project'|'library'|'agent'}], summary: {skills, neverRead} }`
   - 匹配方式：把每个技能目录的绝对路径与 `tool_calls.target`/spool 目标做**前缀**匹配（`<skillDir>/` 或等值）。
   - 保留策略随既有遥测（90 天）走；本函数只读。
3. `GET /api/skill-stats`（会话 cookie + 本地 `Origin`，与其他 `/api/*` 一致）。
4. `src/web/ToolStats.tsx` 增加「技能使用」区块（口径文案 + 表格 + 空态），沿用工具页既有口径写法：**只统计技能文件被读取的次数，不统计技能是否被实际应用**。
5. 测试：`tests/console/skill-usage.test.ts`（注入式：直接插 `tool_calls` 行 + 临时技能目录，断言派生结果与 `neverRead`）；扩展 `scripts/console-ui-e2e.ts` 断言新区块（真浏览器）。

### 验收（A2）
- 迁移后生产库 `PRAGMA user_version = 38`；`tool_calls` 有 `target` 列。
- 注入 fixture 后 `GET /api/skill-stats` 返回正确读数与 `neverRead` 列表；`e2e:console` 对新区块断言全绿并留截图。

---

## P3 收尾自省操作（主动沉淀的核心）

> 这是本轮唯一「新增行为」的部分，因此保守设计：**默认关、显式开启、预算是硬上限、产物落在项目 git 技能里、越界写一律拒绝**。

### 配置（`<graphHome>/graph.config.json` 与运行时 config 同源）
```jsonc
"skills": {
  "sedimentation": {
    "enabled": false,          // 默认关：开启即产生真实模型成本
    "afterToolCalls": 10,      // 一次操作用了 ≥ N 次工具调用才值得自省（Hermes 的经验值）
    "model": "low",            // 走低档模型（可用具体 model id 覆盖）
    "budgetTokens": 40000,     // 该操作硬预算上限，超了停
    "roles": ["master"]        // 只对主 Agent 的操作触发
  }
}
```
理由与取舍（写进文档）：Hermes 默认无人值守直接写、约 30K tokens/事件；Graph 的操作更重，因此默认关 + 预算上限 + 只写项目技能（git 审计），把「无人看管地改库」这条路先关掉。

### 行为
1. **触发**：`Execution` 在一次操作成功收尾后判定 —— 开关开、role 命中、本操作工具调用数 ≥ `afterToolCalls`、任务未暂停、该任务本次操作序列里**尚未**跑过自省（每任务每次推进至多一次）。命中则向该任务追加一个 **program 节点**（`action: 'graph.sediment'`），由调度器正常派发 —— 因此它出现在图里、可观测、可暂停、花费计入用量账本。
2. **节点执行**（`src/core/program-adapters.ts` 新增 `graph.sediment` adapter）：
   - 用 `openPiInstance` 起一个**受限实例**：`allowedToolNames: ['read','ffgrep','fffind','write','edit']`、`model` = 配置档位、`workspace` = 项目根、`skillFolder`/`skillPaths` = 项目技能根、`stream` 走正常模型通道。
   - `systemPrompt` = 新提示词键 **`runtime/sediment.md`**（内容见下），身份与规则按 Graph 现状重写，不照搬 Hermes 的 Claude 语境。
   - **写守卫**：本节点内任何 `write`/`edit` 的路径必须落在 `<projectRoot>/.agents/skills/` 之内；越界即拒绝并写入节点 output（复用 `git.out-of-scope.restored` 同级的越界上报思路，实现为一个前置路径断言）。
3. **提示词资产 `runtime/sediment.md`**（必须包含，来源见研究文档 §3）：
   - **目标形状**：class-level 技能（SKILL.md 常驻规则 + 按主题的 `references/`），不是「一会话一技能」，也不是每吸收一个兄弟加一个 reference 文件。
   - **课 = 可泛化的规则 + 一句 why**，命令式、挂在受影响的那一步、只说一遍；同一个课第二次学到就是**同一条规则**（先搜再写）；**不重复环境已经教过的东西**。
   - **触发信号**：用户纠正了风格/格式/啰嗦度；用户纠正了流程/顺序；出现非平凡技术、绕坑、调试路径、工具用法；会话中读过的技能本身有错/缺步骤/过时。
   - **不许沉淀**：环境相关失败（缺二进制/未装包/路径不匹配/凭据未配）；**对工具或功能的负面断言**；会话内自行恢复的临时错误；一次性任务叙述；**未解决的失败**（不许把死路写成「推荐做法」）。
   - **去处与边界**：只写 `<projectRoot>/.agents/skills/<slug>/`，且 front-matter 必须带 **`created-by: graph-agent`**（否则它不进入 P1 的 lint 范围）；**库内/imported/绑定技能一律只读**；若确实需要改库技能，产出一个 `kind:'waiting'` 的提案问题（`requestType:'user_decision'`）等使用者批准，**不要自行改**。
   - **出口**：`Nothing to save.` 是合法结果，但不许当默认。
4. **节点 output**：`{ written: [相对路径...], nothingToSave: boolean, lint: {warnings: n} }`；节点完成后自动跑一次 skills-lint（advisory，结果写进 output）。
5. **失败与回退**：模型不可用/预算耗尽 → 节点 `failed`，事件里带原因；不重试（避免成本风暴）；不修改任何既有技能。

### 验收（A3）
- `scripts/skill-sediment-e2e.ts`（新）+ `"e2e:sediment": "node scripts/skill-sediment-e2e.ts"`：
  临时 state/graph-home/项目根（**绝不碰生产缓存、不开监听端口的常驻进程**），**stub stream**（可编程返回「调用 write 写一个技能」再「结束」），跑 sediment 节点，断言：
  1. 技能文件落盘且 front-matter 合法、过 skills-lint；
  2. **越界写被拒**（试图写项目根之外 → 节点 output 里出现拒绝项，且文件未创建）；
  3. 开关关闭时**节点不派发**；
  4. 工具调用数不足 `afterToolCalls` 时**不派发**；
  5. `Nothing to save.` 分支不产生任何文件。
- 单测：`tests/console/skill-sediment.test.ts` 覆盖 3/4/5 的判定函数（纯逻辑，不 spawn）。

---

## P4 项目技能 → 能力库晋升 + provenance

### 交付
1. `capability.json` 形状扩展：新增 **`createdBy: "graph-agent"`**（自著技能；`imported` 技能保持只有 `tags:["imported"]`）。
2. `src/runtime/skill-promotion.ts`（新）：`promoteProjectSkill({projectRoot, skillId, capabilityRoot})` → 把 `<projectRoot>/.agents/skills/<skillId>/` 复制到 `<capabilityRoot>/skills/<projectSkillId>/`，写 `capability.json`：
   `{id, kind:"skill", version: <内容 digest 前 12 位>, name, description, source:"graph:project", createdBy:"graph-agent", promotedFrom:<项目相对路径>, promotedAt}`。
   - **幂等**：内容 digest 不变则不重复写；同名但 digest 不同 → 覆盖并 bump version（返回 `replaced: true`）。
3. `POST /api/skills/promote`（body `{skillId}`；cookie + 本地 Origin）：返回 `{promoted: {id, version, path, replaced}, bindHint: "<一行 recipe 绑定提示>"}`。**不自动绑定到任何 recipe**（绑定是使用者的动作）。
4. 测试：`tests/console/skill-promotion.test.ts`（临时能力库根：首次晋升、幂等、digest 变化 → replaced）。

### 验收（A4）
- 晋升后能力库出现该技能目录且 `capability.json` 字段完整；`GET /api/catalog` 的 capabilities 里可见；重复晋升不产生新版本，改动后晋升 `replaced: true`。
- 晋升出的技能**不被** skills-lint 跳过（因为 `createdBy: graph-agent`）。

---

## P5 明确不做（本轮）

curator 式确定性归档、LLM 伞化合并、独立 `skill_manage` 工具、跨项目自动晋升、UI 上的晋升按钮（只提供路由；UI 待使用者确认后再排）。

---

## 交付清单（文件级）

| 阶段 | 新增 | 修改 |
|---|---|---|
| P1 | `scripts/skills-lint.mjs`、`docs/agent/skill-authoring.md`、`tests/console/skills-lint.test.ts`、`tests/fixtures/skills/good/**`（+坏样本 fixture） | `package.json`（`skills:lint`） |
| P2 | `src/runtime/skill-usage.ts`、`tests/console/skill-usage.test.ts` | `src/core/store.ts`（迁移 38）、`src/runtime/tool-call-spool.ts` + 遥测写入接缝（记录 `target`）、`src/server/app.ts`（`/api/skill-stats`）、`src/web/ToolStats.tsx`、`scripts/console-ui-e2e.ts` |
| P3 | `src/runtime/sediment.ts`（节点执行体）、`runtime/sediment.md`（提示词键，落 `<graphHome>/prompts`）、`scripts/skill-sediment-e2e.ts`、`tests/console/skill-sediment.test.ts` | `src/core/program-adapters.ts`（`graph.sediment`）、`src/core/execution.ts`（收尾判定 + 追加节点）、config 默认值与 `docs/agent/self-configuration.md`、`docs/agent/capabilities.md`（技能沉淀一节） |
| P4 | `src/runtime/skill-promotion.ts`、`tests/console/skill-promotion.test.ts` | `src/server/app.ts`（`/api/skills/promote`）、`docs/agent/capabilities.md` |

## 门禁与验收顺序

1. `node --run check`（typecheck + lint + test + check:evidence）全绿；
2. `node --run skills:lint --strict` 退出 0；
3. `node --run e2e:sediment` 全绿（留输出报告）；
4. `node --run e2e:console` 全绿（留截图）；
5. 独立审查（对照本 spec，两轴：规格符合度 + 仓库规范）；
6. 使用者人工验收（含真机观察一次「开启 sedimentation 后的真实沉淀」）。
