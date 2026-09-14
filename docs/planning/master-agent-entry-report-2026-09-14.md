# 以主 Agent 为入口：实施与验收报告

日期：2026-09-14（返工轮更新）。状态：**首轮独立验收不通过；ME-S01 与 ME-R01–R06 已修复，等待独立复验；本文不宣布整体通过。** 返工记录见 [返工报告](master-agent-entry-rework-report-2026-09-14.md)。 方案见 [主 Agent 入口改造草案](master-agent-entry-plan-2026-09-14.md)，差距核对见 [代码差距核对](master-agent-entry-gap-2026-09-14.md)，架构决策见 [ADR 0009](../adr/0009-conversation-first-master-entry.md)。

## 基线、分支与提交

- 基线：`main@688dd1f`（T01–T08 与 PA01–PA05 返工均已独立验收关闭）。
- 隔离工作树：`/Users/macmini/workspace/graph-master-entry-dev`，分支 `feat/master-agent-entry`。**未合并、未覆盖 `main` 与 `feat/app-console`**；实现期间未在共享工作区 `/Users/macmini/workspace/13-Graph` 或 `feat/app-console` 上提交。
- 提交（按逻辑分批）：

| 提交 | 内容 |
| --- | --- |
| `68795c2` | 差距核对文档与 ADR 0009 |
| `1a1a974` | 会话与消息账本、schema v11、排队/恢复、确认创建功能任务、10 项内核测试 |
| `a66459f` | 生产 Pi 主管：讨论只读工具、对话提示、流式文字与工具活动、受控 provider 协议测试、会话 REST/SSE |
| `f12746d` | 会话优先 Web 入口、问题答复组件复用、SSE 关闭修复、Playwright 真实浏览器全流程与截图 |
| `876892a` | 使用文档、报告与验收证据归档 |
| `361c66f` | 仅查看模式会话在模型可用后恢复主管的回归测试 |

- 依赖与范围：不新增运行时依赖；沿用 main 的 Node 24.20.0、Pi SDK、`node:sqlite`、Fastify、React/Vite、Playwright 与 `@anthropic-ai/sandbox-runtime` 受限执行边界。变更 28 个文件、+2019/−187 行。

## 已实现内容

### 1. 会话内核（复用执行内核与账本）

- 新增 `conversations`（可空项目、宿主工作区项目、anchor 任务）与 `messages`（稳定 ID、角色、状态、操作绑定、时间）表（schema v11），以及 `conversation_acceptances` 确认溯源。
- 每个会话有一个 `phase='chatting'` 的 **anchor 任务**：主管每一轮都是正常的 `operations` 执行，沿用实例预算、`invocations` 用量、`taskGate` 的暂停/未知用量/预算检查、代次与 activation 隔离、崩溃核查。
- 未绑定项目时使用仅属该会话的宿主工作目录（`grants=[]`），绑定后主管工作目录迁移到真实项目；`openPiInstance` 仅在会话内允许这种迁移，不放松普通实例的身份校验。
- 交互通道独立于单一 `active_task`：`drive()` 先调度所有 chatting 会话的主管节点，再调度活动任务的图节点；两者共用全局 Agent 名额与凭据并发。

### 2. 消息与正式变更分离、排队与恢复

- `POST /api/conversations/:id/messages` 只追加消息、不改变需求版本；重复 `requestId` 幂等，不重复触发模型。
- 消息在操作创建事务内被消费并绑定 `operation_id`；派发前失败（`not_sent`，如适配器准备失败、暂停）回到 `pending` 重试；已派发但结果不明保持绑定，走既有未知用量/恢复问题路径，不重复发送。
- 主管运行期间到达的消息保持 `pending`，本轮结束后自动开启下一轮；`settle` 只在无待处理消息时把节点置为 `succeeded`。
- 进程重启后 anchor 的未处理消息与未完成操作按同一规则恢复；`view-only`（无模型）创建的会话在模型可用重启后自动补建主管节点。

### 3. 草稿到执行的确认边界

- 主管 `propose_graph` 仍只生成版本化草稿；`confirm` 校验会话已绑定项目、草稿为当前最新且与当前需求版本一致、未被确认过，然后创建**独立功能任务**（复制提案为 v1、实例化节点、`git.prepareTask`、入队/激活），anchor 需求版本 +1 使旧草稿失效，并写确认溯源。
- 确认后 anchor 保持 `chatting`，主管继续可对话；执行摘要（任务阶段、节点状态、问题、证据、提交、用量）以记录投影进入主管每轮说明包。执行中新增功能只能形成新的草稿/任务，不能静默修改运行任务的验收范围。

### 4. 生产主管行为

- 讨论阶段（`chatting`/`discussing` 的主管）工具集为只读：保留 `read`/`list_dir`/`submit_result`/草稿与目录能力，移除 `write_file` 与 `run_command`；提示词区分“理解→调查→讨论→草稿→确认→解释”，并说明确认前不派发、确认后用记录回答进度、范围变化需显式新任务。
- assistant 文字以合并后的 `message.delta` 事件流式输出，工具活动以 `message.tool` 事件实时显示；轮次结束时内核写入正式 assistant 消息与工具摘要消息（同一 `operation_id` 幂等，未知用量与核对路径不会重复记录）。

### 5. Web 会话入口

- 首页首先是「与主 Agent 对话」：可直接输入模糊目标、项目可留空；列表显示未绑定项目/待处理问题/执行任务。
- 会话页包含完整消息流（用户/主管/工具/系统，含排队状态与流式“正在输入”）、项目绑定、策略草稿与确认、执行任务与节点状态、待处理问题答复、暂停/继续主 Agent。
- 原有任务页、任务图与设置保留；从会话可跳转到功能任务页。
- 修复真实缺陷：SSE 长连接不再阻止守护进程关闭（客户端断开结束服务端迭代 + 关闭时清理连接），重启/退出有界。

## 验收场景逐项核对

| 方案场景 | 状态 | 验证 |
| --- | --- | --- |
| 1 模糊需求：直接开聊、调查后有依据推进、不自行实现 | 已验证 | `conversation.test.ts` 首条测试（无项目、无功能任务、仅主管操作）；`conversation-pi.test.ts` 真实 Pi + 受控 provider 首轮 `list_dir` 调查；`conversation-ui.test.ts` 首页直接开聊、未绑定项目、无功能任务 |
| 2 约束协商：多轮后草稿保留约束并解释拆分 | 已验证（脚本化） | `conversation-ui.test.ts` 发送“先做最小可用版，预算有限，登录先不改”，草稿摘要保留该约束；草稿面板展示节点/模型/验收项 |
| 3 推翻草稿：旧草稿失效、确认只执行新草稿 | 已验证 | `conversation.test.ts` “drafts version…”（旧版本 `stale_proposal`、确认前无任务）；`conversation-ui.test.ts` 推翻后草稿 v2、确认 v2 才创建任务 |
| 4 确认后问问题：基于真实记录、不触发锁定/重复工人 | 已验证 | `conversation-pi.test.ts` 断言确认后说明包含 `Feature task`、任务 ID 前缀与 `work:pending`；`conversation-ui.test.ts` 确认后提问得到执行记录回复 |
| 5 运行中改变目标：解释影响并形成新任务，不静默改范围 | 已验证（内核） | `conversation.test.ts` “a scope change after confirmation becomes a new queued task…”：原任务保持 running 与原验收项，新任务 queued |
| 6 暂停与恢复：立即受理、消息排队、讨论可继续 | 已验证 | `conversation-ui.test.ts` 暂停 → 消息 pending → 关闭守护进程 → 同状态重启 → 继续后处理；内核 `chat` 在暂停时只排队 |
| 7 持久性与排队：连发/断线/重启不丢不重、显示状态 | 已验证 | `conversation.test.ts` 运行中连发三条合并为一轮、重启恢复只回答一次、幂等 requestId；`conversation-ui.test.ts` 连发两条与刷新恢复 |
| 8 完成只等用量/返工中核对：PA02 系列不退化 | 已验证 | 全量 50 文件 / 234 项含既有 PA02 全部用例；新增主管未知用量用例：答复可见、`unknown_usage` 走既有核对路径且不重复记录 |

## 工程验证（证据文件 `acceptance-evidence/master-agent-entry-verification.output.txt`）

- `tsc --noEmit` 与 `tsc -p tsconfig.web.json --noEmit` 均通过。
- `vite build` 成功。
- `vitest run` **两轮均为 50 文件 / 234 项通过**（含全部 m0–m8 既有机制测试、M7 交付测试、浏览器测试）。
- 8 个历史探针（监听/本地网络/IPC 返工轮）全部 rc=0。
- 未调用任何付费模型；真实链路用**本地受控 OpenAI SSE provider** 驱动生产 Pi adapter，浏览器流程用无头 Chromium 走真实 HTTP/SSE 与 Git 工作副本。
- 浏览器截图：`acceptance-evidence/master-agent-entry/01-vague-goal.png`（模糊需求开聊）、`02-first-draft.png`（绑定项目与首版草稿）、`03-confirmed.png`（确认并出现执行任务）、`04-reloaded.png`（刷新恢复）、`05-restart-resume.png`（暂停排队、守护进程重启后继续处理）。

## 启动方式

```sh
cd "$REPO"                 # 本分支工作树
node --run build:web       # 或 ./node_modules/.bin/vite build
node --run start:execute   # 执行模式；需要 graph.config.json 中至少一个模型与可解析凭据
# 打开输出的 http://127.0.0.1:4173 地址，在首页直接开始对话
```

仅查看模式（`node --run start`）也可以创建与查看对话，但不会派发模型；配置模型并重启后，排队消息会自动由主管处理。

## 独立验收复现步骤

```sh
cd /Users/macmini/workspace/graph-master-entry-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build
./node_modules/.bin/vitest run tests/m8/conversation.test.ts        # 内核：排队/恢复/确认/新任务/未知用量
./node_modules/.bin/vitest run tests/m8/conversation-pi.test.ts     # 真实 Pi + 受控 provider 协议
./node_modules/.bin/vitest run tests/m8/conversation-ui.test.ts     # 无头 Chromium 全流程（含重启）
./node_modules/.bin/vitest run                                      # 全量回归
```

也可手工用受控 provider 启动：把 `graph.config.json` 的模型 `baseUrl` 指向本地 OpenAI 兼容服务，运行 `node --run start:execute`，在浏览器从首页发起对话并按上表场景操作。

## 遗留限制与待独立核实

- 讨论只读已在能力层落实：绑定扩展与本地 MCP 在讨论期的受限执行只写宿主 scratch（见返工报告 ME-S01）；远程 MCP 无宿主文件系统权限且逐工具按任务 grant 校验。
- `chat` 不改变需求版本；旧的 `begin` + `say` 路径保持原语义（每次 `say` 递增版本），两条入口并存，未合并。
- 跨功能任务通过确认时的 `decision_digest` 把讨论决策/约束带入子 Agent 说明包；长会话自动摘要仍未实现（返工报告已列明）。
- 交互优先只是“主管先于图节点派发”，凭据队列仍为 FIFO；未做 per-request 优先级。
- 长会话未实现压缩/摘要（Pi compaction 关闭），消息页每次返回最新 200 条；超长会话的上下文增长策略留待后续。
- 未实现会话级整体运行时间上限与心跳看门狗，沿用已验收的逐调用门与未知用量暂停规则。
- 未做真实付费模型交互质量评估（理解、追问、解释）——按计划需另以一轮有界真实模型对话在实现审阅后单独进行；本报告只声明机制与用户流程，不声明模型对话质量。
- `feat/app-console` 有自己的界面与主 Agent 相关改动，本分支与其没有合并关系；两边需分别独立验收。
