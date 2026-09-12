# f1ddaaa 简要复验与后续交接

日期：2026-09-12。被验收提交 `f1ddaaa65de0810bc515dc54c145387b2c947def`，比较基线 `d0193bb`。本轮为有界抽查，**修复有进展，整体仍未通过**；不表示重新证明了 A01–A13 的全部出口。

> 第三位 Agent 按本文 R1–R4 修复并复验；结果见 [第三位 Agent 的复验结果](#第三位-agent-的复验结果2026-09-12)。R1–R3 已关闭并有回归；R4 的机制缺口已补齐，真实模型运行仍待使用者介入，A13 不标通过。

先读 [原验收报告](acceptance-m2-m7.md) 与 [修复自述](acceptance-rework.md)。保留已有修复与回归，不从历史 `m2-handoff.md` 恢复实施。

## 本次实际检查

- 项目 Node `v24.20.0` 下运行 `npm run check`，调用项目的 `pnpm typecheck && pnpm test`：前后端类型检查通过，**30 个文件、124 项测试通过**。
- `./node_modules/.bin/vite build` 通过，`git diff --check` 通过。
- ST-01/ST-02 的代码已改为保留阻塞、枚举目标实际工作副本；预算、人工确认、评委和 Web 等旧反例已有新增回归。
- 修复报告的 123 项及 handoff 的旧 HEAD/107 项已经过时，后续应按实际提交和复验结果更新。

## Standards：1 项 P1

**R1：新增文件工具可沿符号链接越界。** `src/runtime/agent-tools.ts:18–22` 只对根目录 realpath，目标做字符串前缀检查；第 54 行直接写入。实际工具调用中，`workspace/linked → ../outside`，写入 `linked/evidence.txt` 成功改变了工作副本外文件。

违反 `docs/architecture.md:133` 的实际执行限制和范围授权要求。应保护目标及祖先路径、符号链接竞争和 Git 元数据，并把授权落实在实际执行边界，不能仅修补一个字符串判断。

复现：`./node_modules/.bin/node docs/planning/acceptance-evidence/symlink-boundary.mts`。本次输出：`{"outsideValue":"outside-workspace-write"}`。脚本只使用随后清理的临时目录。

## Spec：3 项 P1

**R2：用户补充需求没有传给主管模型。** `src/runtime/pi-adapter.ts:78–82` 只发送 briefing，`src/catalog/briefing.ts:7–15` 未包含已采集的 `operation.context.messages`。实际生产路径 `begin → runReady → say → runReady` 发出两次请求，但第二请求没有补充需求文本，只重复初始需求。违反 G11 需求讨论和任务交接要求。

复现：`./node_modules/.bin/node docs/planning/acceptance-evidence/followup-message.mts`。本次输出：`{"requests":2,"followupReachedProvider":false}`。使用真实 Pi adapter 和本地 provider，没有收费请求。补充测试应断言 provider 收到内容，而非只断言主管被唤醒。

**R3：生产实例仍未加载定义绑定的能力。** `src/runtime/pi-adapter.ts:66–76` 注入固定工具，`src/runtime/pi-instance.ts:87–90` 仍禁用 Skills/Extensions。能力 ID 出现在 briefing，不等于能力被加载；MCP 调用、构建测试和检索入口仍未贯通。违反 G10“主管可复用新增能力”。需按定义版本加载受限能力，并证明安装后真实可调用、权限不扩大、调用可计量和暂停。本项为代码核对。

**R4：M7 仍缺真实自主任务验收。** `tests/m7/production.test.ts:30–37` 从 fixture 读取完整源码，放入预写 provider 工具响应；第 64 行由测试直接提案，第 54 行使用固定通过的 reviewer，第 89 行由测试确认登录。因此证明的是生产 Pi 传输/工具写文件机制，尚不满足 G18 的自主拆解、实现、独立审查及真实流程出口。

保留该机制测试，另补由实际模型从需求出发完成的任务闭环、实际调用与费用记录、绑定输入的人工登录检查和合并证据。不要把“是否付费”作为真实验收标准；关键是不能预写实现结果或审查结论来代替自主执行。所需模型配置或真实登录若尚不可用，应准确列出所需用户介入，不将未执行项标为通过。

## 第三位 Agent 的工作范围

按 R1/R2 优先修复并增加回归，再补 R3 与 R4；同时对原验收报告逐项复核关闭证据。仍以产品原定 M2–M7 出口为准，不降低标准、不另开新里程碑。结束前运行完整检查、两轴审查、更新验收及 handoff，并提交。遵守既有授权与资源约束，保留使用者的 `.gitignore` 和历史草稿改动。

Standards：1 项 P1；Spec：3 项 P1。没有因现有 124 项测试通过而认定首版完成。本轮仅增加本文与两份诊断程序，未修改产品代码，也未提交。

---

## 第三位 Agent 的复验结果（2026-09-12）

本轮修复提交 `31ce71a`（`fix: close acceptance R1-R3 and prepare R4 real-model run`）；其后的 docs 提交只记录该哈希。按 R1、R2 优先修复，再补 R3、R4，并逐项复核原验收问题。没有降低原出口，没有用预写实现或审查结论替代自主执行，也没有读取 `.env`、调用收费模型或改写使用者原仓库。

### 本轮检查

项目 Node `v24.20.0`，在 Graph 根目录执行（本机 PATH 无 `pnpm`，因此直接调用项目内二进制；与 `pnpm check` 等价的命令为 `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit && ./node_modules/.bin/vitest run`）：

| 检查 | 实际结果 |
| --- | --- |
| `tsc --noEmit` | 通过 |
| `tsc -p tsconfig.web.json --noEmit` | 通过 |
| `vitest run` | **34 个文件、139 项测试全部通过**（新增 15 项回归） |
| `vite build` | 通过 |
| `git diff --check` | 通过 |
| 公开入口诊断 | 8 个程序重跑，输出见 [acceptance-evidence](acceptance-evidence/README.md)；临时 UUID、路径与 SHA 随运行变化 |

### R1 · Standards P1 · 已关闭

- 新增 [bounded-path.ts](../../src/runtime/bounded-path.ts)：不再做一次字符串前缀判断，而是按组件解析并逐项执行边界。拒绝任何符号链接组件、`.git` 组件和越界路径；写入时逐级创建父目录并复核 canonical 路径；最终以 `O_NOFOLLOW` 打开，并在打开后用 `realpath(parent)` 与 `dev/ino` 比对确认没有换链；写入多重链接文件被拒绝。
- `read`、`write_file`、`list_dir` 全部改用该模块；能力快照通过只读 `read` 入口访问。
- 回归 `tests/m3/agent-tools.test.ts`（5 项）：符号链接目录/文件、硬链接、`.git`、`..`、绝对越界路径均被拒绝且外部文件不变；工作副本内的正常嵌套创建与读取不受影响。
- `symlink-boundary.mts` 更新为记录拒绝结果，现输出 `outsideValue:null`。
- 准确边界：Node 未提供 `openat`/`openat2`，因此残留一个需要同机并发者在极短窗口内两次换链的 TOCTOU 窗口；静态符号链接、祖先符号链接、最终符号链接、Git 元数据和多重链接均已阻断。

### R2 · Spec P1 · 已关闭

- [briefing.ts](../../src/catalog/briefing.ts) 现把 `operation.context.messages` 渲染为按需求版本排列的 `User messages`；[execution.ts](../../src/core/execution.ts) 无论是否发布定义都会生成含该段的说明包。
- 回归 `tests/m3/production.test.ts`：`begin → runReady → say → runReady` 的第二次 provider 请求必须包含 `FOLLOWUP_SENTINEL_97531`，第一次不得包含。
- `followup-message.mts` 更新后输出 `{"requests":2,"followupReachedProvider":true}`。

### R3 · Spec P1 · 已关闭（范围见下）

生产实例现在按实例绑定的定义版本解析能力并真正加载：

| 能力 | 实际行为 | 证据 |
| --- | --- | --- |
| Skill | 安装快照经 `additionalSkillPaths` 交给 Pi 资源加载器，进入模型系统提示；`read` 可读取快照内文件 | `tests/m3/capabilities.test.ts`：请求含技能名/描述，模型按 `<location>` 读到 SKILL.md 正文 |
| MCP | 真实 stdio JSON-RPC（`initialize`、`tools/list`、`tools/call`）成为可调用工具；每次调用一个受限进程（macOS 沙箱：网络拒绝，写仅限工作副本与 Graph scratch），经同一 send gate，暂停阻止且每次调用记一条 invocation | 同文件：MCP 写入工作副本、外部写入被拒、`tools/list` 与 `tools/call` 各记一条零用量 invocation、暂停时进程不启动 |
| 扩展 | 定义绑定扩展时节点以具体原因失败，不在后台进程加载第三方扩展代码；架构要求扩展在受限 worker 内运行 | 同文件：`execution_failed` 问题含 `Extension ext@1.0.0` |
| 构建测试 | 新增默认 `run_command`（`node`、只读 `git` 白名单），受限进程执行、可计量、可暂停；新增程序节点 `graph.command` 在集成工作副本运行允许命令，退出 0 才产生绑定当前提交的验收证据 | `tests/m3/workspace-command.test.ts`（允许与拒绝）、`tests/m4/command-check.test.ts`（通过/失败/拒绝） |

调用计量与暂停在所有路径生效：MCP 工具与 `run_command` 的进程派发都过 `sendGate`，暂停中的任务不产生新进程；`task-gate` 对零预留调用也会在额度达到上限时阻止新调用。

**未在本轮范围**：远程 MCP 的域名白名单、扩展在受限 worker 内加载、网络资料检索入口。报告中不把这些标为已完成。

### R4 · Spec P1 · 机制已补齐，真实运行待使用者介入

- 保留原 scripted 机制测试 `tests/m7/delivery.test.ts` 与 `tests/m7/production.test.ts`。
- 新增 `graph.command` 程序节点后，真实自主图不再依赖宿主预置的 `check` adapter：验收证据可以由真实命令在集成提交上产生（`tests/m4/command-check.test.ts`）。
- 新增 `examples/m7-acceptance.ts` 真实模型验收 harness（`npm run accept:m7`）：主管模型从冻结需求提案，工人模型在克隆上实现，检查由 `graph.command` 运行，审查由不同模型完成，人工登录项绑定 activation 与集成提交。第四轮起 harness 使用固定运行目录并在 `run.json` 保存同一任务：在需求确认前停下（除非 `GRAPH_M7_ACCEPT=<proposalVersion>` 指定了本次打印的准确版本），并在每个 open 人工检查前停下（除非 `GRAPH_M7_LOGIN_CONFIRMED=<questionId>` 指定该当前问题），见 [第四轮修复结果](next-steps-after-r3.md#第四轮修复结果2026-09-12)。
- **本轮没有可用的真实模型**（本机 Ollama 无模型；既有授权不允许调用收费模型），也没有真实 B站 登录，因此没有执行真实自主运行，**A13 不标通过**。
- 所需使用者介入（准确步骤）：
  1. 配置一个 OpenAI-compatible 端点与两个不同模型 ID（实现、审查），设置 `GRAPH_M7_MODEL_ID`、`GRAPH_M7_MODEL_BASE_URL`、`GRAPH_M7_MODEL_API_KEY`、`GRAPH_M7_REVIEW_MODEL_ID`。
  2. 运行 `npm run accept:m7`，审阅提案后用 `GRAPH_M7_ACCEPT=<proposalVersion>` 重跑以确认该准确版本（固定目录，同一任务继续）。
  3. 用 CLI 在项目 `.browser-profile` 完成 B站登录；按当前 open 检查打印的 `GRAPH_M7_LOGIN_CONFIRMED=<questionId>` 重跑，让 `human_check` 回答绑定当前 activation 与集成提交；目标前移后旧 id 会被拒并重新呈现。
  4. 检查 `acceptance-report.json`、目标分支提交和 `view().invocations` 的真实调用记录。

harness 只支持已验证的 `openai-completions` transport；其他 transport 仍须按 M0 规则先复验。

### 原验收问题逐项复核

| 编号 | 复核结果 | 本轮证据 |
| --- | --- | --- |
| ST-01 | 已修复 | `tests/m4/acceptance.test.ts` 用量未知后晚到集成不再二次派发；`unknown-usage-recheck.mts` 前后审查次数均为 1 |
| ST-02 / SP-08 | 已修复 | `tests/m4/acceptance.test.ts` 另一 worktree 脏时打开 `git_dirty` 且不裸更新；`core.mts` 目标工作副本无交付文件 |
| ST-03 | 判断性建议，未统一重构 | 三处失效/激活转换仍分散；本轮未改变，理由是没有新的行为缺陷 |
| SP-01 | 已修复并加强 | 生产主管有工作工具、提案与讨论期唤醒；新增 `run_command`、能力加载与 `graph.command` |
| SP-02 | 已修复 | 每次 provider 发送前检查暂停、未知用量与额度；`runtime.mts` 缺用量/超额后不再发第二次请求 |
| SP-03 | 已修复 | 无独立审查门不能合入；`core.mts` FAILING_REVIEW 任务保持 running 且未合入 |
| SP-04 | 已修复 | 修订被拒（`Revision cannot change confirmed verification rules`），`core.mts` 仍为 rework 且未产生通过证据 |
| SP-05 | 已修复 | 审查排除穿过程序节点；`core.mts` 仅剩写模型时打开 `model_unavailable` |
| SP-06 | 已修复 | 人工确认绑定 activation 与提交；`tests/m4/acceptance.test.ts` 目标前移后重新等待 |
| SP-07 | 已修复 | 合格胜者不再因落选候选失败返工；`core.mts` 评委返回 pass、winner=a |
| SP-09 | 已修复 | `ui.mts` 额度答复 HTTP 200、问题关闭 |
| SP-10 | 已修复 | `ui.mts` 后台完成后图节点从 pending 变为 succeeded |
| SP-11 | 机制保留，真实运行待介入 | 见 R4 |
| SP-12 | 已修复 | `media.mts` 未登录拒绝并显示原因；登录后进度 1→2→3 实时可见 |
| SP-13 | 已修复 | `media.mts` 笔记列表有链接，正文接口 200，页面阅读器显示内容 |

### 两轴审查

对 `f1ddaaa..HEAD` 做 Standards / Spec 两轴审查，两轴分开记录：

- **Standards**：未发现新的文档规则违反。命名沿用领域词（能力、定义版本、工作副本、send gate）；注释为英文，提交信息用约定式；新模块按职责拆分；`bounded-path` 与 `capabilities` 的边界逻辑不再散落在工具实现里。判断性意见：`pi-adapter.ts` 同时负责能力装配、命令工具与提示，后续若继续增长应抽出实例装配模块；`execution.ts` 新增 `graph.command` 使该文件更长，但它与本程序节点的其他内建动作同属调度规则。
- **Spec**：R1–R3 的验收点在回归中可观察；R4 按本节说明未执行完。未发现为通过验收而削弱规则、跳过失败测试或以固定结论代替模型判断的改动。

Standards：0 项新违反、2 项判断性意见；Spec：R1–R3 关闭，R4 待使用者介入执行；A13 不标通过。
