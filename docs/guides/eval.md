# eval 指南

`grapheval` 是端到端流程的判定入口：它把每条业务流程当成一个 case，跑真实守护进程或真实服务，
断言外向行为（HTTP 响应、持久化行、产物、提交），最后给出一份机器可读的报告。
命令能判定它对不对——这是它存在的唯一理由。

## 怎么跑

```sh
go -C backend run ./cmd/grapheval                      # 全部 case，报告落盘
go -C backend run ./cmd/grapheval --json               # 同一批 case，JSON 打到 stdout，不落盘
go -C backend run ./cmd/grapheval --layer e2e          # 只跑端到端层
go -C backend run ./cmd/grapheval --group rsi          # 只跑一个分组
go -C backend run ./cmd/grapheval --case <名字>        # 只跑一条，调试用
```

退出码：`0` 全部通过（含 skip），`1` 至少一条失败，`2` 参数或环境错误。
所以它可以直接当门禁用：非零即红。

报告写到 `state/eval/report-<UTC 时间戳>.json`；`state/` 不入库，报告跟着本机状态走。
`--json` 与 `--no-save` 都不落盘，前者为了接管道，后者为了少留垃圾。

`GRAPH_EVAL_KEEP_ROOTS=1` 会在结束时保留临时根目录，红了的 case 可以进去看库和日志。

e2e case 跑之前会调用 `appinstall.BuildBackend(repository, true)`：`dist/graphd` 比源码旧就先重建。
这一点是必须的——否则门禁验的是上一次编译出来的二进制，源码改坏了它照样绿。

## 分层与分组

两层：

- `e2e`：起真实守护进程（`--execute` 或 `--view-only`），只通过 HTTP 面断言。慢，但证明的是整条链路。
- `integration`：进程内调用已导出的服务接口（如 `graph.NewRsiService`），断言持久化结果与真实副作用
  （git 提交、落盘文件）。比 e2e 快，用来把失败定位到一段代码。

分组按业务流程分，和分层正交：

| 分组 | 覆盖的产品契约 |
| --- | --- |
| `graph` | 图定义创建/校验/查看/拓扑/控制 |
| `thread` | 项目 thread 与全局 thread 的隔离与幂等 |
| `main` | main ↔ subagent 的派发与结果回传 |
| `rsi` | RSI 解析根 → 检查 → 提案 → 落盘 → 提交 |
| `sandbox` | 统一执行面的命令执行与授权边界 |

`--layer` 与 `--group` 可以叠加，`--case` 再收窄到一条。

## 怎么加一条 case

case 就是一个 `eval.Case`，放在 `backend/eval/cases_<分组>.go`，在 `AllCases` 里注册。

```go
{
    Name:     "graph-create-validate-inspect",
    Group:    "graph",
    Layer:    LayerE2E,
    Contract: "POST /api/graphs admits a schemaVersion 2 definition and GET graph/topology reports every node and enabled edge",
    Run: func(t *T) {
        fixture := StartFixture(t, FixtureOptions{Repository: repository})
        defer fixture.Close()
        var created createdGraph
        fixture.Post(t, "graph-create", "/api/graphs", body, &created)
        t.Equal("graph-create.revision", 1, created.Revision)
    },
},
```

三条规矩：

1. **先写断言，看它红一次。** 新 case 第一次跑必须因为产品行为不符而红，或者你亲手把它改坏验证它会红。
   一个从来不会红的 case 不是证据。
2. **断言外向行为。** HTTP 状态与响应体、`state/tasks.sqlite` 里的行、产物文件、git 提交。
   不断言私有变量、内部函数，也不复刻一份实现。
3. **只断言确定的事实。** 不写 `sleep` 等状态；要等就轮询产品事件最终会落定的值
   （`awaitSettled`）。不比耗时、不比重试次数、不比 `workerActive`。拿不准就问：
   这条断言在慢机或高负载下会不会翻转？会翻转就换等价断言，不要放进隔离名单。

失败时报告会点名是哪条断言、期望什么、实际是什么——所以断言名要写成"契约 + 断言内容"，
比如 `graph-topology.planned.from`，而不是 `assert1`。

## 框架本身

框架在 `backend/eval`，CLI 在 `backend/cmd/grapheval`。框架自身的契约由
`backend/eval/eval_test.go` 与 `backend/cmd/grapheval/main_test.go` 固定：
空 case 列表通过、失败 case 报出正确的断言、panic 变成失败且不中断整轮、
Setup 失败会跳过 Run、skip 不算失败且不带 error、过滤按层/组/名生效、JSON 结构稳定。
改框架先改这些测试。

报告结构（`schemaVersion: 1`）是稳定契约：

```
{ schemaVersion, total, passed, failed, skipped, startedAt, finishedAt, elapsedMs,
  cases: [ { name, group, layer, contract, status, elapsedMs,
             assertions: [ { name, ok, expected, actual } ],
             error?, errorDetail?, skipReason? } ] }
```

## 与门禁的关系

`python3 scripts/check-queue.py`（快层）不跑 `grapheval`：它要起守护进程、跑真实执行面，
比现有快层贵得多。e2e 放慢层 / nightly：

```sh
go -C backend run ./cmd/grapheval
```

`integration` 层便宜，可以随快层或提交前手动跑；`e2e` 层放 nightly 与改动跨模块时手动跑。
两者都用同一个入口、同一份报告格式，所以把哪一层接进哪一道门禁只是调用方式不同，
不需要第二套框架。

## 已知未覆盖

- `sandbox` 两条 case 已启用，钉的是开放模式的两条契约：所有 agent 走同一个执行面
  （`OpenWorkspaceCommandRunner`），且该执行面完全访问（工作区外的宿主文件可读、可写落地）。
  见 ADR 0045。真正需要隔离的容器后端（CubeSandbox）尚未接入，届时在这里补一条
  「切换后端后同一条 case 仍然通过」的契约。
- `graph` 组缺一条「失败节点 + 重试」的 happy path：需要可控的失败注入，现有夹具没有这个能力，
  强行造会变成测假实现。当前 graph 三条覆盖创建、校验、拓扑与控制，**执行与汇聚未覆盖**。

