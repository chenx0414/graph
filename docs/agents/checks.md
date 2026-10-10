# 检查操作指南

提交、推送与证据保护规则见 [工程规范：验证与交付](../../CODING_STANDARDS.md#验证与交付)。以下操作按需读取。

## 验收证据

明确要更新交付截图时运行：

```sh
GRAPH_UPDATE_EVIDENCE=1 node --run test
```

随后检查 `git diff -- docs/planning/acceptance-evidence`，只提交有意更新的文件。

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

编写任务图测试前读取并复用 [测试夹具](../../tests/fixtures/lane.ts)的接口与文件头约束。

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
