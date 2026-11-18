# CI 分层、分片与坏测试

检查分三层跑：本地 Hook、快层门禁、慢层全量确认。这份文档说明每层跑什么、分片怎么切、
diff 怎么选测试，以及哪些测试被判为"坏测试"、怎么处置。

门禁的操作步骤见 [检查操作指南](checks.md)；测试编写规则见
[工程规范：测试编写规则](../../CODING_STANDARDS.md#测试编写规则)。

## 分层

仓库的检查分三层，按"多久能给出结论"排序。廉价的失败在本地与最快的 job 里暴露，重活只在
必要时才跑——一条命令能判定的问题不要留给下一层。

| 层 | 入口 | 何时跑 | 时间预算 |
| --- | --- | --- | --- |
| 本地 Hook | `.githooks/pre-commit`（暂存区文件体量 + 表归属）、`.githooks/pre-push`（完整门禁） | 每次提交 / 推送 | 秒级 |
| 快层 | `python3 scripts/check-queue.py`；CI 的 `ci.yml` | 每次激活 / 每次提交 | 2 分钟内 |
| 慢层 | `go -C backend run ./cmd/graphcheck all`；CI 的 `nightly.yml` | 重载确认后自动；每天 18:30 UTC | 无预算 |

快层用 `go test -short` 跳过被移到慢层的重活（清单见下一节），慢层不加 `-short`，把同一批步骤
完整再走一遍。跳过任何用例都必须在两处同时登记：`testing.Short()` 的守卫与本文的清单。

### GitHub Actions 的五个 job

`.github/workflows/ci.yml` 里各 job 之间只有一道 `changes` 判据，其余互相独立、并行跑：

| job | 机器 | 干什么 | 预期耗时 |
| --- | --- | --- | --- |
| `changes` | ubuntu | 用 `git diff` 判断这次提交有没有动代码；只改 `*.md` 或 `.github/` 时后面三个 job 跳过 | 5–10s |
| `lint` | ubuntu | 本次改动的 Go 文件的 `gofmt`、两个 module 的 `go vet`、`graphcheck comments/ownership/api/machines/evidence` | 2–3 分钟 |
| `build` (linux) | ubuntu | `go build ./...` 两个 module | 1–2 分钟 |
| `build` (darwin-app) | macos | 同上 + `graphbuild app` 打 MyGo bundle，产物上传 | 4–6 分钟 |
| `test` (module × shard) | ubuntu | 4 分片 × 2 module 共 8 台，只跑 diff 触发的包，见下文 | 2–3 分钟 |
| `ci-required` | ubuntu | 汇总所有 job 的结论，`if: always()`；分支保护只要求它 | 5s |

几条不能改的约定：

- **静态门禁全在 ubuntu**：免费账号的 macOS runner 并发上限 5 台且所有 workflow 共用，
  而 `gofmt`、`go vet`、`graphcheck` 都是纯 CPU 的 Go 程序，不挑系统。只有 MyGo 的
  `darwin-arm64` bundle 必须留在 macOS，且全仓只在一个 job 里打一次，产物上传后别的 job 复用。
- **不用 `paths-ignore`，用 `changes` 判据**：被路径过滤跳过的 workflow 会让必需的 check
  永远停在 Pending，PR 合不进去。所以过滤放在 job 级，`ci-required` 把 `skipped` 当通过。
- **`concurrency` 只对 PR 取消旧运行**：`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`。
  main 上每个提交都要完整跑过一遍，不能被后一个提交取消。
- **缓存只用 `actions/setup-go` 的 `cache: true`**：它按 `cache-dependency-path`（两个 `go.sum`）
  派生 key，同时恢复 module 与 build 缓存。再套一层 `actions/cache` 只会多一层 key 抖动，
  还容易把不该进缓存的产物塞进 10 GB 配额。
- **门禁工具先编译再执行**：`go -C backend build -o "$RUNNER_TEMP/bin/graphcheck" ./cmd/graphcheck`
  之后直接调用二进制。`go run ./cmd/...` 每次都要走一遍构建判定，实测 10 次 `comments`
  用 `go run` 1.06s、用预编译二进制 0.39s；冷缓存下 5 个子命令 8.88s 对 7.44s。

### 分片：`scripts/ci-shard.py`

Go 没有内建的 `-shard`，所以分片由脚本算出测试名集合，再交给 `go test -run`：

```sh
python3 scripts/ci-shard.py --module backend --shard 0/4          # 输出可用的 -run 正则
python3 scripts/ci-shard.py --module backend --shard 0/4 --format names     # 逐行测试名
python3 scripts/ci-shard.py --module backend --shard 0/4 --format json      # 含录制耗时合计
python3 scripts/ci-shard.py --module backend --shard 0/4 --format packages  # 该片涉及的包
python3 scripts/ci-shard.py --module backend --list-tests          # 全部测试名
python3 scripts/ci-shard.py --module backend --affected origin/main # 改动触发的包
python3 scripts/ci-shard.py --module backend --record /tmp/backend.json     # 从 go test -json 录制耗时
go -C backend test -json -count=1 ./... | python3 scripts/ci-shard.py --module backend --record -
```

两条分片策略，**默认用耗时均衡，没有耗时数据时才回落到哈希**：

- **耗时均衡（LPT）**：`scripts/ci-test-times.json` 存在且覆盖该 module 时，按录制耗时把最长的
  测试先放进当前最空的片。分片不等于并行——按名字切会让一片独占全部慢用例。当前实测：
  backend 4 片各 4.5–4.9s 录制耗时、98–104 个测试；app 4 片各 2.6–2.7s、119–126 个测试。
- **sha256 哈希**：`int.from_bytes(sha256(name)[:8]) % N`，与机器、时间、文件顺序都无关，
  同一 commit 上跑两遍逐字节相同。没有耗时文件时用它，保证分片可复现。

耗时文件只记 ≥0.03s 的测试（`RECORD_MIN_SECONDS`），其余用已知耗时的中位数兜底。这不是偷懒：
逐条记录 898 个测试会把文件撑到 58 KB ≈ 14,546 令牌，超过仓库 5,000 令牌的单文件预算，
`graphcheck tokens` 会拒绝提交。录制时只清理**这次真的跑过的包**里已经不存在的测试——
某个包编译不过时它不会出现在 `go test -json` 流里，把它的记录一起删掉等于把好数据当成过期数据。

### diff 触发：只跑改动触发的包

PR 上 `scripts/ci-shard.py --affected <base>` 把改动文件映射成包，再沿 import 反向闭包放大：

```
backend/internal/graph/core_execution.go
  → github.com/chenx0414/graph/backend/internal/graph        （直接命中）
  → github.com/chenx0414/graph/backend/internal/harness      （import 它）
  → github.com/chenx0414/graph/backend/daemon → graph/app    （跨 module 继续放大）
```

规则：改 `*.go` 映射到所在目录的包；改 `go.mod` / `go.sum` 映射到整个 module；文档、配置、
CI 文件映射到空集（不触发任何测试）。main 上不用这个，跑 `./...` 全量。
映射逻辑由 `scripts/test_ci_tools.py` 的 `AffectedContract` 钉住——**选择逻辑必须确定、可测**，
否则"没跑到的测试"会被误读成"通过的测试"。算不出改动范围时（比如浅克隆里没有 base）脚本退回
"整个 module 全跑"：漏跑会被误读成通过，多跑只是慢。

### 契约测试

三份测试文件钉住上面所有承诺，用固定样本断言，不依赖真的跑一遍 CI：

```sh
python3 -m unittest scripts.test_ci_tools      # 分片 / diff / 录制 / 三段拆解
python3 -m unittest scripts.test_ci_workflow   # workflow 结构与脚本卫生
python3 -m pytest scripts/test_ci_tools.py     # 等价写法
```

`test_ci_tools.py` 会把 `test_ci_workflow.py` 一起导入，所以一条命令跑完全部 37 条契约。
`ci_test_support.py` 是两者共用的样本与助手（`GO_TEST_JSON_SAMPLE`、`GH_RUN_JOBS_SAMPLE`）。
PyYAML 缺失时 workflow 那组自动跳过，不假装通过。

### CI 观测：`scripts/ci-profile.py`

第一次 CI 运行之后，用它把每个 job 拆成四段，看时间到底花在哪：

```sh
gh run view <run-id> --json jobs > /tmp/jobs.json
python3 scripts/ci-profile.py /tmp/jobs.json
```

`queue`（排队等机器）、`prepare`（checkout + setup-go + 缓存恢复）、`run`（真正干活）、
`tail`（收尾）。分段规则由 `scripts/test_ci_tools.py` 的 `ProfileContract` 用固定样本钉住，
所以脚本本身现在就能跑：

```
job   queue  prepare  run  tail  total  conclusion
lint  25s    40s      55s  25s   145s   running
```

**本仓库还没有远端运行记录，真实数字待首次 CI run 后回填**——第一次运行之后照上面的命令
存一份 `jobs.json`，把四段填进下面的对比表。

### 优化前后对比

本地能测的数字已经填上；标「待回填」的是只有 GitHub 上才有的。

| 阶段 | 基线（本地实测） | 目标 |
| --- | --- | --- |
| 整条快层 `check-queue.py`（改前，基线） | 50.1s | — |
| 整条快层 `check-queue.py`（改后，在干净 HEAD 检出上复跑） | 25.3s，退出码 0 | < 2 分钟 |
| 快层里的五步（build + vet + test ×2） | 37.7s | — |
| 同上，`go test -short` 之后 | 25.9s | — |
| 后端 `internal/graph` 单包 | 18.4s → 11.2s（三次重复 11.0–11.2s） | 稳定 |
| `go build ./...`（backend，冷） | 2.69s | — |
| `go build ./...`（backend，热） | 1.06–1.25s | 第二次 < 2s（自检项） |
| `graphcheck` 10 次 `comments`：`go run` / 预编译 | 1.06s / 0.39s | 用预编译二进制 |
| 5 个子命令冷缓存：`go run` / 预编译 | 8.88s / 7.44s | 用预编译二进制 |
| `go test -list` 全 module | 1.2–1.8s | — |
| 分片后单片测试数（backend / app，4 片） | 98–104 / 119–126 | 每片耗时差 < 20% |
| 分片后单片录制耗时（backend / app，4 片） | 4.5–4.9s / 2.6–2.7s | 同上 |
| `build` (darwin-app) 本地打包 | 12.0s | — |
| GitHub 上各 job 的 queue/prepare/run | 待回填 | 见上表预期耗时 |

**本地两次构建自检**：连着跑两次 `go -C backend build ./...`，第二次应该几乎不花时间。
实测 2.69s → 1.06s。如果第二次仍然慢，说明构建有额外浪费（比如脚本盯着一个不存在的文件、
或者每次都在重新生成产物），要先查清楚再加缓存——缓存只是把浪费藏起来。

## 坏测试清单

规则来自 [AGENTS.md](../../AGENTS.md#测试只许断言确定的事实)：**一个测试能不能过，只能取决于
产品的行为，不能取决于墙钟或机器负载**。下面三类是这条规则的具体判据，以及本仓库当前的处置。

### 判据

| 类别 | 形态 | 为什么坏 | 怎么改 |
| --- | --- | --- | --- |
| 墙钟负断言 | `time.Sleep(X)` 之后断言"没有发生" | 机器慢时"还没发生"，机器快时"已经发生"，同一份代码两种结论 | 轮询产品状态到落定值（`state.historyLoading`、`state.noMoreHistory`），或直接调产品入口再断言 |
| 墙钟正断言 | `time.After(X)` 等一个事件 | 只是超时上限，可接受；但把它当"等得够久所以发生了"就是坏 | 只用作超时兜底，断言放在 `select` 的 case 里 |
| 真实端口 / 真实进程 | `net.Listen(":0")`、`exec.Command("sh", ...)`、`ps` | 依赖机器上有 sh/ps、端口不被占 | 优先 `httptest`；确实要真进程的留在慢层 |

### 盘点结果（盘点时 40 处 `time.Sleep`、17 处 `time.After`，并发改动会让数字微动）

| 位置 | 形态 | 处置 |
| --- | --- | --- |
| `app/history_test.go` `TestReachingTheTopFetchesOlderHistory` | `Sleep(20ms)` 后断言"没有第二次请求" | **已修**：改成断言 `!state.historyLoading && state.noMoreHistory` |
| `app/history_test.go` `TestLoadingOlderHistoryKeepsTheReaderInPlace` | `Sleep(50ms)` 后断言"没有再次拉取" | **已修**：改成调 `state.ensureHistory()` 再断言请求数不变（产品自己会拒绝重复拉取） |
| `backend/internal/graph/runtime_rsi_async_full_queue_test.go` `TestAsyncFullDoesNotStartASecondRunWhileOneIsRunning` | `time.After(200ms)` 断言"没有第三次运行" | **已修**：改成 `rsiWaitAsyncFullIdle` 轮询队列落定后 `default` 断言 |
| `backend/internal/graph/runtime_process_janitor_test.go` | 轮询 `ps` 看孤儿进程是否被收养 | **保留**：轮询对象是内核里的进程表，是产品事件的落定值；`ps` 依赖已在慢层容忍 |
| `backend/internal/graph/runtime_rsi_snapshot_cleanup_test.go` | 轮询子进程是否被杀死 | **保留**：轮询的是进程存活（确定的落定值），有 5s 超时兜底 |
| `backend/internal/appinstall/bundle_selfcontained_test.go` | 轮询 `/api/health` 等真实守护进程 | **保留**：被测对象就是打包后的真实二进制；无 bundle 时 `t.Skip` |
| `app/*_test.go` 里 35 处 | `for ... { if 状态落定 { break }; Sleep(1ms) }` 轮询 | **保留**：轮询对象是产品状态，`Sleep` 只是让出 CPU |
| `backend/internal/graph/core_fleet_scale_test.go` 等 | `time.After(2–5 分钟)` 超时兜底 | **保留**：超时上限，不是断言本身 |

### 移到慢层（`testing.Short()` 跳过）

只移**真正的规模测试**——它们要建 1000+ 节点、跑满执行槽，是产品行为的证据但太贵：

| 测试 | 单独耗时 | 移到慢层的依据 |
| --- | --- | --- |
| `TestFleetRunsOneThousandTwentyFourAgentsThroughExecution` | 3.4–4.5s | 1024 个 agent 全部进入 dispatch，规模本身是断言 |
| `TestGraphRunnerHoldsOneThousandSimultaneousExecutionSlots` | 2.0–2.6s | 1000 个执行槽同时被占满 |
| `TestGraphRunnerScaleReport` | 2.1–2.5s | 1000 节点规模报告，输出吞吐/内存指标 |

效果：`go -C backend test -short ./internal/graph` 从 18.4s 降到 11.2s，且三次重复跑稳定在
11.0–11.2s。**没有**把任何普通用例塞进跳过名单——拿不准的用例要换成确定的等价断言，不是隔离。

### 已知的环境敏感点（未修，记录在案）

- `app` 的 94 个测试文件里有 47 个使用 `httptest`：端口由内核分配，不抢占固定端口，并发安全。
  没有测试连真实外部网络；`net.Listen("127.0.0.1:0")` 只在 `appinstall` 的真实二进制用例里出现。
- `app/chat_answer_clock_test.go` 的时钟断言用 `tester.Advance()` 推进虚拟时钟，不读墙钟，
  但它依赖 `roundMaster` 与消息状态的一致性；本轮盘点时该文件正被并发改动，失败原因是
  "另一个 agent 的测试先写、实现还没跟上"，不是 flaky。

**并发改动下怎么判一条失败算不算回归**（本仓库同时有几个 agent 在改 `app/*.go` 与
`backend/internal/graph/*.go`，全量测试会看到别人的中间态）：

1. 看失败测试所在的文件是不是出现在 `git status --porcelain` 里，或者它引用的符号
   （`state.board.scrolls`、`shell.ensureInsights`）在 `go vet` 里就报未定义——那是别人的中间态。
2. 把**自己改的文件**覆盖到一个干净的 `git archive HEAD` 检出上，在那里复跑门禁。红说明是自己的
   改动，绿说明是并发改动。本轮就是这样验证的：干净 HEAD 检出 + 我的改动 → `check-queue.py`
   退出码 0，37 条契约测试全绿；工作区里 `app` 的失败来自 `app/shell.go`、`app/insights.go`
   等文件的并发修改（`git status` 可见，`insights.go` 甚至已 `D` 删除而测试还在引用）。
3. 永远不要用 `git stash` / `git checkout` 去"还原"别人的工作。
