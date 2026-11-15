# 0044 状态机以声明的注册表为唯一来源

## 背景

用 `go -C backend run ./cmd/graphcheck machines --verbose` 扫描 `backend/` 与 `app/`，第一版得到
24 台落库状态机、119 个状态、129 处状态字面量与 41 条能直接从源码读出的转移（数字随注册表演进，
以该命令的输出为准）。它们此前只以三种形式存在：

- 散落在 SQL 字面量里的字符串（`SET state='blocked'`、`state IN ('queued','claimed')`）；
- 部分迁移里的 `CHECK` 约束（只约束写入，不说明谁可以迁到谁）；
- 各消费点自己的 `switch`：界面把 `running/blocked/done…` 翻成颜色与中文、Agent 从视图里读到裸字符串。

同一个状态词在四处有不同的含义与文案：`blocked` 在 `node.status` 是可恢复的（会回到 `idle`），在
`fleet.agent_status` 却被当成终态；`done` 与 `completed` 在界面里各写一份映射；`completing`、
`verifying` 在界面里没有任何映射，于是直接显示英文原文。开发者要回答「这个状态能不能迁到那个状态」，
只能把相关文件全部读一遍；Agent 只能靠猜。

## 决策

状态机以**声明的注册表**为唯一来源：`backend/statemachine/machines.json`，由
`backend/statemachine` 包加载并对外提供。

一条记录包含：`id`、中文标题、落库位置（`table.column`，一台机器可以拥有多个目标，例如
`kernel_nodes.status` 与 `nodes.status` 共用一个词汇）、初始状态、每状态的 `label`/`tone`/`terminal`、
以及 `from → to` 的合法转移。`Allows`、`Label`、`ToneOf`、`MachineFor` 都从这里读，不再有第二份。

四个消费面共用这一个来源：

| 面 | 入口 | 得到什么 |
| --- | --- | --- |
| DX | `go -C backend run ./cmd/graphcheck machines` | 注册表自洽 + 源码没有未声明的状态、没有未声明的机器、没有非法转移 |
| DX/AX | `docs/agent/state-machines.md` | 由注册表生成的人读清单（`graphcheck machines` 之外还有 Atlas 用例防漂移） |
| AX | `GET /api/state-machines` | 机器可读的完整注册表，Agent 一次调用即知有哪些机器、每台有哪些状态、哪些转移合法 |
| UX | `app/status.go` + `app/state_machines_test.go` | 界面渲染的每台机器的每个状态都必须有文案与色调，缺一个就用例失败 |

门禁方向是单向的：**源码里出现的状态字面量必须都已声明**（否则报 `undeclared-state` /
`undeclared-machine`），**来源里每一条能读出起止的字面量转移都必须在注册表里合法**（否则报
`illegal-transition`）。注册表可以先声明尚未出现的状态，用于表达语义上的合法去处；但不能漏掉源码里已经
在用的状态。反方向（声明了却没在源码里出现）不算错误：`SET state=?` 这类参数化写入本来就没有字面量，
`--verbose` 会把逐条证据打出来，供人核对。

## 备选与放弃理由

- **运行时强制状态机（所有写入走 `Allows`，非法转移直接抛错）**：现有大量历史行与参数化写入
  （`SET state=?`，值由调用点传入）无法在不改行为的前提下判定；一次性上强制会把「未知」变成「故障」。
  门禁先在构建期挡住新增的非法状态与非法转移，运行时强制留给后续按机器逐个启用。
- **只写一份盘点文档**：会立刻漂移。今天写下的 129 处字面量，明天就有第 130 处。
- **只靠 `CHECK` 约束**：约束的是写入值域，不表达转移；`blocked → idle` 与 `blocked → completed`
  都能过约束，但只有一个在业务上成立。
- **把状态升级成 Go 类型（`type TaskPhase string`）再逐点替换**：对 `tasks.phase` 这一台已经在做
  （`core_graph_phase.go`），但把它推广到全部 24 台会在 SQL 字面量、JSON 视图与数据库之间造出三层转换，
  收益不如注册表直接。

## 后果

- 新增一个状态、或新增一条 `UPDATE … SET state='x'`，必须同时改注册表；否则 `graphcheck machines` 失败
  并指出文件。这是本决策最主要的日常成本，也是最主要的收益：字符串再也不会悄悄多出一个。
- 参数化写入对门禁不透明：`SET state=?` 只会被计为一次 `Params`，不产生事实。这类写入靠声明补齐，
  机器上「未观测到」的状态不算错误，只说明证据来自语义而不是字面量。
- 界面保留粗粒度桶（`workStatus`：运行/空闲/阻塞/失败/完成/已停止）而不是照搬 119 个状态：
  用户需要的是可比较的六个词，精确状态留给详情。两者的一致性由 `app/state_machines_test.go` 钉住，
  细粒度文案（例如 `completing` 收尾中）留在注册表里给 Agent 与 API 用。
- 不引入迁移：注册表不改数据库，`CHECK` 约束保持原样，历史行不受影响。
