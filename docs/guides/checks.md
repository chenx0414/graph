# 检查操作指南

提交、推送与证据保护规则见 [工程规范：验证与交付](../../CODING_STANDARDS.md#验证与交付)。以下只写操作步骤；每条门禁判定什么、怎么改，由它失败时的输出自己说明。

## 并行会话运行门禁

新建工作树的 `post-checkout` 自动安装检查队列与 worker 上限。迁移已有工作树时，在长期主检出运行 `python3 scripts/install-check-policy.py --all`。

运行 `python3 scripts/check-queue.py`。入口需要 Python 3（macOS/Linux），通过本机共享的文件锁让同一用户在本机的 Graph 工作树与克隆串行检查。等待期间不启动构建或测试。检查期间自动锁定工作树，防止其他会话清理正在使用的检出；完成后释放本次创建的工作树锁，保留已有锁。进程退出后自动释放名额，检查失败的退出码原样传回。检查步骤由排队脚本执行，不另设可绕过队列的全量检查入口。

给命令设置超时时，把排队等待时间也算进去；不要因等待名额而重复启动门禁。安装排队入口时已经启动的检查会先完成。

## 验收证据

明确要更新交付截图时：

```sh
GRAPH_UPDATE_EVIDENCE=1 go -C backend test ./...
```

随后检查 `git diff -- acceptance-evidence`，只提交有意更新的文件。

## 行为门禁与真实模型评测

`graphcheck harness` 进门禁，用替身模型跑冻结用例：免费、确定，判「活儿还能不能干完」。记下新的 harness 面与判决用 `--record`；门禁自己从不改写被跟踪的文件。约 20 秒。

判「提示还管不管用」要真模型，那是 `graphcheck eval` 的事，按需跑、不进门禁（要凭据、要预算）：

```sh
go -C backend run ./cmd/graphcheck eval --config graph.config.json --case parser
```

## 运行窗口

窗口是 `app/`（Go + MyGo）这一个二进制，没有 Electron：`go -C app run .` 直接开窗，`go -C backend run ./cmd/graphbuild app` 打包成 `/Applications/Graph.app`。`src/runtime/` 的两个 Node worker 是唯一的执行面 JS，跑扩展与模块。

## Hook 安装

仓库内的 `.githooks/` 在长期保留的主检出里启用一次，新建工作树会继承：

```sh
git config core.hooksPath "$(git rev-parse --show-toplevel)/.githooks"
```

需要在推送前单独复现时运行 `./.githooks/pre-push`。

## 在 Git 工作树里验证

`git worktree add` 只带出 tracked 文件，被忽略的构建产物不在其中；Go 的依赖在模块缓存里，`go` 会自己拉，所以工作树里直接跑 `python3 scripts/check-queue.py` 即可，不需要先拷贝任何目录。

## CI 分层、分片与坏测试

CI 的分层、分片、diff 触发、契约测试与坏测试清单单独成篇：[CI 分层、分片与坏测试](ci.md)。

## 会话回溯

需要观察一次会话的用户请求、失败命令和最终仓库状态时运行：

```sh
go -C backend run ./cmd/graphcheck summary
```

默认选择 `~/.codex/sessions/` 中最近更新的 JSONL；也可以把具体会话文件作为参数传入。该工具流式读取日志，先显示 `parent_thread_id` / `forked_from_id`，不会倾倒原始日志。
