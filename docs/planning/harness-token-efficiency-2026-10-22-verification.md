# Graph harness 验证与证据：2026-10-23

[返回总报告](harness-token-efficiency-2026-10-22.md)

## 10. 验证

**完整门禁**：`node --run check` 在 `feature/harness-token-efficiency-2026-10-22` 上——**298 个测试文件 / 1,565 项，1,561 过、4 跳过、0 失败，退出码 0**。跑了两次，两次都绿：

| 那轮 | 结果 | 耗时 |
| --- | --- | ---: |
| 2026-10-23 16:25（rebase 前） | 298 文件 / 1,565 项，1,561 过、4 跳过、0 失败 | 548 秒 |
| 2026-10-23 16:45（rebase 到 `main` 的 `3f4a1770` 之后） | 同上 | 610 秒 |

**两轮都慢，是因为机器上同时还有两个 worktree 在跑门禁**（共享队列把三次检查排成了一列）。套件基线从 294 文件 / 1,556 项抬到 298 / 1,565——**多出来的 4 个文件和 9 项就是本分支新增的 E2E**。

**2026-10-22 那轮门禁唯一红的那一项，现在已经绿了，而原因不在本分支**：红的是 `tests/e2e/pig-kernel-update.test.ts :: the updater pins the kernel in an isolated checkout...`。这项测试把内核钉到**最新发布版**（PiG v0.5.3），而写报告时模块代理上**还没有** `extensions/sdk v0.5.3`（只有 v0.2.0、v0.3.0、v0.3.1、v0.4.0、v0.4.1、v0.5.0、v0.5.1、v0.5.2），`go mod tidy` 因此 404。

**上游在 2026-10-23T05:12:06Z 补发了 `extensions/sdk v0.5.3`（tag `extensions/sdk/v0.5.3`）**，同一份测试现在 2/2 全绿（12.2 秒）。所以那是一条**约 24 小时的上游空窗**，不是回归，也不是仓库缺陷——上一版报告里"内核更新器的'钉到最新'这条路现在是断的"这句话**已经不成立**，按实测改写在这里。

仓库钉的仍是 v0.5.1（`node scripts/pig-kernel-update.mjs` 报 `pinned: v0.5.1` / `latest: v0.5.3`），本分支对 `backend/go.mod`、`backend/go.sum` 与 `scripts/pig-kernel-update.mjs` **零改动**（`git diff main...HEAD -- backend/go.mod backend/go.sum scripts/pig-kernel-update.mjs` 为空）。

**两轮红过的门禁，原因是机器被压垮而不是改动**：

| 那轮 | 结果 | 原因 |
| --- | --- | --- |
| 2026-10-22 22:40 | 96 项 / 39 个文件红 | 与另一个会话的整轮门禁同时跑，那轮耗了 1,467 秒（平时 200–350 秒），机器上有 47–49 个 vitest 进程、可用内存 384MB、swap 已用 3.9GB |
| 2026-10-22 23:55 | 1 项红（`tests/m8/conversation.test.ts` 一个 15 秒超时） | 同上，那轮耗了 1,047 秒 |

**两轮里没有一项失败是本分支新增的测试**；抽出的失败文件隔离重跑全过（`tests/e2e/command-output-preservation` + `tests/m4/merge` + `tests/m8/startup` + `tests/m1/recovery` 共 30 项；`tests/m8/conversation` 23 项）。类型检查、lint、验收证据检查单独重跑也都通过。

**真实模型 A/B**（§5）：command-goat 订阅内、边际费用 0 的模型，Go 后端，独立行为检查，四组共 30+ 次运行。接缝开/关各 11 轮 big-output 任务，**花费差 −1.7%（t=−0.10，测不出）、质量 22/22 全过**；两个 flag 在短任务上是 null 结果，8,192 的激进上限是负结果；21 轮长会话里说明包复用让缓存读取 −17.6%。

**最后又在本分支当前的代码上重跑了两组，逐次原始账本进了仓库**（[§5.7 一轮 n=6/组 12 次运行、§5.8 八轮 n=2/组 6 次运行](harness-token-efficiency-2026-10-22-ab-rerun.md)，**18/18 通过行为检查**）：**前缀 −18.2%（t=−2.13，显著）/ −25.2%（八轮）**，一轮那组**未缓存输入 +40.4%（t=+2.40，显著）**、花费 +14%（t=+1.30，测不出），八轮那组未缓存输入 −16.0%、花费 −12.2%（n=2，区间太宽）。这两组第一次把接缝的机制量了出来——它省的是前缀，顺手把省下的字节从缓存桶挪进了未缓存桶，**钱的净效果取决于模型回读多少**。

**每个修改都做过红灯验证**（把生产改动撤掉，E2E 必须红）：

| 提交 | 红灯证据 |
| --- | --- |
| `496017be` 助手回合回放 | 撤掉后 OpenAI 与 Anthropic 两条 E2E 都红（reasoning 不在下一轮请求里）；只撤掉"工具块索引"这一处，两条 reasoning 断言同样红 |
| `5dfaa2f4` 缓存断点 | 撤掉后 Anthropic E2E 的三个断点断言红 |
| `47bc0701` 压缩上限 | 撤掉后"设了上限就压缩"那条红，"没设上限不压缩"那条始终绿 |
| `8153fccf` 摘要输出预算 | 撤掉后摘要请求带的是模型整个上限（8192 而不是它自己的额度） |
| `1b323d24` 任务说明包复用 | 打断复用逻辑后"开启开关"那条 E2E 红，"关闭开关"那条始终绿 |
| `7072a98c` 工具结果落盘 | 撤掉接缝后大输出直接内联，E2E 的"模型拿到句柄"断言红 |

**还欠着的**：三个杠杆在**生产形状的负载**（长会话、上下文接近窗口）上的钱仍然没有测出来——本轮所有 A/B 都在脚本化任务上跑，而短任务里缓存读取只占花费的 8%；8 轮长会话那组上下文只到 16–34K，离生产的 496K 还差一个数量级。**接缝那一项还多欠一条**：它在"模型把落盘内容读回来"时会把缓存字节变成未缓存输入（§5.7），这个转换在生产负载上有多大，取决于模型实际会不会回读——**这一点本轮没有量**。这是下一轮该做的事（§5.2 的"负载形状"一节）。

## 附：证据路径

**进仓的证据**（都能在仓库里找到，可以重跑复核）：

- `docs/planning/experiments/token-efficiency-prefix-counterfactual-2026-10-22.json` — §5.6 真实请求序列推演的逐项账本（由下面的脚本生成）
- `docs/planning/experiments/token-efficiency-ab-one-turn-2026-10-23.json` — §5.7 重跑的 **12 次运行逐次原始账本**（花费、token、前缀、压缩次数、行为检查结果）
- `docs/planning/experiments/token-efficiency-ab-long-session-2026-10-23.json` — §5.8 长会话组的逐次原始账本

**能重跑的工具**：

- `scripts/harness-cost.mjs` — 只读快照计量（请求数、计费类型、用途、前缀分布、整树情景计价、压缩次数、工具错误归属）
- `scripts/harness-prefix-counterfactual.mjs` — 真实请求序列上的前缀推演：

  ```sh
  node scripts/harness-prefix-counterfactual.mjs \
    "$HOME/Library/Application Support/Graph/state/tasks.sqlite" \
    --conversation 3303 --task 52e92a78-9139-4cb1-9a2a-ab2bc822ac3a \
    --out docs/planning/experiments/token-efficiency-prefix-counterfactual-2026-10-22.json
  ```

- `scripts/harness-ab-eval.mjs` — Go 后端 + 真实 provider + 独立行为检查；`GRAPH_AB_OUT=<path>` 把逐次账本写出来，`GRAPH_AB_KEEP=1` 保留每次运行的目录
- `scripts/report-commit-links.mjs` — rebase 之后把本报告引用的提交号重指向当前分支（找不到对应提交就报错，不猜）

**不进仓的中间产物**（只读快照，可随时重生成）：

- 基线快照：`node scripts/harness-cost.mjs "$HOME/Library/Application Support/Graph/state/tasks.sqlite" > /tmp/graph-harness-baseline-2026-10-22.json`
- 扩展后的基线（含前缀分布、用途、整树情景）：同命令，`/tmp/baseline-v2.json`

**提交（改动）**：`496017be`（助手回合回放）、`5dfaa2f4`（缓存断点）、`47bc0701`（压缩上限）、`f328ca31`（成本计量）、`8153fccf`（摘要输出预算）、`1b323d24`（任务说明包复用）、`7072a98c`（工具结果落盘与句柄）、`b8fbe2fc`（压缩次数计数）、`aebbd9e2`（接缝可测的开关）、`694ee09c`（一次两个工具调用的覆盖）、`dbdb4910`（按模型的工具错误归属）
**提交（记录）**：`ed62880a`（地图、基线、排序）、`426fcb95`（A/B 脚本）、`2f212079`（长会话）、`6eeaca67` 与 `d31eeb28`（接缝幅度的更正）、`c35dd513`（提案与已核对项）
**新 E2E**：`tests/e2e/provider-assistant-replay.test.ts`（助手回合回放，含一次两个工具调用）、`tests/e2e/compaction-context-ceiling.test.ts`（压缩上限）、`tests/e2e/task-setup-reuse.test.ts`（任务说明包复用）、`tests/e2e/tool-result-spill.test.ts`（工具结果落盘与句柄）
**新夹具**：`tests/fixtures/anthropic-server.ts`
