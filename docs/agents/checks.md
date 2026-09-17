# 仓库检查

提交或推送前运行：

```sh
node --run check
```

该命令依次执行：

1. 主应用与 Web 的 TypeScript 检查。
2. `expect(...).resolves` / `expect(...).rejects` 必须 `await` 的机械检查。
3. 全量 Vitest。
4. 验收截图等 `docs/planning/acceptance-evidence/` 内容是否被普通测试改写。

## 验收证据

普通测试把截图写到测试临时目录，不覆盖 tracked evidence。只有明确要更新交付截图时才运行：

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

## 会话回溯

需要观察一次会话的用户请求、失败命令和最终仓库状态时运行：

```sh
node --run session:summary
```

默认选择 `~/.codex/sessions/` 中最近更新的 JSONL；也可以把具体会话文件作为参数传入。该工具流式读取日志，先显示 `parent_thread_id` / `forked_from_id`，不会倾倒原始日志。
