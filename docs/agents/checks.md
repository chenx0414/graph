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

## 测试夹具

驱动真实任务图的测试不要重新发明夹具：`tests/fixtures/lane.ts` 提供脚本化车道（记录每条车道收到的 briefing 与工作副本、返回合规的 `result_handoff@1` 结果）与 `settle(...)` 派发轮询。三个坑写在文件头部：`user.begin` 需要 `projects`；worker 结果不合 `result_handoff@1` 会被 block 且下游永不派发；节点完成是异步结算的。

## 在 Git 工作树里验证

`git worktree add` 只带出 tracked 文件，被忽略的依赖与构建产物不在其中。要在工作树里跑全量检查：

```sh
cp -al <主仓库>/node_modules <工作树>/node_modules
```

硬链接是工作树内的真实条目，不会越出工作树。不要手工 `ln -s` 指向主仓库的 `node_modules`：Graph 自己的工作副本由宿主建立链接，并把解析后的真实路径作为沙箱读取授权交给 Agent（见 ADR 0027）；手工链接没有这份授权，沙箱内的 Agent 子进程会以模块解析失败告终。

全量检查不依赖预先构建的 `dist/web`：需要页面的用例在 `beforeAll` 里把 Web 构建到临时目录，只起守护进程的用例写一个桩 `index.html`（`tests/console/daemon-console.test.ts` 守住这条）。

## 会话回溯

需要观察一次会话的用户请求、失败命令和最终仓库状态时运行：

```sh
node --run session:summary
```

默认选择 `~/.codex/sessions/` 中最近更新的 JSONL；也可以把具体会话文件作为参数传入。该工具流式读取日志，先显示 `parent_thread_id` / `forked_from_id`，不会倾倒原始日志。
