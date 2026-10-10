# 图机制测试记录：运行中动态改图 + 真返工

本文件是一次 **Graph 图机制测试** 的记录（测试对象是 Graph 本身，不是产品功能）。它记录两项被机械验证的机制：

1. **真返工（rework）**：宿主门第一轮**必然红** —— 它要求只有走过 `no` 回边之后才可能具备的事实；`pass` 路由 `no` 把门的失败输出交给 worker，第二轮补齐后才可能绿。判定返工与否的是机械门，不是模型自觉。
2. **运行中动态改图（graph revision）**：main 在 worker 第一轮结果之后修订本图（revision 2）—— 新增 `reviewer-2b`、退役 `notes`；宿主门从状态库机械验证修订真的生效。

本任务（graph）id：`c644cd64-ff75-4c9a-bdb7-c1703a26f115`。

## 驱动本图的两个 free 模型

| 节点 | 角色 | 模型 id |
| --- | --- | --- |
| `planner` / `worker` / `notes` | 实现者 | `opencode-go:longcat-2.5-preview-free` |
| `reviewer-2b` | 评审者（main 运行中途新增，评审返工后的精确版本） | `opencode-go:step-5-preview-free` |

两者都在上游 `/models` 中在列；实现者与评审者不是同一模型，满足评审独立性。

## 宿主门

宿主门是 `scripts/check-graph-revision.mjs`，命令 `node --run test:graph-revision`（`package.json` 的 `scripts.test:graph-revision`）。它逐条断言，任一不满足即 `exit 1` 并打印原因：

- **(a)** `docs/graph-revision-rework.md` 存在、含 `## 返工记录` 一节，并**原样引用第一次门失败输出的关键行**（关键行从状态库里最早一条 `passed=false` 的已结算 `check` 宿主操作记录读出——与 `rework` 回边带给 worker 的是同一份字节）。
- **(b)** 本文件写出驱动本图的两个 free 模型 id：`opencode-go:longcat-2.5-preview-free` 与 `opencode-go:step-5-preview-free`。
- **(c)** 读状态库 `~/Library/Application Support/Graph/state/tasks.sqlite`，本任务 `worker` 有 ≥2 次 `kernel_executions` 记录 —— 即真的返工过。
- **(d)** 读同一状态库，存在 revision>1：该版本**新增**的节点（不在 revision 1 的 `nodes` 里）已 `succeeded`，而 revision 1 里有、新版本里没有的**被退役**节点（`notes`）没有任何执行 —— 即 main 的动态改图真的生效。

## 返工记录

### 第一轮：设计使然，必然红

第一轮 `node --run test:graph-revision` 失败输出的关键行（原样）：

```
[graph-revision] (a) FAIL: no recorded first gate failure output yet
[graph-revision] (c) FAIL: worker executions=1, need >=2
[graph-revision] (d) FAIL: revision 2 added node reviewer-2b status=idle, need succeeded
```

红的原因：(c) 要求本任务 `worker` 至少执行两次，而第一轮只执行了一次；(d) 要求 revision 2 新增的 `reviewer-2b` 已经 `succeeded`，而第一轮它还没有跑；这**只有走过 `no` 回边、worker 第二轮补齐之后**才可能成立。因此第一轮无论怎么写都不可能绿——这是设计使然，不是失误，也不是伪装。

### 第二轮：收到 rework 后补齐

（收到 `rework` 输入后在本节原样引用它带回的第一次门失败输出，并说明补齐了什么、第二次门的结果。）

## 自检

| 命令 | 工作副本 | 退出码 | 结论 |
| --- | --- | --- | --- |
| `node --run test:graph-revision` | worker worktree（第一轮） | 1 | 红，原因见上（(c)/(d) 未满足） |

自检结论：门真实读状态库（`kernel_executions` / `kernel_revisions` / `kernel_nodes`），不伪造通过；第一轮的红是设计使然。
