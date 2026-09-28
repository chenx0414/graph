# 多 Agent 协作：写入账本、条形码清单与无冲突合流

日期：2026-09-28。使用者确认范围：借鉴 MiniMax Code CLI 的三项机制，在 Graph 现有 worktree 隔离之上增量实现。隔离模型选 **(a)**（保留每 lane 一个 `graph/copy/*` worktree），**不做**单目录 + 写时复制 overlay。

## 为什么不做「单目录 + 真 Overlay」

使用者最初描述 MiniMax 的机制是「子 AI 改代码时系统垫一张虚拟草稿纸，物理上碰不到对方」。读完其源码后，事实有三处出入：

1. **子 agent 不是独立目录**：`packages/local-runtime/src/background-task/runner.ts:76` 与 `packages/local-runtime/src/api/local-task-runner.ts:86` 都是 `workspaceDir: input.parentSession.workspaceDir`，即子会话继承父会话目录，同一 checkout 并发读写。
2. **「草稿纸」是事后快照账本，不是写时复制**：`packages/local-runtime/src/turns/file-changes.ts` 在工具调用前存 `before`、调用后存 `after`（`LocalTurnDiffSnapshotEntry`），回合结束生成 `LocalTurnDiffRecord{changeSetId,turnId,fileChanges:LocalFileDiff[]}`，其中 `LocalFileDiff.patch.hunks` 是 `diff` 包算出的结构化 hunk。
3. **隔离靠的是「写入前比对」，不是虚拟文件系统**：`LocalTurnDiffRewindCapability`（`turns/diff-rewind.ts`）在每次写之前检查 `expected` 快照是否仍匹配，不匹配就 `skipped`——这是乐观并发，**在真有并发写时没有硬隔离**。它的 worktree 只是 opt-in 的 `runLocation`（`infra/git/fork-worktree-adapter.ts`），不是并发机制。

Graph 现有三层隔离如果改成单目录就全部失效：
- 路径层：`src/runtime/bounded-path.ts` `resolveBounded(root=realpath(workspace))` 逐组件校验，越界即拒。
- 进程层：`src/runtime/restricted-process.ts` 用 `@anthropic-ai/sandbox-runtime` 的 `SandboxManager` 给每次 check/命令调用起 OS 沙箱，读授权逐路径授予。
- 策略层：`src/core/access-policy.ts` `filesystem.write: 'workspace-and-bound'`，即使 `'host'` 也仍走 `resolveBounded`。

因此本设计保留真实隔离，把 MiniMax 真正有价值的部分——**可核对的写入账本**与**客观的变更清单**——增量落在现有模型上。

## 三项机制的 Graph 映射

| MiniMax 机制 | Graph 落点 | 与现状的关系 |
| --- | --- | --- |
| 私有 Overlay（草稿纸） | 每 lane 一个 worktree（已有）+ 逐 lane **写入账本**（新）：`node_write_captures` 记录每次文件写工具调用的 before/after 快照（sha256、size、exists），回合结束冻结成 lane 的 ChangeSet | 隔离已存在；**新增**的是「笔迹」这一层可核对记录 |
| ChangeSet（条形码清单） | 加严现有 `ResultHandoffDraft`：`submit_result` 校验 `changes[].path/digest` 必须逐一匹配真实磁盘 diff；不匹配即 `invalid_evidence` 拒收 | **沿用**已确认格式，不新增格式 |
| 无冲突合流 | 已有：lane 分支 → 集成 worktree `mergeRef`；冲突即 `merge --abort` + block。**新增**：`git_conflict` 前先派 merge subagent；解不了仍 block | 新增「撞车时先让子 agent 在集成 worktree 里解一次」 |

## 失败模式清单（写代码前固定，作为规格）

### F1 写入账本（`src/core/write-ledger.ts`）

| 失败模式 | 期望行为 |
| --- | --- |
| 同一个文件被同一 lane 写两次 | 账本只有一条记录，`before` 保持第一次的内容（不是第二次覆盖前的中间态） |
| 文件被写后又被删除 | `after.exists=false`，`before.digest` 仍保留，两者都留在记录里 |
| 文件是新创建的 | `before.exists=false`，`after.digest` 为新字节哈希 |
| 二进制/超大文件 | 不读内容算 diff；只记 `sizeBytes`/`exists`/`digest`（流式哈希），并标 `binary`/`oversized` |
| 写工具以相对路径、绝对路径、`..` 越界路径调用 | 相对与绝对都归一到 lane 根内；越界路径整条记录拒绝（`unsafe_path`），不落库 |
| 工具名不在写集合内（`read`、`bash`） | 不产生记录；`bash` 不进账本（无法对 shell 做精确 before/after） |
| 同一个 toolCallId 重复上报 | 幂等：不新增记录，也不改已冻结的内容 |
| lane 的 worktree 已被释放（terminal task） | 账本只读历史记录，不再新捕获 |
| 账本读取时任务被删除 | 返回空，不抛错 |

### F2 条形码清单校验（`src/core/predecessor-handoff.ts` + `src/runtime/pi-adapter.ts`）

| 失败模式 | 期望行为 |
| --- | --- |
| 清单里的 path 在 lane 里根本没有改动 | `invalid_evidence` 拒收，缺陷带 `path` 与「磁盘上无此改动」 |
| 清单里的 digest 与实际字节不符 | 拒收；**不**用模型报告的数字覆盖磁盘事实 |
| 清单漏报一个真实改动过的文件 | 拒收，缺陷列出遗漏路径（这是「客观补丁」的核心） |
| 清单报了声明范围之外的路径 | 拒收，并要求改由所属 lane 处理 |
| 同一次提交同时有 representation 与 semantic 缺陷 | 两类都报，worker 一轮修完 |
| 完全一致 | 通过，且不因重新核对而改写 worker 提供的任何字段 |

### F3 无冲突合流与 merge subagent（`src/git/integration.ts` + `src/core/execution.ts`）

| 失败模式 | 期望行为 |
| --- | --- |
| 两个 lane 改不相交的文件 | 自动拓印回集成分支，无需任何 agent 介入 |
| 两个 lane 改同一文件的同一行 | 亮红灯：先派 merge subagent，**绝不**用 merge 的结果覆盖任何一个 lane 的原始分支 |
| merge subagent 解不了 | 仍然 block，问题沿用 `git_conflict`，`conflicts` 列出文件 |
| merge subagent 的结论无法与真实 git 状态对应（没产生合并提交却声称解了） | 以 git 为准：仍 block |
| merge 结果改动了声明范围之外的路径 | 以 git 为准，仍 block |
| merge subagent 把某一方的改动整段丢弃（"覆盖"） | 拒绝：合并提交必须同时包含两侧内容的合并，缺失任一侧即 block |
| 解冲突过程中进程崩溃 | 集成 worktree 回到 merge 前状态（`merge --abort` 已在），不留下半合并 |

## 不在本次范围

- 单目录 + 写时复制 overlay（见上）。
- `bash` 工具的写入捕获：shell 无法做可靠的 before/after，仅在清单校验阶段体现为「磁盘事实与清单不符则拒收」。
- 跨任务的并发隔离：任务本身串行，lane 级并行已由 worktree 提供。
