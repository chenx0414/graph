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

本轮修复提交 `8e3cd9f`（`feat: load bound extensions in a restricted worker and add remote MCP and retrieval`）；其后的 docs 提交只记录该哈希。

## 第六轮真实运行准备（2026-09-12）

使用者提供 commandcode 端点配置：实现模型 `deepseek/deepseek-v4-flash`，审查模型选同系列 `deepseek/deepseek-v4-pro`；密钥只在运行环境变量中使用，未写入仓库。

- **契约预检**：`accept:m7:contract` 改为每个模型 2 次小请求（普通回答 + `emit_token` 工具调用），记录 reportedModel、reasoning、finishReason、tool calls 与 usage。两个模型四项全部通过，reportedModel 可区分；推理模型需要足够的输出上限（`v4-pro` 在 16 token 下会耗尽推理预算，脚本改为 256）。
- **主管提示修复**：真实运行暴露主管无法猜到 proposal schema（首次 72 次提案被拒）与需求版本错误。现在主管提示包含 requirement version、配置模型列表与完整 `proposalJson` schema（含 `graph.command` / `graph.verify` / `graph.human_check` 与 loops），briefing 也带上需求版本；回归 `tests/m3/production.test.ts`。
- **Pi 会话预留修复**：主管一次会话实际消耗约 116k token，超过适配器 40k 预留而触发 `reservation_exceeded`。`createPiAdapter` 预留改为 2,000,000（覆盖多轮会话，仍受实例 20M 预算与逐调用门约束）；回归 `tests/m3/production.test.ts`。
- **续跑支持**：`GRAPH_M7_ACKNOWLEDGE_OVERRUN=1` 显式确认已记录的 `reservation_exceeded`（问题与用量仍完整保留在报告中），不重跑已完成节点；回归 `tests/m7/harness.test.ts`。

真实运行记录（工作目录均在仓库外）：

- `graph-m7-acceptance`：主管循环 144 次无效提案后 provider 断流，任务保持 `unknown_usage` 待核对，作为审计保留。
- `graph-m7-acceptance-2`：主管 45 次调用内产出有效提案，随后 provider 断流，任务保持 `unknown_usage` 待核对，作为审计保留。
- `graph-m7-acceptance-3`：主管产出提案版本 1；确认超额后 master 标记成功，当前停在需求确认，等待使用者 `GRAPH_M7_ACCEPT=1`。

## 第七轮网关传输加固（2026-09-12）

- provider 网关偶发在响应头到达前重置连接（Pi 显示 `Connection error.`），旧行为按未知用量阻塞整个 Agent，长任务几乎无法完成。`src/runtime/controlled-openai.ts` 现在只对**未收到任何响应头**的 socket 级失败做有界重试（最多 3 次、500ms/1s 退避），重试仍在同一 invocation 与同一 send gate 内；重定向（`redirect:'error'`）与中止不重试；全部失败仍记未知并停下。回归 `tests/m0/pi-calls.test.ts`。
- 网关另有单次流时长上限（观察到 13 分 06 秒的中止）。真实运行用 `GRAPH_M7_MODEL_MAX_TOKENS=8192` 让单轮更早结束。
- 为了让已确认的提案不白费，新尝试（工作目录 `graph-m7-acceptance-5`）直接复用 workdir-4 中使用者确认过的同一提案内容，不重新生成、不改变范围。

## 第十轮：返工复验（2026-09-12，第二轮）

[第二轮复验](rework-acceptance-2026-09-12.md) 保留原六项修复，但新增 S2/S3/R6/R7。Graph 侧已修复：

- S2（`execution.ts` 核对路径）：`reconcile_usage` 不再直接改状态，而是按 invocation 去重累计同一 operation 的全部已知用量，写入 `operations.usage` 与 `instances.used`，再走正常结算；未知调用保持 unknown。
- S3：核对放行走完整结果结算（output、route、outputVersion、waiting 问题、额度与证据校验）；后继拿得到输出，等待问题不丢失，重复答复因问题已解决被拒。
- R6：本地网络检查的监听限定为显式 loopback；因 Seatbelt 无法区分通配绑定，宿主为每次 `localNetwork` 运行写入 listen/bind 守卫（非 `127.0.0.1`/`::1`/`localhost` 直接 EPERM），真实无头浏览器检查仍通过。
- 真实任务投影修复：对 `graph-m7-acceptance-8` 的 `work-errors` 补记已知用量 5,661,736 与输出（`usage-repair.json`），未知记录保留，费用仍 unknown；完成态任务不重开，超预留缺口在修复记录中说明。
- 复验：`reconcile-usage-rework.mts`（累计已知用量、后继拿到 `{work:{answer:42}}`、waiting 保留、超预算被阻）、`local-network-rework.mts`（非 loopback 监听被拒）；Graph 测试 38 文件 / 177 项。

R7（交付 `page.js` 的导出失败误报成功）已由新的小型 Graph 任务在交付副本修复并重绑证据：工作目录 `graph-m7-acceptance-9`，任务 `834a5a88-c5f7-45a7-9b52-a6e0e95b0e4a`（提案由操作方脚本化，work=flash、review=pro），交付 `main` → `001f288a5a9fc797893497764d73bfe000bb198d`；a1–a5 全部有效，交付测试 40/40（含新增 HTTP 500/网络拒绝的真实页面回归），独立审查 `docs/review-web-v3.md` 通过；`web-export-error-rework.mjs` 复验输出：HTTP 500 时页面显示“导出失败：原因”并提示可重试，`falselyClaimsSuccess:false`。206 次 invocation / 3,481,777 tokens；work 超预留已显式确认。

### 第十轮两轴审查（2026-09-12）

**Standards**：无硬性违反。`reconcile_usage` 改为复用正常结算路径（单一真相来源），不再手写状态转移；listen/bind 守卫由宿主写入 scratch 并以 `NODE_OPTIONS` 注入；回归覆盖已知用量累计、后继输出、waiting 保留、重复答复拒绝与非 loopback 监听拒绝；提交约定式、注释英文。判断性说明：SBPL 的 `local ip` 只能写 `*`/`localhost`，守卫是对该表达力缺口的显式补充；`graph-m7-acceptance-8/usage-repair.json` 是仓库外的历史投影修复记录。

**Spec**：S2（核对后按 invocation 去重累计已知用量，真实任务补记 5,661,736）、S3（output/route/版本/waiting/额度校验走正常结算）、R6（非 loopback 监听 EPERM、loopback 与真实无头浏览器检查通过、Agent/MCP/扩展仍禁网）、R7（HTTP 500 与网络拒绝显示失败原因并可重试，a1–a5 绑定 `001f288`）均按复验条件关闭。边界：第三轮任务提案由操作方脚本化（按“无需重跑昂贵任务”）；交付树含两个工作节点留下的 1 行 `scratch-*.mjs` 占位文件（未使用，不影响验收）；费用仍为 `unknown`。

## 第九轮：最终验收返工（2026-09-12）

[独立验收](final-acceptance-2026-09-12.md) 判定 S1 与 R1–R5 未通过后：

- Graph 修复（提交 `8c17e26`）：传输失败不再静默重发，仅可证明未发出的请求会以新 invocation 重新过暂停与额度门，其余记录 `unknown usage` 并阻塞；远程 MCP 每次工具执行校验 `mcp:<capabilityId>:<toolName>` 任务预授予，未授权产生 permission 问题；远程 MCP 每次实际 HTTP 发送都重新过暂停门；已确认检查可在同一 macOS 沙箱内绑定 loopback 并运行真实无头浏览器。
- 宿主核对路径（提交 `edbf124`）：供应商不提供失败调用用量时，使用者/宿主可用带说明的 `reconcile_usage` 显式放行；未记账调用保持 `unknown` 与费用 unknown，不折算为零。
- 复验证据：`provider-transport-retry.mts`（1 次请求、暂停后不再发送、unknown usage）、`remote-mcp-granted.mts`（授权匹配可达 `tools/call`，握手暂停后不再发送）、`a13-delivery-fixed.mjs`（非零业务码与采集异常进入 `errors`/`incomplete`/进度与日志）；原 `remote-mcp-boundary.mts` 与 `a13-delivery-errors.mjs` 保留为返工输入。
- 真实 Web 返工：工作目录 `graph-m7-acceptance-8`，任务 `0e3c3c4d-52ed-48fe-935c-7d568be9679d`，交付 `main` → `b1754fac`；a1–a4 全部有效；交付测试 38/38（含真实无头 Chromium E2E）；独立审查 `docs/review-web-v2.md` 通过；人工检查由使用者完成。487 次 invocation / 10,422,914 tokens；1 次未知用量与 1 次审查超额均已显式记录。A13 最终通过。
- harness 修复（提交 `9efd856`）：非人工问题在确认循环内被回答后会重新驱动，不会停在无 open 问题却仍有 pending 节点的状态。

### 返工两轴审查（2026-09-12）

**Standards**：无硬性违反；提交约定式、注释英文、每项修复均带回归。判断性说明：`localNetwork` 只由 `graph.command` 检查传入（`execution.ts` 首处），Agent 工具、本地 MCP 与扩展保持禁网；新增 Seatbelt 规则集中在受限 executor 并有注释；`reconcile_usage` 只存在于已认证的 `user.answer` 路径，未记账调用保持 `unknown`。

**Spec**：S1（断线不重发、仅可证明未发送才以新 invocation 重过门、暂停期间不发送、未知用量阻塞）、R1（逐次工具授权、未授权产生 permission 问题、回答后放行、注解不构成授权）、R2（每次实际 HTTP 发送重新过门）、R3（Web 五步闭环 + 真实无头 Chromium E2E + 绑定 `b1754fac` 的证据与独立审查）、R4/R5（非零业务码与采集异常进入 `errors`/`incomplete`/进度与日志）均按返工条件复验。新增边界：宿主 `reconcile_usage` 放行需带说明且不折算为零；交付目标仍是隔离副本，原仓库合入/发布由使用者决定；费用保持 `unknown`。

## 第八轮：真实 A13 执行结果（2026-09-12）

> **2026-09-12 独立验收修正：本轮的“首版完成”结论作废。**复核发现传输重试绕过暂停门、远程 MCP 缺操作授权、握手暂停后仍发送请求，以及 A13 未交付规定的本机 Web 应用与两项交付错误；A06/A08/A10/A13 返工中。见 [final-acceptance-2026-09-12.md](final-acceptance-2026-09-12.md)。

使用者在 commandcode 网关上授权真实运行（实现 `deepseek/deepseek-v4-flash`，审查 `deepseek/deepseek-v4-pro`）。

执行链：契约预检（普通回答 + 工具调用、reportedModel 可区分、usage 可解析）→ 真实运行。运行中暴露并修复：

- 主管提示缺 proposal schema/需求版本/模型清单（首次 72 次无效提案）；
- Pi 一次会话实际 ~116k token > 适配器 40k 预留；
- 网关偶发在响应头前重置连接（同一 invocation 内有界重试）；
- worker 把输出预算花在探索上而不写文件（提示尽早写文件）；
- `run_command` 参数被当作完整 shell 命令（工具描述写明 command/args 形状）；
- 审查模型缺少 verifier 报告 schema（briefing 注入）。

失败尝试保留在 `graph-m7-acceptance`…`-6` 作为审计；最终任务 `346cd2af-94e0-438d-aad6-4b2a9df925b2`（工作目录 `graph-m7-acceptance-7`）复用使用者已确认的提案版本 1，work 用 flash 实现、review 用 pro 审查。

结果：a1–a5 五项验收在提交 `725cb1be6e005f45fdbe7000f6e0210fb47300bf` 上全部有效；真实采集 60 条收藏 0 失败，笔记/导出出现真实“无字幕”失败原因；独立审查报告 `docs/review-bilibili-web-v1.md` 随交付合入；隔离副本 `main` 快进到 `725cb1be`；179 次 invocation / 2,193,329 tokens / 17.3 分钟；未配置费率，费用保持 `unknown`。完整报告在仓库外 `/Users/macmini/workspace/graph-m7-acceptance-7/`。

首版完成判定：真实任务验收（A13）与执行机制验收（A01–A12）均已通过；合入使用者原仓库、配置 remote 或发布仍由使用者决定。

本轮相关提交：`8e3cd9f`（受限扩展/远程 MCP/检索）、`81dc0cf`（真实运行加固）、`fe04a78`（任务图注入 briefing）、`a2fd199`（传输重试）、`77cdb74`（worker 提示）、`97d6224`（run_command 说明）、`6be3c66`（审查 schema）；收尾 docs 提交只记录这些哈希。

### 最终两轴审查（2026-09-12）

**Standards**：无硬性违反；代码注释英文、提交约定式、测试随修复落地。判断性意见：`pi-adapter` 的主管提示内嵌较长 schema（下次若再膨胀应抽成提示模板）；`mcp-client` 同时承载 stdio/HTTP 两种 exchange（仍属单一职责）；`controlled-openai` 的传输重试策略（同 invocation、最多 3 次、仅 socket 级错误、不重试重定向/中止）已写进注释。

**Spec**：

- 第 3 项三项能力均按定义版本加载、真实可调用，且都过同一暂停/额度门；扩展越权写入被拒，未把“显式拒绝”当作实现。
- 第 4 项契约预检覆盖普通回答与工具调用；真实运行经使用者确认提案、扫码登录并确认人工检查后完成。
- 第 5 项真实调用、验收证据（a1–a5 绑 `725cb1be`）、合并记录（`main` 快进）与交付测试（22/22）均已保存。
- 需要说清的两点：最终任务复用使用者已确认的提案（提案本身由主管模型自主生成）；真实运行目标为隔离副本，原仓库合入/发布仍由使用者决定；未配费率，费用按规则记 `unknown`。

本轮修复提交 `81dc0cf`（`fix: harden the real acceptance run for reasoning models`）；其后的 docs 提交只记录该哈希。
