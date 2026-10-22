# 检查操作指南

提交、推送与证据保护规则见 [工程规范：验证与交付](../../CODING_STANDARDS.md#验证与交付)。以下操作按需读取。

## 验收证据

明确要更新交付截图时运行：

```sh
GRAPH_UPDATE_EVIDENCE=1 node --run test
```

随后检查 `git diff -- docs/planning/acceptance-evidence`，只提交有意更新的文件。

## Pre-commit Hook

仓库内提供 `.githooks/pre-commit`，与 [Pre-push Hook](#pre-push-hook) 共用同一个
`.githooks` 目录，`git config core.hooksPath .githooks` 一次即全部启用。

提交前检查**暂存区**里的文件大小：单个文件不得超过
5,000 令牌（令牌 = 字节数 / 4，即 20,000 字节）。超出的文件无法在一个上下文窗口内读完、
读完并改对，所以必须在入库前拆分。检查对象是暂存的 blob，不是工作区文件：暂存后又改过的
文件，仍按将要提交的大小计算。

被跳过的文件（不是代理编写的，拆分它们没有意义）：

| 类别 | 例子 |
| --- | --- |
| 依赖锁文件 | `pnpm-lock.yaml`、`yarn.lock`、`go.sum`、`*-lock.json` |
| 生成代码 | 带 `DO NOT EDIT` / `@generated` 头的文件 |
| 生成数据 | `src/catalog/models-dev.snapshot.json`、`*.snapshot.json`、`perf/bench/*.json` 测量输出、`*.output.txt` |
| 内置第三方 | `.agents/skills/`、`vendor/`、`node_modules/`、`dist/`、`build/` |
| 二进制资源 | 图片、字体、压缩包、`*.sqlite` |

确实无法拆分的文件，在文件顶部写明理由即可豁免（理由必须在同一行）：

```
// graph:allow-large-file: provider schema table, one row per field
```

手动检查暂存区，或检查指定文件：

```sh
node --run check:tokens              # 暂存区
node scripts/check-file-tokens.mjs src/core/task-runtime.ts
```

这个检查不进 `node --run check`：仓库里已存在历史大文件，而它要拦的是**本次改动**新写大
文件。`GRAPH_FILE_TOKEN_LIMIT` 可临时改上限（默认 5000）。

## Pre-push Hook

仓库内提供 `.githooks/pre-push`，推送前执行完整检查。每个 clone 启用一次：

```sh
git config core.hooksPath .githooks
```

需要在推送前单独复现时运行：

```sh
./.githooks/pre-push
```

## 测试夹具

编写任务图测试前读取并复用 [原生图工作副本夹具](../../tests/fixtures/native-worktree-graph.ts)与 [图模式定义](../../tests/fixtures/native-patterns.ts)的接口与文件头约束。

## 在 Git 工作树里验证

`git worktree add` 只带出 tracked 文件，被忽略的依赖与构建产物不在其中。要在工作树里跑全量检查：

```sh
cp -al <主仓库>/node_modules <工作树>/node_modules
```

硬链接是工作树内的真实条目，不会越出工作树。不要手工 `ln -s` 指向主仓库的 `node_modules`：Graph 自己的工作副本由宿主建立链接，并把解析后的真实路径作为沙箱读取授权交给 Agent（见 ADR 0027）；手工链接没有这份授权，沙箱内的 Agent 子进程会以模块解析失败告终。

## 会话回溯

需要观察一次会话的用户请求、失败命令和最终仓库状态时运行：

```sh
node --run session:summary
```

默认选择 `~/.codex/sessions/` 中最近更新的 JSONL；也可以把具体会话文件作为参数传入。该工具流式读取日志，先显示 `parent_thread_id` / `forked_from_id`，不会倾倒原始日志。
