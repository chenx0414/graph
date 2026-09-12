# 第三轮修复后的简要验收与后续计划

日期：2026-09-12。基线 `f1ddaaa`，本次检查 `31ce71a` 及文档提交 `9529605`。本轮仅做有界抽查与规划，不修改产品代码，不执行真实供应商请求、登录或发布。

**结论：旧 R1/R2 反例已修复；R3 部分交付，R4 尚未完成；真实模型试跑前仍有代码问题需要先修。**

## 实际复验

- 项目 Node `v24.20.0`；主与 Web TypeScript 检查通过。
- `vitest run`：**34 个文件、139 项测试通过**。
- `vite build`、`git diff --check` 通过。
- `symlink-boundary.mts`：拒绝越界，`outsideValue:null`。
- `followup-message.mts`：`requests:2, followupReachedProvider:true`。
- Skill、本地 stdio MCP、命令检查的新用例通过；扩展实际加载、远程 MCP 和网络检索仍未实现，不能把限定范围的 R3 关闭等同于完整产品出口。

## Standards

**S1 / P1：命令通道仍可修改 Git 元数据。** [workspace-command.ts:50–55](../../src/runtime/workspace-command.ts) 允许写整个工作区，Node 脚本可以绕过“只读 Git 子命令”的限制；[capabilities.ts:54](../../src/runtime/capabilities.ts) 也使用同类授权。实际通过公开 runner 在临时真实 Git 仓库执行 `node check.mjs`，`.git/HEAD` 从 main 改为 changed，退出码为 0。

违反架构中“共同 Git 元数据由 Git 模块管理，普通工具对其写入也需受控”的要求。修复应在共享 OS 执行边界保护 `.git` 文件/目录和 worktree 管理路径，覆盖命令及 MCP；不能只保护文件编辑工具。

复现：`./node_modules/.bin/node docs/planning/acceptance-evidence/command-git-boundary.mts`。本次输出：`{"code":0,"before":"ref: refs/heads/main\n","after":"ref: refs/heads/changed\n"}`。

## Spec

**P1：新增 graph.command 的验收命令仍能被主管修改。** [revision.ts:34–47](../../src/core/revision.ts) 冻结 action/verifier/dependencies，却没有冻结程序节点 input；[execution.ts:586–617](../../src/core/execution.ts) 又把 input 中的命令退出 0 作为验收证据。

公开 Task Runtime 复现：确认 `node --test fail.test.js` 后，主管通过 revise 改为 `node --version`，修订成功，检查状态 succeeded，并生成该验收项的 valid 证据。原失败测试从未通过。该诊断没有独立审查门，因此没有声称它已最终合并；仅“未经用户同意即可改变已确认检查并取得通过证据”已违反原验收规则。

复现：`./node_modules/.bin/node docs/planning/acceptance-evidence/command-input-revision.mts`。本次输出：`{"graphVersion":2,"checkStatus":"succeeded","evidence":[{"acceptanceId":"test","summary":"Command exited 0: node"}]}`。应固定影响检查语义的输入、参数和环境，改变时走用户确认。

**P1：真实验收入口不能按当前说明可靠续跑。** [examples/m7-acceptance.ts:62](../../examples/m7-acceptance.ts) 默认以时间戳创建新目录，而暂停提示要求仅增加 ACCEPT/LOGIN 标志重跑；这会创建新任务并确认未经展示的新提案。即使手动固定目录，第 106 行也查找所有历史 human_check 中的第一项，第 113 行固定答复键；发生重检后可能一直重答旧问题。此项为代码核对，没有执行真实供应商。

修复应持久保存并展示运行目录、任务 ID、完整提案及版本，输出准确续跑命令；只答复当前 open 且与指定人工检查匹配的问题，按 question/activation 生成幂等键；若需求、目标提交或问题变化，应重新呈现对应确认，不能沿用常驻 flag 自动确认新内容。

费用准备：当前 harness 没有模型价格配置，估算费用会显示 unknown。原产品允许未知价格，因此这不是单独的阻断缺陷；实际试跑前应支持可选费率与来源记录，继续保留 unknown 语义。

Standards：1 项新 P1；Spec：2 项新 P1，另有已明确未完成的能力和 A13 范围。现有测试通过不等于这些反例已受保护。

## 后续事项与完成条件

| 顺序 | 工作 | 完成条件 / 所需介入 |
| --- | --- | --- |
| 1：优先修复 | 验收命令不可被主管削弱；命令/MCP 不能修改 Git 元数据 | 两份新诊断变成保护预期行为的回归；真实沙箱与 Task Runtime 测试通过 |
| 2：修好真实运行入口 | 固定运行目录、完整提案展示、精确确认版本、人工检查和重启续跑 | 本地 provider 驱动完整 harness，多进程覆盖确认前退出、登录等待、目标前移和重复重跑；同任务不重建、旧确认不复用、费用未知明确显示 |
| 3：补齐原范围能力 | 受限 worker 扩展加载、授权范围内的网络检索与远程 MCP | 按版本加载后真实可调用；仍过暂停/额度/权限门；不能把“显式拒绝”当成“能力已实现”。可以与第 2 项并行，按真实任务需要安排顺序 |
| 4：真实模型预检 | 配置实际实现/审查模型、端点与密钥，核对模型身份和 usage/缓存计量 | 使用者提供配置及对应调用授权；不因两个别名不同就认定底层模型不同；少量契约请求通过后再进入任务 |
| 5：执行真实 A13 | 在约定隔离副本由 Graph 讨论、规划、编码、检查、独立审查、必要返工并合并 | 用户确认完整提案和目标；在准确副本/profile 完成真人登录与页面检查；保存实际 invocation、证据、图、用量/费用状态与合并 SHA |
| 6：最终收尾 | 对原矩阵逐项复验、两轴审查、更新完成声明 | 核心机制及 A13 都有真实对应证据才标首版完成；是否合入原仓库、配置 remote 或发布，按使用者后续指令办理 |

下一轮建议先完成第 1、2 项，之后再安排用户的模型配置与登录；第 3 项仍是原计划内待办，不应从完整完成标准中移除。本轮不新增里程碑或外部 Issue；工作区仍保留使用者原有 `.gitignore` 与历史 `m2-handoff.md`。

## 第四轮修复结果（2026-09-12）

对照上表第 1、2 项逐项落实；第 3 项仍为原计划内待办。

### 第 1 项 · 命令/MCP Git 边界与验收命令不可削弱 · 已修复

- `src/runtime/restricted-process.ts` 在每次派发前扫描写授权内已存在的 `.git` 条目（目录、worktree 链接文件、嵌套仓库），把解析后的 literal/subpath 规则加入 profile；相对、嵌套、绝对与硬链接路径均无法改写 refs、index 或 worktree 链接。命令与 MCP 共用该边界。
- 只读 Git 子命令改以具体 Command Line Tools 二进制运行，并关闭系统/属性配置读取；`git status`/`git log` 在沙箱内实际可用，白名单外 Git 子命令仍被拒绝。
- 回归：`tests/m3/workspace-command.test.ts`（命令改写 `.git` 的四种路径与只读 Git）、`tests/m3/capabilities.test.ts`（MCP 工具写 `.git` 被拒）；`command-git-boundary.mts` 输出 `protected:true`。
- `src/core/revision.ts` 固定已确认验收检查项的 input：把 `node --test fail.test.js` 改成 `node --version` 的修订以 `invalid_proposal` 拒绝，图版本、检查状态与证据不变；不涉及检查输入的新增节点修订仍可应用。主管 briefing 现在包含当前图，便于保留确认输入。
- 回归：`tests/m4/command-check.test.ts`；`command-input-revision.mts` 输出 `revisionRejected:true`、`graphVersion:1` 且无有效证据。

### 第 2 项 · 真实运行入口可续跑 · 已修复

- `examples/m7-acceptance.ts` 改为固定运行目录（默认 `../graph-m7-acceptance`），`run.json` 保存 taskId 与已确认记录；同一目录重复运行始终复用同一任务。
- 确认协议：`GRAPH_M7_ACCEPT=<proposalVersion>` 只确认本次打印的准确版本；登录检查只回答 `GRAPH_M7_LOGIN_CONFIRMED=<questionId>` 指定的当前 open 问题；被新 activation 替代的旧问题只做清理，目标前移后旧确认不会用于新提交；每次运行写出 `acceptance-report.json`（完整提案、问题、证据、费用来源与续跑命令）。
- 费用：可选 `GRAPH_M7_MODEL_INPUT_COST/OUTPUT_COST/CACHE_READ_COST/CACHE_WRITE_COST` 注入费率；未配置时报告继续保留 `cost: unknown`。
- 多进程回归（本地 provider 驱动真实 harness）：`tests/m7/harness.test.ts` 覆盖确认前退出、错误版本被拒、登录等待、目标前移、旧确认不复用、确认当前问题后合并、重复重跑为 no-op 且不新增模型请求；全程只有一个任务。

### 仍未完成

- 第 3 项：受限 worker 内扩展加载、授权范围内的网络检索与远程 MCP 未实现；绑定扩展仍以具体原因阻塞，不能当作能力已实现。
- 第 4–6 项：真实模型预检、A13 真实运行与最终收尾待使用者提供模型配置与登录；A13 不标通过。

本轮修复提交 `81016a1`（`fix: close fourth-round acceptance findings`）；其后的 docs 提交只记录该哈希。

## 第五轮修复结果（2026-09-12）

上表第 3 项已实现：受限 worker 扩展加载、授权范围内的网络检索与远程 MCP。

- **受限 worker 扩展**：`src/runtime/extension-worker.mjs` 在受限 executor 内加载扩展快照，扩展只看到最小 `register(api)` 接口；后台进程不 import 第三方代码。工具每次 exchange 一个受限进程，写入限工作副本与 Graph scratch，经同一 send gate。`tests/m3/capabilities.test.ts` 验证扩展工具真实可调用、越权写入被拒、零用量 invocation 与暂停不启动进程。
- **远程 MCP**：`capability.json` 支持 `transport: http` + `url`（可选 `headers`/`headersEnv`）；运行时需用 `network.mcpDomains` 授予域名，未授予时节点以具体原因停止。Streamable HTTP 客户端拒绝重定向、限制响应大小，每次 exchange 一条 invocation。
- **网络检索**：`src/runtime/retrieval.ts` 是受控读取 broker；只放行 `network.retrievalDomains` 中的域名，拒绝内嵌凭据与重定向，只接受文本类响应并限制大小。`fetch` 工具只在授予域名时出现在 Agent 工具列表。`tests/m3/retrieval.test.ts` 覆盖允许、未授予域名在请求前被拒、非文本拒绝、重定向拒绝与暂停不发请求。
- 公开入口观测：`capabilities.mts` 输出 `granted-capabilities-callable`（三项真实可调用、`questions:[]`）与 `retrieval-domain-denied`。
- 本仓库定义的扩展工具协议不是官方 Pi 扩展 API 的完整实现；其他平台与远程 MCP 的其他 transport 仍未验证。
