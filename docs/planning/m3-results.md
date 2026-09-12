# M3 Pi、主管与可复用人才库

日期：2026-09-11。对应 [实施计划 G09–G11](../implementation-plan.md#m3-pi主管与可复用人才库)。基于 M2 的提交 `5766bb5`。本轮把 M0 已验证的 Pi 调用门接到 Task Runtime，并加入模型目录、Agent 定义库、受限能力安装和确认前的主管规划。

## 可运行结果

```sh
pnpm test:m3
pnpm check
```

最终复验中 `pnpm check` 通过。Pi 请求打到临时本地 chat-completions 服务；能力安装使用真实 macOS sandbox。生产 adapter 注入工作区工具与主管提案工具，并按定义版本加载绑定能力（Skill、本地 stdio MCP 与构建测试入口，见 [ADR 0008](../adr/0008-definition-bound-capability-loading.md)），逐请求检查额度与未知用量，见 `tests/m3/production.test.ts`。不读取项目 `.env`，不调用收费模型。

## 入口

- `openTaskRuntime({ models, master, ... })`：可选模型目录与讨论期主管。未配置时 M1/M2 scripted adapter 行为不变。
- `runtime.catalog.publishDefinition/install/definitions`：不可变定义版本；安装写入能力库快照，不写入 `task_grants`。
- Agent 节点若没有同名 scripted adapter，走生产 Pi adapter。每次实际 HTTP 记为 `invocations` 行，归属实例与 operation。
- 讨论期 `master` 在 `begin` 时创建主管实例并占用 `active_task`；`runReady` 可在确认前派发。确认后若提案含同一 `master` 节点则复用实例。请求的模型不可用时从同级候选替换，并记录 `model.switched`。

## G09

| 出口 | 证据 |
| --- | --- |
| 请求归属实例和 invocation | `tests/m3/models.test.ts` 一次 Pi prompt 一条 invocation，用量 50 |
| 模型切换保留身份 | 请求不存在的模型时从同级候选替换，`instanceId` 不变 |
| 审查排除本轮实现模型 | reviewer 定义 `review: true` 时不选用 implementer 的模型；排除集穿过程序节点，见 `tests/m4/acceptance.test.ts` |
| 无合格候选进入问题 | 仅剩被排除模型时打开 `model_unavailable` |
| 未知价格不记零 | 无 `cost` 的模型在 view 中为 `{ unknown: true }` |
| 会话恢复 | 关闭重开后同一 `instanceId` 继续，检查节点仍收到 briefing |

任务说明包写入 `operation.context.briefing`（请求、验收、产物路径）。供应商 key 只从运行配置注入。

## G10

| 出口 | 证据 |
| --- | --- |
| 同定义不同模型可生成实例 | 两个 worker 均为 `coder@1`，模型分别为 `one`/`two`，实例不同 |
| 定义升级不改变运行实例 | 发布 `coder@2` 后运行中节点仍绑定 `@1` |
| 受限安装 | `catalog.install` 经 sandbox 复制技能目录；任务问题列表不加权限 |
| 安装不扩张权限 | 安装后 `view().questions` 为空，无新 grant；MCP 调用在 OS 沙箱内被拒绝越权写入 |
| 定义绑定能力真实可调用 | `tests/m3/capabilities.test.ts`：Skill 进入系统提示且正文可读；本地 MCP、受限 worker 扩展与远程 MCP（运行时域名白名单）的工具真实可调用且写入范围受限；每次 exchange 记一条零用量 invocation，暂停时进程不启动；`tests/m3/retrieval.test.ts`：受控读取 broker 只访问授予域名，拒绝非文本与重定向，暂停时不发请求 |
| 构建测试入口 | `tests/m3/workspace-command.test.ts`：`run_command` 允许 `node`/只读 `git`（以具体 CLT 二进制运行），拒绝白名单外命令与内联求值；写授权内已存在的 `.git` 条目在相对、嵌套、绝对与硬链接路径下均被拒绝；`tests/m4/command-check.test.ts`：`graph.command` 程序节点在集成提交上运行检查并产生验收证据，且修订不能改写验收检查的 input |

中断的安装保留 `installations` 记录，`reconcileInstall` 可再执行。主管通过发布引用新能力的定义版本来复用，不能靠安装改写任务授权。能力加载与权限边界的决定见 [ADR 0008](../adr/0008-definition-bound-capability-loading.md)。

## G11

| 出口 | 证据 |
| --- | --- |
| 主管拆解并提案 | 讨论期 master 读取用户请求后 `propose`；非法 checkNode 被拒绝 |
| 工人不需复制上下文 | worker 的 briefing 含验收说明和原请求 |
| 新增功能排队 | 原任务运行中确认第二项后其为 `queued`；原范围完成后才轮到它 |

## 持久化

schema 8：`definitions`、`capabilities`、`installations`、`invocations`、`models`，以及实例上的 `definition_version` / `model` / `models_used`。

## 本轮边界

未对使用者配置的真实供应商做收费契约请求；其他 transport 仍须沿用 M0 规则复验。Pi 会话目前在宿主进程内打开，模型 HTTP 仍过调用门。Skill、本地 stdio MCP、受限 worker 扩展与远程 MCP（运行时域名白名单）均按定义版本加载并真实可调用；网络资料检索由受控读取 broker 提供，只放行授予域名、拒绝重定向与二进制、限制大小，并过暂停与额度门。扩展 worker 只实现本仓库定义的最小 `register(api)` 工具协议，官方 Pi 扩展 API 的完整语义与其他平台仍未验证。Git 工作副本与自动合并见 [M4 报告](m4-results.md)；Web 是 M5。第三位 Agent 的复验与后续修复见 [验收跟进](acceptance-followup.md)。
