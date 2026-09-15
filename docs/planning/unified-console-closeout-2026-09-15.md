# Unified Console 收口实施计划（C01–C05）

日期：2026-09-15。给实现 agent 的可分派任务说明，不是功能已完成的声明。

## 1. 基线与约束

- 工作树：`/Users/macmini/workspace/graph-unified-dev`
- 分支：`feat/unified-console`
- 开工基线（先 `git rev-parse HEAD` 核对，在最新提交上继续，不要 reset）：**`76d4e7e5e9dadfd9a7ec734aedb6cb621878badf`**
- 比较基线：`git diff 76d4e7e...HEAD`
- 不要改 `main`、不要发布、不要覆盖 `/Users/macmini/workspace/13-Graph` 的产品源码
- 独立验收报告与探针只由验收方写在 `13-Graph`；实现方证据写在本工作树 `docs/planning/`
- 沿用 TypeScript、Pi 0.85.1、SQLite、Fastify、React/Vite、Electron；不要另起编排框架
- 验证只用临时 Git、合成 key、本地 OpenAI/Anthropic 夹具。没有用户另行指定的测试凭据时，**不调用付费供应商**，报告写明未测
- 不要读取用户其他项目的凭据，不要改验收方上一轮原始证据
- 先写失败测试再改产品代码（TDD）。每包提交 + 验证报告，含准确 SHA、命令、真实退出码、原始输出
- 契约仍以 [ADR 0010](docs/adr/0010-unified-console-contracts.md)、[roadmap](docs/planning/unified-console-roadmap-2026-09-15.md)、[graph-mvp](docs/graph-mvp.md) 为准。新列走 `store.ts` 下一迁移号（当前 `user_version=18`）

**不要重做：** U00–U10 已交付且独立验收已关闭的缺陷（含 R08-R3 审查身份、Git 准入、热配置串行队列、能力 grant 投影、终态 timing）。本轮只补独立验收仍开着的计划缺口。

先读：`AGENTS.md`、`CONTEXT.md`、`docs/architecture.md`、`docs/graph-mvp.md`、ADR 0007/0010、本文件、[第四轮独立验收](/Users/macmini/workspace/13-Graph/docs/planning/unified-console-rework4-acceptance-2026-09-15.md)。

## 2. 已经有什么、还缺什么

| 缺口 | 已有 | 本轮要交 |
| --- | --- | --- |
| 默认价格 | `ModelPricing`、调用时冻结、刷新配置不改历史、未知不折零、手动覆盖 | 带 **日期+来源** 的内置快照；刷新失败标 `stale`、保留旧值；向导能显示参考价 |
| 暂停/等待用户时间 | 运行/凭据等待已按边界记账；`pauseMs`/`userWaitMs` **恒 null** | 在暂停与开问题边界写账；历史无事实仍显示「未记录」 |
| 旧 schema 升级 | `store.ts` 迁到 v18；仅有 v13→v14 unlimited 单测 | 用真实旧库副本跑完整链路，禁止删库代替迁移 |
| 成品 Electron | 打包脚本、safeStorage、daemon 热生效、Chromium 向导 | **打包后的 Graph.app**：钥匙串桥、保存即热生效、对话→Git→确认→节点详情→人才经历 |
| 真实供应商/对话质量/长摘要 | 明确未测 | **保持未测**，报告写清；不要用脚本冒充 |

U11 报告文件尚不存在。本轮最后一包才写。

## 3. 工作包与顺序

```text
C01 价格快照 ──┐
C02 时间分段 ──┼── C04 打包 Electron 贯通 ── C05 U11 交接
C03 旧库升级 ──┘
```

C01/C02/C03 可并行（C02 独占 schema v19）。C04 依赖 C01（向导参考价）和「无重启」文案修复。C05 依赖 C01–C04。

| 包 | 优先级 | 前置 |
| --- | --- | --- |
| C01 默认价格快照与刷新 | P0 | 无 |
| C02 暂停/等待用户写账 | P0 | 无（schema v19） |
| C03 旧 schema 全链路升级 | P0 | 无；C02 合并后复跑 |
| C04 打包 Electron 贯通 | P0 | C01；建议 C02 已合 |
| C05 U11 交接与诚实未测清单 | P0 | C01–C04 |

## 4. C01 — 默认价格快照与刷新

**入口：** `src/catalog/providers.ts`、`src/catalog/models.ts`、`src/server/config.ts`、`src/server/app.ts`、`src/web/Settings.tsx`、`src/web/Setup.tsx`、`tests/console/pricing.test.ts`

**做：**

1. 新增一份内置快照（独立模块或 JSON，不要把未核实数字散进模板）。每条必须有：`cost` 四项、`currency`、`unit:'per_million_tokens'`、`sourceUrl`、`retrievedAt`（ISO 日期）、`catalogRevision`、`status:'known'`。
2. 来源必须是实施当天能打开的官方页（OpenAI / Anthropic / 模板里已引用的 docs）。核对失败的模型 **不要填 0**，保持 unknown。
3. `PROVIDER_TEMPLATES` 只在快照命中时带 `cost`/`pricing`。Setup 显示参考价或「价格未知」。
4. 刷新：设置页显式按钮（不要保存时偷拉）。成功写入新快照并 `catalogRevision`；失败保留旧值、`status:'stale'`、界面说明过期。手动覆盖补 `retrievedAt`/`catalogRevision`（现在只有 `sourceUrl:'manual'`）。
5. 新 invocation 用刷新后的价；旧 invocation 的 cost JSON 字节不变（已有 `pricing.test.ts` 必须继续绿）。

**验收：**

- 至少一条模板模型向导可见非 unknown 参考价，且能指出日期和来源。
- 无来源模型仍 unknown，测试断言没有被填 0。
- 刷新失败 → stale + 旧金额仍在；刷新成功 → 下一调用新 `priceRevision`，上一调用不变。
- 手算对照：百万 token 单价 × 用量。
- 不调用真实计费 API 拉价也可以：允许用**已归档的官方页面摘录**写入仓库快照，但必须可核对 URL+日期。不要发明数字。

## 5. C02 — 暂停 / 等待用户时间分段

**入口：** `src/core/store.ts`（v19）、`src/core/task-runtime.ts` `setPaused`、`src/core/execution.ts` 开/关问题、`src/core/node-run.ts`、`src/web/NodeDetail.tsx`、`tests/console/node-run.test.ts`

照抄凭据等待的模式（`waiting_since` / `waiting_ms`），不要用消息时间相减。

**schema v19（建议，可等价）：**

- `operations.pause_ms` / `pause_since`（NULL = 历史未知）
- `operations.user_wait_ms` / `user_wait_since`
- 或节点级累计 + open-since。不要两套账。
- 旧行保持 NULL → 投影仍「未记录」。新运行从边界写入，空分段可以是 0。

**边界：**

- 暂停：`tasks.paused` 变为 1 时，该任务进行中/待派发节点开始 pause 钟；resume 时累加并清空 since。HTTP 在途调用不算暂停（已发出的继续，与现暂停语义一致）。
- 等待用户：打开需人答的问题（`human_check`、`permission`、`budget`、`model_unavailable`、`unknown_usage` 等）时开始 user-wait 钟；问题解决时累加。
- 凭据排队继续只进 `waitingMs`，不进 pause/userWait。
- 可控时钟或注入时间戳测试：暂停 1000ms → `pauseMs≈1000`；开问题 500ms → `userWaitMs≈500`；两者同时发生不重复计入 `runMs`。
- UI：有账本则分列暂停与等待用户；仍 NULL 则「未记录」。

**验收：** 新运行不再恒 null；旧库升级后无这些列的历史节点仍「未记录」。人才均值若纳入新分段，分母规则与 ADR 0010 §5 一致。

## 6. C03 — 旧 schema 全链路升级

**入口：** `src/core/store.ts`、新测试 `tests/console/schema-upgrade.test.ts`（名可变）

**做：**

1. 从 git 历史或手工按当时 DDL 构造 **v13**（unlimited 之前）和 **v17**（无 `node_capabilities`）的 `tasks.sqlite` 夹具，带一条真实任务/实例/invocation 行。不要用当前代码建库再改 `user_version` 充数。
2. 用当前 runtime 打开该 `stateDir`：迁到 18（C02 后到 19），旧 `budget`/`used` 不变，`unlimited=0`。
3. 在升级后的库上跑：打开任务视图 → 热保存配置 → 准备 Git 项目 → 一次脚本/夹具对话或工人操作。全程同一文件，禁止删库。
4. 配置文件保持 `version: 1`。若必须迁配置，单独写升级函数并测，不要静默丢字段。

**验收：** 夹具库打开不抛 `schema_version`；迁移后全量测试仍绿；报告列出源版本、目标版本、未改写的预算字段。

## 7. C04 — 打包 Electron 贯通

这是本轮用户可感知的主路径。Chromium + env key **不能**代替本包。

**入口：** `scripts/package-app.mjs`、`desktop/main.mjs`、`desktop/preload.cjs`、`desktop/lib.ts`、`src/web/Setup.tsx`、`Settings.tsx`、`App.tsx`、`tests/app/`

**先修会让「热生效」说假话的现码：**

1. `Settings.tsx` 副标题仍写「保存后需重启守护进程生效」→ 改为与 Setup 一致的「保存并应用」。
2. `App.tsx` 桌面横幅「保存到钥匙串，然后重启」→ 保存后应热启用，失败才给下一步。
3. `graph:save-secret` 拒绝非 string，Settings「禁用连接」传 `null` 到不了 daemon。IPC 必须能表达撤销（与 HTTP `value: null` 同语义），并断言 `applied` 而不只是 `stored`。

**打包实测：**

1. `node --run app:build` 产出 `dist/app/mac/Graph.app`（或当前 electron-builder 实际路径），`presets/` 在包内。
2. 用独立 `userData` 启动该 `.app`（不要用开发者日常 Graph 数据）。
3. 无终端、无手写 JSON、无 env key，走 UI：
   - 选平台填 key（经 `safeStorage` + `POST /api/app/secret`）
   - 同一 PID 内开始对话（保存后不 relaunch）
   - 选非 Git 目录，宿主初始化并建立基线
   - 讨论 / 确认草稿
   - 打开 review（或工人）节点详情，看到真实会话或程序输出
   - 打开人才详情/经历
   - 改一处配置（例如并发或第二连接）后继续跑，daemon 不重启
4. 供应商用本地夹具或用户指定测试 key。默认用夹具：可在测试构建把向导指向 `127.0.0.1` 夹具，但凭据仍必须走 Electron 桥，不能改回 env。
5. 钥匙串系统对话框若挡住无头测试：自动化证明 IPC→daemon `applied:true` 且进程未 relaunch；真机钥匙串写盘列为人工一步（`wizard` 技能），不要加生产后门跳过加密。

**验收证据：** 打包日志、APP 路径、启动 userData、窗口截图、daemon PID 在保存前后相同、`secrets.json` 无明文 key、热保存 `applied:true` / `restartRequired:false`。历史 A4（保存并重启、当时未打 presets）不能当本轮证据。

## 8. C05 — U11 交接

**做：**

1. 在交付 SHA 上：双 tsc、`vite build`、全量 vitest、`git diff --check`，记录 Node 24.20.0 / Pi 0.85.1 与真实 rc。
2. 写 `docs/planning/unified-console-u11-report-2026-09-15.md`：C01–C04 的 SHA、完成/未完成、复现命令、原始输出路径。
3. 用夹具跑一条「讨论→确认→工人→检查→独立审查」并核对节点会话、Git 副本、人才经历、费用快照一致（未知用量/暂停/重启至少各一次，能并进 C02/C04 则不重复造数据）。
4. **诚实未测清单（不得标官方已验证）：** 真实付费供应商冒烟、主 Agent 对话质量、长会话摘要、OAuth/多云身份。
5. 不合并 main、不发布。是否通过由独立验收决定。

## 9. 明确不做

- 长会话自动摘要/压缩
- 真实模型质量评估（除非用户另给测试凭据和范围）
- OAuth、Azure/Bedrock/Vertex、RPM/TPM
- OpenAI Responses-only transport
- 把 Chromium 向导或「复制 src 后起 daemon」写成 Electron 已验收
- 为让探针变绿改验收方旧断言而不修产品

## 10. 实现方交付格式

每个 C0x 一次或数次 conventional commit（`feat:` / `fix:` / `test:`），英文说明。每包一份报告，放到：

`docs/planning/unified-console-closeout-<id>-report-2026-09-15.md`

证据放到 `docs/planning/acceptance-evidence/unified-console-closeout/`。

结束时给验收方：最终 SHA、`git log 76d4e7e..HEAD --oneline`、全量测试输出、C04 的 APP 路径与 PID 证据、未测清单。

## 11. 独立验收将怎么判

验收方在 `13-Graph` 对准确 SHA 独立复跑，不采信实现方自己的次数。C04 必须看到**打包 APP** 与 **Electron 凭据通道**；C02 必须看到暂停/等待用户非 null 且历史仍可「未记录」；C01 必须看到快照日期/来源且刷新失败不改历史。缺任一项则 U00–U11 仍不整体关闭。
