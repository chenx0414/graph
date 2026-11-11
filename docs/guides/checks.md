# 检查操作指南

提交、推送与证据保护规则见 [工程规范：验证与交付](../../CODING_STANDARDS.md#验证与交付)。以下操作按需读取。

## 验收证据

明确要更新交付截图时运行：

```sh
GRAPH_UPDATE_EVIDENCE=1 go -C backend test ./...
```

随后检查 `git diff -- acceptance-evidence`，只提交有意更新的文件。

## 并行会话运行门禁

新建工作树的 `post-checkout` 自动安装检查队列与 worker 上限。迁移已有工作树时，在长期主检出运行 `python3 scripts/install-check-policy.py --all`。

运行 `python3 scripts/check-queue.py`。入口需要 Python 3（macOS/Linux），通过本机共享的文件锁让同一用户在本机的 Graph 工作树与克隆串行检查。等待期间不启动构建或测试。检查期间自动锁定工作树，防止其他会话清理正在使用的检出；完成后释放本次创建的工作树锁，保留已有锁。进程退出后自动释放名额，检查失败的退出码原样传回。检查步骤由排队脚本执行，不另设可绕过队列的全量检查入口。

门禁的步骤就是 `go vet`、`go test`（`backend/` 与 `app/` 两个 module）和四个静态检查加一个行为门禁，遇到第一个失败即停止本轮。给命令设置超时时，把排队等待时间也算进去；不要因等待名额而重复启动门禁。安装排队入口时已经启动的检查会先完成。

## harness 行为门禁

`python3 scripts/check-queue.py` 跑 `graphcheck harness`：它把三个冻结用例
（`parser`、`cli`、`persistence`）各跑一遍，结论是各用例自己的 verify（`go test ./...`），
外加工具的使用纪律（读 → 精确改 → 读回来核对）。跑用例的是一个只按 harness 行事的替身模型：
它做每一步之前先看 harness 还给不给这个工具、还告诉不告诉它该怎么用。

约 20 秒。门禁记下被判过的 harness 面（逐文件 sha256）与每个用例的判决，
所以面变了又变红，报的是**回归**而不是笼统的失败。

- 单独跑：`go -C backend run ./cmd/graphcheck harness`。
- 记下新的 harness 面与判决：`go -C backend run ./cmd/graphcheck harness --record`（门禁自己从不改写被跟踪的文件）。
- 门禁红了先看它指名的那句规则；多数时候是 harness 少了东西，不是用例坏了。

## 真实模型评测

`python3 scripts/check-queue.py` 里的 `graphcheck harness` 用替身模型跑冻结用例：免费、确定，判"活儿还能不能干完"。
判"提示还管不管用"要真模型，那是 `go -C backend run ./cmd/graphcheck eval` 的事：同一个驱动，
把配置里的模型真正跑一遍，逐个用例打印 `taskSuccess`、工具序列与 verify 结论。

```sh
go -C backend run ./cmd/graphcheck eval --config graph.config.json --case parser
```

它按需跑，不进门禁：真模型要凭据、要预算。

## 运行窗口

窗口是 `app/`（Go + MyGo）这一个二进制，没有 Electron：`go -C app run .` 直接开窗，
`go -C backend run ./cmd/graphbuild app` 打包成 `/Applications/Graph.app`。
`src/runtime/` 的四个 Node worker 是唯一的执行面 JS，跑扩展、模块、宿主命令与检查解析。

## Pre-commit Hook

仓库内提供 `.githooks/pre-commit`，与 [Pre-push Hook](#pre-push-hook) 共用同一个
`.githooks` 目录，在长期保留的主检出中设置绝对 `core.hooksPath`，让新工作树也使用同一份 Hook。

提交前检查**暂存区**里的文件大小：单个文件不得超过
5,000 令牌（令牌 = 字节数 / 4，即 20,000 字节）。超出的文件无法在一个上下文窗口内读完、
读完并改对，所以必须在入库前拆分。检查对象是暂存的 blob，不是工作区文件：暂存后又改过的
文件，仍按将要提交的大小计算。

被跳过的文件（不是代理编写的，拆分它们没有意义）：

| 类别 | 例子 |
| --- | --- |
| 依赖锁文件 | `go.sum`、`*-lock.json` |
| 生成代码 | 带 `DO NOT EDIT` / `@generated` 头的文件 |
| 生成数据 | `src/catalog/models-dev.snapshot.json`、`*.snapshot.json`、`*.output.txt` |
| 内置第三方 | `.agents/skills/`、`vendor/`、`dist/`、`build/` |
| 二进制资源 | 图片、字体、压缩包、`*.sqlite` |

确实无法拆分的文件，在文件顶部写明理由即可豁免（理由必须在同一行）：

```
// graph:allow-large-file: provider schema table, one row per field
```

手动检查暂存区，或检查指定文件：

```sh
go -C backend run ./cmd/graphcheck tokens              # 暂存区
go -C backend run ./cmd/graphcheck tokens src/core/task-runtime.ts
```

这个检查不进 `python3 scripts/check-queue.py`：仓库里已存在历史大文件，而它要拦的是**本次改动**新写大
文件。`GRAPH_FILE_TOKEN_LIMIT` 可临时改上限（默认 5000）。

## 表的归属检查

有两份持久表，各归一个 store 一个主人：

| 表 | 主人 |
| --- | --- |
| `kernel_` 开头的那批 | `KernelStore`（`core_kernel_*.go`） |
| `tasks`、`questions`、`invocations`、`nodes`、`activations`、`instances`、`operations`、`conversations`、`proposals`、`messages` | `TaskStore`（`core_task_*.go`，每张表一个文件） |

形状由 store 知道，其他地方只问 store 要答案、要 store 去写。任何在 store 之外写这些表的
地方都是第二个主人，一列要改就得在两个地方都改。

```sh
go -C backend run ./cmd/graphcheck ownership                  # 整个 backend/internal/graph 包
go -C backend run ./cmd/graphcheck ownership backend/internal/graph/core_graph_runtime_stop.go
```

读不算第二个主人：读不改表的形状，所以 store 之外仍可以有读。

**模块自己的表**（`wake_intents`、`tool_calls`、`git_commits`、`git_ops`、`worktrees` 等）由**那个模块**的一个文件拥有——守卫逐个点名了它们。

**schema 里的每张表都要有主人**。守卫自己读 schema（`core_store_schema_base.go`、`core_store_schema.go`、
`core_store_migrate.go` 里的 `CREATE TABLE`），所以：

- **一张表有主人，就只有那个主人写它**；
- **一张表还没有主人，第一次写它就会被拒**——新表要先被点名。

**两种文件可以例外，但要在文件头上写明为什么**：

```
// graph:table-writes-exempt: a migration owns the SQL of the schema it migrates
```

一是**迁移**——迁移的 SQL 描述的就是形状本身，它属于写下形状的地方。二是**一次跨多张表
的操作**——退役一个图连同它的一切，是关于许多张表的一个事实，拆开它会让这次操作对自己在
做什么说谎。

**它有两种看法**：

```sh
go -C backend run ./cmd/graphcheck ownership                  # 整棵树：谁在写谁的表
go -C backend run ./cmd/graphcheck ownership --staged   # 只看这次改动新增了什么
```

**`--staged` 才是能进 Pre-commit Hook 的那一种**：它**只拦新增的写者**——一张已经有主人的表，
这次改动又添了一个写者，就 refused。而**这个分支还没走到的主人**（main 与并行分支上那些
表仍然从许多地方写），**它一个也不碰**。理由和文件大小守卫一样：**要拦的是**本次改动**新写
的东西**，不是历史上就有的。

因此 Hook 里接的是 `--staged`：

```sh
go -C "$root/backend" run ./cmd/graphcheck ownership --staged
```

**仓库里没有这个脚本时，Hook 跳过它**——所以不认识「表的主人」这件事的分支不会被它拦住。

**整棵树那一种**（`go -C backend run ./cmd/graphcheck ownership`）**暂时不进** `python3 scripts/check-queue.py`：main 与并行的
几个分支仍有几十处越界写，把检查接进共享的门禁会立刻打断它们的提交。等那些分支都取了这次
改动（`feature/architecture-deepening`）之后，再把它接进 `check-queue.py` 的步骤里。

## Pre-push Hook

仓库内提供 `.githooks/pre-push`，推送前执行完整检查。在每个 clone 的长期主检出中启用一次：

```sh
git config core.hooksPath "$(git rev-parse --show-toplevel)/.githooks"
```

需要在推送前单独复现时运行：

```sh
./.githooks/pre-push
```

## 在 Git 工作树里验证

`git worktree add` 只带出 tracked 文件，被忽略的构建产物不在其中；Go 的依赖在模块缓存里，
`go` 会自己拉，所以工作树里直接跑 `python3 scripts/check-queue.py` 即可，不需要先拷贝任何目录。

## 会话回溯

需要观察一次会话的用户请求、失败命令和最终仓库状态时运行：

```sh
go -C backend run ./cmd/graphcheck summary
```

默认选择 `~/.codex/sessions/` 中最近更新的 JSONL；也可以把具体会话文件作为参数传入。该工具流式读取日志，先显示 `parent_thread_id` / `forked_from_id`，不会倾倒原始日志。
