# 图机制测试记录：运行中动态改图 + 真返工

本文件是一次 **Graph 图机制测试** 的记录（测试对象是 Graph 本身，不是产品功能）。它记录两项被机械验证的机制：

1. **真返工（rework）**：宿主门第一轮**必然红** —— 它要求只有走过 `no` 回边之后才可能具备的事实；`pass` 路由 `no` 把门的失败输出交给 worker，第二轮补齐后才可能绿。判定返工与否的是机械门，不是模型自觉。
2. **运行中动态改图（graph revision）**：main 在 worker 第一轮结果之后修订本图 —— 新增 `reviewer-2b`、退役 `notes`；宿主门从状态库机械验证修订真的生效。

本任务（graph）id：`c644cd64-ff75-4c9a-bdb7-c1703a26f115`。

## 驱动本图的两个 free 模型

| 节点 | 角色 | 模型 id |
| --- | --- | --- |
| `planner` / `worker` / `relay` / `notes` | 实现者 | `opencode-go:longcat-2.5-preview-free` |
| `reviewer-2b` | 评审者（main 运行中途新增，由 `worker.result` 触发） | `opencode-go:step-5-preview-free` |

两者都在上游 `/models` 中在列；实现者与评审者不是同一个模型，满足评审独立性。

## 宿主门

宿主门是 `scripts/check-graph-revision.mjs`，命令 `node --run test:graph-revision`（`package.json` 的 `scripts.test:graph-revision`）。它逐条断言，任一不满足即 `exit 1` 并打印原因：

- **(a)** `docs/graph-revision-rework.md` 存在、含 `## 返工记录` 一节，并**原样引用第一次门失败输出的关键行**（关键行从状态库里最早一条 `passed=false` 的已结算 `check` 宿主操作记录读出——与 `rework` 回边带给 worker 的是同一份字节）。
- **(b)** 本文件写出驱动本图的两个 free 模型 id：`opencode-go:longcat-2.5-preview-free` 与 `opencode-go:step-5-preview-free`。
- **(c)** 读状态库 `~/Library/Application Support/Graph/state/tasks.sqlite`，本任务 `worker` 有 ≥2 次 `kernel_executions` 记录 —— 即真的返工过。
- **(d)** 读同一状态库，存在 revision>1：该版本**新增**的节点（不在 revision 1 的 `nodes` 里）已 `succeeded`，而 revision 1 里有、新版本里没有的**被退役**节点（`notes`）没有任何执行 —— 即 main 的动态改图真的生效。

门真实读状态库（`kernel_executions` / `kernel_revisions` / `kernel_nodes` / `kernel_module_operations`），不伪造通过。

## 返工记录

### 第一次门失败输出（由 rework 输入带回，原样引用）

第一次宿主门在集成副本上运行时，worker 的提交**还没有被集成**（check 当时挂在 `worker.result` 上，在 worker 自己的执行结算、集成完成之前就跑了），所以集成副本里根本还没有本任务新增的 `test:graph-revision` 脚本。该次门失败输出的关键行（原文，`exit code 1`）：

```
Missing script: "test:graph-revision" for /Users/macmini/Library/Application Support/Graph/state/worktrees/xin-tu-tu-ji-zhi-ce-shi-yong-liang-ge-fr-c644cd64/integration/package.json
```

`rework` 回边（`pass.rework → worker.rework`，协议 `data`）把这条失败输出交给 worker；main 同时用直接投递把它的原文与原因一并带来。

### 第一轮：设计使然，必然红

第一轮在 worker worktree 里跑 `node --run test:graph-revision`，门按设计红（此时还没有走过 `no` 回边）：

```
[graph-revision] GATE FAIL — 4 assertions, 3 failed
[graph-revision] (a) FAIL: no recorded first gate failure output yet
[graph-revision] (c) FAIL: worker executions=1, need >=2
[graph-revision] (d) FAIL: revision 2 added node reviewer-2b status=idle, need succeeded
```

红的原因：(c) 要求本任务 `worker` 至少执行两次，而第一轮只执行了一次；(d) 要求 revision>1 新增的 `reviewer-2b` 已经 `succeeded`，而第一轮它还没有跑；这**只有走过 `no` 回边、worker 第二轮补齐之后**才可能成立。这是设计使然，不是失误，也不是伪装。

### 第二轮：收到 rework 后补齐

收到 `rework` 后，本文件补上了上面「第一次门失败输出」的原样引用，并核对门确实读状态库。返工过程中 main 修订了图（这些修订本身也是「运行中动态改图」的实测）：

- **revision 3**：`pass.rework` / `pass.approved` 输出、`worker.rework` 输入、图的 `result` 输出从 `verdict` 改为 `data`。原 `verdict` 协议要求 `passed` + `reason`，而 `pass` 的规则转发的是 `check.result`（宿主操作结果，没有 `reason`），`broadcastModule` 的协议校验直接拒绝，导致 `pass` 模块失败暂停、**根本不产生 rework 投递**（状态库里记的是 `pass.rework: must have required property 'reason'`）。改成 `data` 后回边才真的通。
- **revision 4**：中间插入中转节点 `relay`（`worker.result → relay.job → relay.handoff → check.job`）。`relay` 是一次独立执行，发生在 worker 的提交被集成**之后**，所以门这次看到的是真实的集成树，而不是「还没有这次交付」的树。

第二轮的自检结论与最终退出码见下表；门是否绿取决于状态库里 `worker` 是否真的执行了 ≥2 次、以及 revision>1 新增的 `reviewer-2b` 是否已经 `succeeded`（它由 `worker.result` 触发，会与中转并行跑）。

## 自检

| 命令 | 工作副本 | 退出码 | 结论 |
| --- | --- | --- | --- |
| `node --run test:graph-revision` | worker worktree（第一轮） | 1 | 红：(a)/(c)/(d) 未满足，设计使然 |
| `node --run test:graph-revision` | worker worktree（第二轮） | 1 | 红：只剩 (d) —— revision>1 新增的 `reviewer-2b` 还没 `succeeded` |

第二轮门输出（原样）：

```
[graph-revision] GATE FAIL — 4 assertions, 1 failed
[graph-revision] (d) FAIL: revision 2: added node reviewer-2b status=idle, need succeeded; revision 3: added node reviewer-2b status=idle, need succeeded; revision 4: added node relay status=idle, reviewer-2b status=idle, need succeeded
```

第二轮 (a)/(b)/(c) 已满足：(a) 本文件原样引用了第一次失败输出；(b) 两个 free 模型 id 都在；(c) 本任务 `worker` 已执行 2 次（真返工）。(d) 仍未满足：`reviewer-2b` 由 `worker.result` 触发，与 `relay → check` 并行，本轮才第一次被触发，此时还没结算成 `succeeded`。因此回边会再次返工；等 `reviewer-2b` 的执行结算之后，(d) 即可满足，门应转绿。

自检结论：门真实读状态库，不伪造通过；第一轮的红是设计使然。
