# Graph 首版收尾工作报告

日期：2026-09-12（Asia/Shanghai）。基线 `f1ddaaa`，收尾提交 `60fb185`。本报告汇总从第三轮复验接手到首版完成的全部工作、证据与边界；详细过程见各 `mN-results.md`、[acceptance-followup.md](acceptance-followup.md)、[next-steps-after-r3.md](next-steps-after-r3.md) 与 `git log`。

## 摘要

- **首版完成判定：通过。** 真实任务验收 A13 与执行机制验收 A01–A12 均已完成。
- 真实运行：隔离副本上由 Graph 自主实现、检查、独立审查并合入 B站 Web 能力；使用者仅提供模型配置、确认提案、扫码登录并确认人工检查。
- 提交区间：`31ce71a` → `60fb185`，共 14 个提交（含 5 个 docs 记录提交）。
- 测试：基线 30 文件 / 124 项 → 最终 **37 文件 / 162 项全过**；TypeScript（主 + web）、`vite build`、`git diff --check`、10 个公开诊断均通过。
- 原项目 `/Users/macmini/workspace/12-MediaBookmarks` 未被修改（曾临时在其 `.git/info/exclude` 加过一行 `node_modules`，已还原；无 tracked 变更）。

## 1. 第三轮复验的 R1–R4（提交 `31ce71a`、`9529605`）

| 项 | 结果 | 关键实现与证据 |
| --- | --- | --- |
| R1 文件工具符号链接越界 | 已关闭 | `src/runtime/bounded-path.ts`：按组件解析、拒绝符号链接与 `.git`、`O_NOFOLLOW`、canonical/dev-ino 复核、硬链接写拒绝；`tests/m3/agent-tools.test.ts`；`symlink-boundary.mts` 输出拒绝 |
| R2 补充需求未达主管 | 已关闭 | `src/catalog/briefing.ts` 渲染 `User messages`；`tests/m3/production.test.ts` 断言补充文本进入 provider 请求；`followup-message.mts` 为 true |
| R3 定义绑定能力未加载 | 已关闭（当时限定范围） | `capabilities.ts` / `mcp-client.ts` / `workspace-command.ts`：Skill 进系统提示、本地 stdio MCP 每次调用一个受限进程、`run_command` 与 `graph.command` 白名单；扩展当时显式拒绝 |
| R4 真实自主任务验收 | 机制就绪 | `examples/m7-acceptance.ts`（`accept:m7`）：真实模型 harness，确认前/登录前停下 |

## 2. 第四轮审查的 S1 与两项 Spec P1（提交 `81016a1`、`abf357c`）

- **S1 命令/MCP 可改写 Git 元数据**：受限 executor 在每次派发前扫描写授权内已存在的 `.git` 条目（目录、worktree 链接文件、嵌套仓库），以解析后的 literal/subpath 规则拒绝；相对、嵌套、绝对、硬链接路径均覆盖。只读 Git 改用具体 Command Line Tools 二进制并关闭 system/attributes 配置。命令与 MCP 共用该边界。证据：`tests/m3/workspace-command.test.ts`、`tests/m3/capabilities.test.ts`；`command-git-boundary.mts` 输出 `protected:true`。
- **已确认验收检查的 input 在修订中固定**：`revision.ts` 比对已确认提案的 check input，`node --test fail.test.js` → `node --version` 被 `invalid_proposal` 拒绝；主管 briefing 携带当前图以便合法修订保留输入。证据：`tests/m4/command-check.test.ts`；`command-input-revision.mts` 输出 `revisionRejected:true`。
- **真实验收入口可续跑**：harness 固定运行目录并以 `run.json` 保存同一任务；`GRAPH_M7_ACCEPT=<proposalVersion>` 只确认当次打印版本，`GRAPH_M7_LOGIN_CONFIRMED=<questionId>` 只回答当前 open 人工问题；被替代的旧检查只做清理，目标前移重新呈现；可选费率，未配置时保留 `cost: unknown`。证据：`tests/m7/harness.test.ts` 多进程覆盖确认前退出、错误版本、登录等待、目标前移、旧确认不复用、重复重跑不重建任务。

## 3. 原范围能力补齐（提交 `8e3cd9f`、`73ef261`）

- **受限 worker 扩展**：`src/runtime/extension-worker.mjs` 在受限 executor 内加载扩展，扩展只看到最小 `register(api)` 工具接口；后台进程不 import 第三方代码；每次 exchange 一个受限进程并过 send gate，越权写被拒。
- **远程 MCP**：`capability.json` 支持 `transport:http` + `url` 与 `headers`/`headersEnv`；运行时 `network.mcpDomains` 授予域名，未授予时节点以具体原因停止；Streamable HTTP 拒绝重定向、限制响应大小，每次 exchange 一条 invocation。
- **授权范围内网络检索**：`src/runtime/retrieval.ts` 受控读取 broker；`fetch` 工具仅在授予 `network.retrievalDomains` 时出现，只接受文本类响应、拒绝重定向与内嵌凭据、限制大小，并过暂停/额度门。
- 证据：`tests/m3/capabilities.test.ts`、`tests/m3/retrieval.test.ts`；`capabilities.mts` 输出 `granted-capabilities-callable`（三项可调用、`questions:[]`）与 `retrieval-domain-denied`。

## 4. 真实运行准备（提交 `81dc0cf`、`5650f2c`、`fe04a78`、`a2fd199`、`77cdb74`、`97d6224`、`6be3c66`）

- **契约预检**：`examples/m7-contract.ts`（`accept:m7:contract`）对两个模型各发两次小请求（普通回答 + `emit_token` 工具调用），记录 reportedModel、reasoning、finishReason、tool calls 与 usage；发现推理模型需要更大的输出上限。
- 真实运行暴露并修复的缺陷（每项均有回归测试）：
  1. 主管提示缺 proposal schema、需求版本与可选模型 → 首次运行 72 次无效提案；schema 注入主管提示，briefing 带需求版本。
  2. 审查节点不知道 `graph.verify` 的报告结构 → 审查门 rework；briefing 注入 independent 报告 schema 与真实文件摘要要求。
  3. worker 看不到检查命令 → 检查因文件缺失失败；任务图（含检查 input）进入所有 Agent 的 briefing。
  4. Pi 一次会话实际约 116k token，超过适配器 40k 预留 → 预留改为 2,000,000，并加 `GRAPH_M7_ACKNOWLEDGE_OVERRUN=1` 显式确认已记录的超额。
  5. 网关偶发在响应头前重置连接 → 同一 gated invocation 内对 socket 级失败做最多 3 次退避重试；重定向与中止不重试，全部失败仍记未知并停下。
  6. worker 把输出预算花在探索上而不写文件、把 `run_command` 当 shell → 提示尽早写文件，工具描述写明 command/args 形状。

## 5. 真实 A13 执行（记录提交 `60fb185`）

尝试过程（失败目录全部保留为审计）：

| 工作目录 | 结果 |
| --- | --- |
| `graph-m7-acceptance` | 主管循环 144 次无效提案后连接中断，`unknown_usage` 待核对 |
| `graph-m7-acceptance-2` | 主管产出有效提案后连接中断，`unknown_usage` 待核对 |
| `graph-m7-acceptance-3` | 已接受提案；work 因网关 13 分钟流上限中断，`unknown_usage` 待核对 |
| `graph-m7-acceptance-4` | 已接受提案；work 首个请求连接中断，`unknown_usage` 待核对 |
| `graph-m7-acceptance-5` / `-6` | work 成功但未创建检查所需测试文件，4 个 `execution_failed` |
| `graph-m7-acceptance-7` | **成功**：a1–a5 全部有效，`main` 快进到 `725cb1be` |

最终任务记录：

| 项 | 值 |
| --- | --- |
| 任务 | `346cd2af-94e0-438d-aad6-4b2a9df925b2`（工作目录 `graph-m7-acceptance-7`，仓库外） |
| 模型 | 实现 `deepseek/deepseek-v4-flash`，审查 `deepseek/deepseek-v4-pro`（不同模型、独立上下文） |
| 提案 | 版本 1 由主管模型自主生成并经使用者确认；最终任务复用该已确认内容 |
| 交付提交 | `4a4c2e2`（实现）、`725cb1b`（审查）；目标 `main` = `725cb1be6e005f45fdbe7000f6e0210fb47300bf` |
| 交付内容 | 14 文件 +1484/−14 行：`src/commands/bili-web.js`、`src/platforms/bilibili-web.js`、`src/progress.js`、`scripts/sha256.mjs`、四个 `test/bilibili-web-*.test.js`、`src/cli.js`/`src/pipeline.js` 接线、`docs/review-bilibili-web-v1.md` |
| 验收证据 | a1–a5 全部 valid 且绑定 `725cb1be`；交付测试 22/22 通过 |
| 独立审查 | 逐项核对通过，含质量观察与风险；由 pro 模型完成 |
| 真实数据 | 登录确认 ✅；真实采集 60 条收藏 0 失败；笔记/导出出现真实“无字幕”失败原因并汇总显示 |
| 调用与用量 | 179 次 invocation、2,193,329 tokens（work 113 次 / 1,568,072；review 66 次 / 625,257）；未配费率，费用按规则 `unknown` |
| 时长 | 17.3 分钟 |
| 人工介入 | 仅：提供模型配置、确认提案、扫码登录并确认人工检查 |

完整报告：`/Users/macmini/workspace/graph-m7-acceptance-7/acceptance-report.json`、`run-summary.json`、`contract-report.json`（该目录含真实收藏与 profile 引用，未复制进仓库）。

## 6. 最终两轴审查

- **Standards**：无硬性违反；代码注释英文、提交约定式、测试随修复落地、文档记录同步。判断性意见：主管提示内嵌 schema 较长（再增长应抽提示模板）；`mcp-client` 同时承载 stdio/HTTP 两种 exchange（仍属单一职责）；`controlled-openai` 的重试策略已写进注释。
- **Spec**：R1–R4 全部关闭；S1 与两项 Spec P1 关闭；第 3 项三项能力按版本真实可调用且过暂停/额度门；第 4 项契约预检与真实运行完成；第 5 项调用、证据、合并记录齐全。诚实边界：最终任务复用已确认提案；交付目标是隔离副本，原仓库合入/发布由使用者决定。

## 7. 当前仓库状态与验证

- `git status --short` 仅剩约定的 `M .gitignore` 与未跟踪 `docs/planning/m2-handoff.md`。
- `tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`vitest run`（37 文件 / 162 项）、`vite build`、`git diff --check` 全部通过。
- 公开诊断 10 个（`docs/planning/acceptance-evidence/`）：runtime、core、unknown-usage-recheck、ui、media、symlink-boundary、followup-message、command-git-boundary、command-input-revision、capabilities（含 `.output.txt`）。
- 真实运行记录（仓库外）：`/Users/macmini/workspace/graph-m7-acceptance-7/`；失败尝试审计：`graph-m7-acceptance` … `-6`。

## 8. 仍由使用者决定

1. 是否把交付文件合入 `/Users/macmini/workspace/12-MediaBookmarks` 原仓库（当前未改动原仓库、未发布）。
2. 是否配置费率以获得费用估算；是否配置 remote、发布首版。
3. 其他平台接入、官方 Pi 扩展 API 全量语义、远程 MCP 其他 transport 与 Linux/Windows 执行边界仍未验证。

## 附录：提交列表（`f1ddaaa` → `60fb185`）

| 提交 | 说明 |
| --- | --- |
| `31ce71a` | fix: close acceptance R1-R3 and prepare R4 real-model run |
| `9529605` | docs: record follow-up rework revision |
| `81016a1` | fix: close fourth-round acceptance findings |
| `abf357c` | docs: record fourth-round rework revision |
| `8e3cd9f` | feat: load bound extensions in a restricted worker and add remote MCP and retrieval |
| `73ef261` | docs: record fifth-round capability revision |
| `81dc0cf` | fix: harden the real acceptance run for reasoning models |
| `5650f2c` | docs: record sixth-round pre-run revision |
| `fe04a78` | fix: show agents the task graph and check commands in the briefing |
| `a2fd199` | fix: retry provider transport failures inside one gated invocation |
| `77cdb74` | fix: steer workers to write files early instead of over-exploring |
| `97d6224` | fix: describe run_command argument shape for workers |
| `6be3c66` | fix: tell verifier report nodes the review report schema |
| `60fb185` | docs: record the completed real A13 run and first-version result |
