# Matt 流程（文档驱动）

这条流程把「对齐想法 → 定稿设计 → 拆任务 → 实现 → 审查」变成**一串文件**，而不是一串会话记忆：
换 Agent、换会话、换模型，都只读这些文件。前三步（grill / spec / tickets）由 **main Agent** 做，
后两步（implement / review）由**独立 Agent** 做（本文件的「谁来跑」一节）。

## 产物与位置（契约）

| 步骤 | 产物 | 位置 |
| --- | --- | --- |
| `/grill-with-docs` | 共识与术语（懒创建） | 根 `CONTEXT.md`、`docs/adr/` |
| `/to-spec` | 规格 | **`docs/specs/<slug>.md`**（必填：`# 标题`、≥1 个 `## 小节`、正文 ≥ 200 字符） |
| `/to-tickets` | 任务 | **GitHub Issues**（`chenx0414/graph`），每条 issue 正文必须指回 `docs/specs/<slug>.md` 或 slug，并带分诊标签（见 `triage-labels.md`） |
| `/implement-spec` | 实现 | 该 slug 的提交/改动，**commit message 里引用 task 号 `(#<n>)`** |
| `/code-review` | 审查 | 对照规格与任务审查变更（前提：上面三者齐备） |

`<slug>` 一律小写字母、数字、连字符。

## 机械闸门

```bash
node scripts/matt-flow.mjs <slug> --stage spec        # 只查规格
node scripts/matt-flow.mjs <slug> --stage tickets     # 规格 + 任务
node scripts/matt-flow.mjs <slug> --stage implement   # 规格 + 任务 + 实现（默认）
node scripts/matt-flow.mjs <slug> --stage review      # 四者齐备才放行
node scripts/matt-flow.mjs <slug> --json              # 机器可读
```

- 退出码 0 = 该阶段的前提齐备；非 0 = 缺什么，**逐条**打印出来。
- 它只检查**前置产物是否存在**，不评价写得好不好，也**绝不自己编**一份产物。
- 离线或测试时用 `--tickets <json>` 喂一份 `gh issue list --json number,title,body,labels` 的输出，
  解析路径与线上完全一致。`gh` 不可用或未登录时**明确失败**，不会静默通过。

## 谁来跑（同一份实现，三处引用）

1. **main 派发前**：`node scripts/matt-flow.mjs <slug> --stage implement`；没过就先回去补 spec/tickets，
   不要用「心里有数」替代文件。
2. **两个 subagent 身份的第一步**：`matt-implement` 跑 `--stage implement`，`matt-review` 跑 `--stage review`；
   没过就**拒绝开工**并说明缺哪一环。
3. **任务图里的检查节点**（`graph.command`）：把同一命令挂成节点，让图自己拦住没有前置产物的实现：

```json
{ "id": "check-flow", "kind": "program", "action": "graph.command",
  "dependsOn": ["impl-spec"], "input": { "command": "node", "args": ["scripts/matt-flow.mjs", "<slug>", "--stage", "implement"] } }
```

注意：检查节点在工作副本里跑，`git` 与 `gh` 都可用；若该节点需要联网读 issue，
它属于「需要网络」的那类检查，按 `docs/agent/permissions-and-recovery.md` 的既有规则处理。

## 不要宣称

- 不要说「规格已经在对话里对齐了」而不落文件——**文件不存在就是没有**。
- 不要把 task 号只写在分支名或提交摘要里却不写进 commit message：闸门查的就是 commit message 与改动里的 `#<n>`。
