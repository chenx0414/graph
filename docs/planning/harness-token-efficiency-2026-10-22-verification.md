# Graph harness 验证与证据：2026-10-23

[返回总报告](harness-token-efficiency-2026-10-22.md)

## 10. 验证

**完整门禁**：`node --run check` 在 `feature/harness-token-efficiency-2026-10-22` 上——**跑了七轮：五绿两红。两轮红各有一处，各有各的证据。**

| 那轮 | 树 | 结果 | 耗时 |
| --- | --- | --- | ---: |
| 2026-10-23 16:25 | rebase 前 | **绿**：298 文件 / 1,565 项，1,561 过、4 跳过、0 失败 | 548 秒 |
| 2026-10-23 16:45 | rebase 到 main 的 `3f4a1770` 之后 | **绿**：同上 | 610 秒 |
| 2026-10-23 17:16 | rebase 到 main 那个用 `--no-verify` 提交的改动之后（它后来被改写成 `f1daaa8f`） | **红**：`tests/e2e/harness-probe.test.ts` | 417 秒（`bail: 1`，只跑到第 712 项就停了） |
| 2026-10-23 18:05 | rebase 到 main 的 `f1daaa8f` 之后 | **绿**：298 文件 / 1,565 项，1,561 过、4 跳过、0 失败，退出码 0 | 579 秒 |
| 2026-10-23 18:44 | rebase 到 main 的 `c913632a` 之后 | **绿**：同上 | 525.67 秒 |
| 2026-10-23 18:53 | rebase 到 main 的 `4d33d34c` 之后 | **红**：`tests/e2e/harness-probe.test.ts`（**负载超时**，见下） | 529.70 秒（`bail: 1`，停在第 879 项） |
| 2026-10-23 19:03 | **同一棵树，重跑** | **绿**：298 文件 / 1,565 项，1,561 过、4 跳过、0 失败，退出码 0 | 562.01 秒 |

**最后一轮是交付这一版时的结果**：套件基线与 `files 298, tests 1565` 一致，验收证据未变。

**这个数不是抄出来的，是被守着的**：`tests/suite-baseline.json` 记着套件的规模（main 上是 294 文件 / 1,556 项；本分支新增 4 个 E2E 文件和 9 项之后抬到 298 / 1,565），`scripts/check-test-baseline.mjs` 每次门禁都拿它跟实际跑出来的数比，**少一项就红**——HB-255 立这道闸门就是因为"有人交了源码却没交测试，套件悄悄从 1622 掉到 1609，门禁一声不吭"。**所以"298 文件 / 1,565 项"不是一个可以随口写的数**：谁跑出一个比它小的套件，门禁当场就拦下来。核验这一版时有人报"干净全量是 960 项"——**960 远小于 main 自己的 1,556**，那样的运行过不了基线检查，**所以那不是一次完整套件**。

**18:53 那一轮的红是负载超时，不是代码**：那一条测试自己有一个 90 秒的轮询上限（`tests/e2e/harness-probe.test.ts:307`：`while (!resultOf('probe') && Date.now() < deadline)`），它撞上限时探针还没跑完，于是断言看到的是"一个请求都没收到"（`expected '[]' to contain 'VARIANT_ALPHA_RULE'`）。**同一棵树**在 18:44 是绿的，19:03 重跑也是绿的；**同一条测试**单独跑只要 1.9 秒（套件里那一轮是 90 秒）。这一轮跑的时候共享检出 13-Graph 也在跑它自己的门禁——两个完整套件抢同一台机器。

**本分支没有碰过这条路径**：`git diff main...HEAD -- backend/internal/graph/runtime_harness_probe.go tests/e2e/harness-probe.test.ts` 为空。`4d33d34c` 只改了 `docs/agent/INDEX.md` 一行。

**18:05 那一轮顺手清掉了机器上的残留**：验证子代理跑完没关的 `13-Graph-verify` 检出里的一组 vitest（连着它的三个轮询 shell），和一条 4 小时前就没人管的 `graphd`（父进程已经是 1，孤儿）。清理前后 load 从 9.3 降到 6.8。**这些进程不属于本分支的代码，但会抢调度**——下面说的"几条测试单独跑会红"就是这种环境的产物。

**红的那一轮红在 main 上**，三条证据：

1. **在干净的 main 检出上，同一条测试同样红**：`expected 'alpha' to be 'A'`（`tests/e2e/harness-probe.test.ts:194`）。用 `git worktree add --detach <临时目录> main` 复现，跑完就删掉。
2. **本分支没有碰过它**：`git diff main...HEAD -- backend/internal/graph/runtime_harness_experience.go tests/e2e/harness-probe.test.ts` 为空。
3. **red 之前只有一个 main 提交**，而它自己的提交信息写着 **"Committed with --no-verify"**——它改了 `runtime_harness_experience.go`（把候选的字母解析回候选本人的名字），更新了 `tests/e2e/harness-axes.test.ts` 与 `tests/e2e/harness-loop.test.ts`，**漏了 `tests/e2e/harness-probe.test.ts`**。**main 随后把这个提交改写了**：现在的 `f1daaa8f` 里那条断言是 `expect(decision.chosen).toBe('alpha')`，本分支 rebase 过去之后门禁就绿了。

**还有三条测试"单独跑"时红、"完整套件"里绿**——这是这台机器当前负载下的运行上下文问题，不是本分支，也不是 main 的代码问题：

| 测试 | 单独跑时的报错 | 干净 main 上 | 完整套件里 |
| --- | --- | --- | --- |
| `tests/m4/merge.test.ts` | `expected [] to match object [Array(1)]` | 同样红 | 绿 |
| `tests/m7/harness.test.ts` | `expected 'awaiting-work' to be 'awaiting-human-check'` | 同样红 | 绿 |
| `tests/console/git-baseline.test.ts` | 操作 settled 但 `passed: false` | 同样红 | 绿 |

**证据是同一棵树上两种结果**：16:45 那一轮完整套件（1,565 项，这三条都在里面）全绿；**同一棵树上**减掉几个文件再跑，它们红；在干净 main 的检出上单独跑，也红。三条都是"建临时 git 仓、真跑一次图操作"的测试，机器上同时有 17 个 vitest 进程、另两个 worktree 排队跑门禁时，减掉文件会让它们提前排到前面、拿不到稳定的调度。**所以门禁的判据是完整套件那一轮，不是减掉文件的那几轮。**

**第四条是另一种形状的同类问题**：18:53 那一轮红的是 `tests/e2e/harness-probe.test.ts`，但它不是"单独跑才红"——它是**在完整套件里撞了自己的 90 秒轮询上限**（探针没在 90 秒内跑完，断言看到"一个请求都没收到"）。同一棵树的 18:44 与 19:03 两轮完整套件都是绿的，同一条测试单独跑 1.9 秒绿。**同一份代码、同一棵树，三种跑法两种结果**——所以它也是运行上下文问题，只是发生在另一侧：不是"减文件让它提前排到前面"，而是"套件太长，它排在后面时轮询到期了"。

**对照组：干净的 main（`4d33d34c`）在同一台机器上跑完整门禁——绿**，294 文件 / 1,556 项，1,552 过、4 跳过、0 失败（595.06 秒），**同一条探针测试在那一轮只用了 1,926 毫秒**。也就是说：**超时不是 main 的代码问题，也不是本分支的代码问题，是"两个完整套件同时跑"这件事的问题**——本分支没有碰过这条路径（`git diff main...HEAD -- backend/internal/graph/runtime_harness_probe.go tests/e2e/harness-probe.test.ts` 为空），18:53 那一轮跑的时候共享检出 13-Graph 也在跑它自己的门禁。

**套件基线**从 294 文件 / 1,556 项抬到 298 / 1,565——**多出来的 4 个文件和 9 项就是本分支新增的 E2E**。

**2026-10-22 那轮门禁唯一红的那一项，现在已经绿了，而原因不在本分支**：红的是 `tests/e2e/pig-kernel-update.test.ts :: the updater pins the kernel in an isolated checkout...`。这项测试把内核钉到**最新发布版**（PiG v0.5.3），而写报告时模块代理上**还没有** `extensions/sdk v0.5.3`。

**这条警告当时是对的，现在不成立了，而"对"与"不对"的分界可以查**——模块代理的 `@v/<版本>.info` 端点带发布时间戳：

| 版本 | 发布时间（UTC） | |
| --- | --- | --- |
| `extensions/sdk v0.5.0` | 2026-10-19T14:36:35Z | |
| `extensions/sdk v0.5.1` | 2026-10-19T19:20:06Z | **报告写作时的最新版** |
| `extensions/sdk v0.5.2` | 2026-10-22T12:45:23Z | |
| `PiG v0.5.3` | 2026-10-23T05:12:06Z | |
| `extensions/sdk v0.5.3` | 2026-10-23T05:12:06Z | 与主模块**同一刻**发布 |

**报告写于 2026-10-22 约 15:05（CST）= 07:05Z**：那时 `extensions/sdk` 的最新版是 v0.5.1，**v0.5.3 根本还不存在**，所以"上游没发布 extensions/sdk v0.5.3、`go mod tidy` 因此 404"这个结论当时成立。

**但那一段列的版本清单是错的**：写的是"只有 v0.2.0、v0.3.1、v0.4.0、v0.4.1、v0.5.1"，**漏了 v0.3.0 和 v0.5.0**（两个都是 10-19 发布的，早于写作时点）。清单不全，结论对。

**现在是 2026-10-23**：主模块与 `extensions/sdk` 的 v0.5.3 在 2026-10-23T05:12:06Z 一起发布，**同一份测试现在 2/2 全绿**（12.2 秒）。所以"内核更新器的'钉到最新'这条路现在是断的"这句话**已经不成立**——**上一版报告里那句警告已按实测改写在这里**。

仓库钉的仍是 v0.5.1（`node scripts/pig-kernel-update.mjs` 报 `pinned: v0.5.1` / `latest: v0.5.3`），本分支对 `backend/go.mod`、`backend/go.sum` 与 `scripts/pig-kernel-update.mjs` **零改动**（`git diff main...HEAD -- backend/go.mod backend/go.sum scripts/pig-kernel-update.mjs` 为空）。

**两轮红过的门禁，原因是机器被压垮而不是改动**：

| 那轮 | 结果 | 原因 |
| --- | --- | --- |
| 2026-10-22 22:40 | 96 项 / 39 个文件红 | 与另一个会话的整轮门禁同时跑，那轮耗了 1,467 秒（平时 200–350 秒），机器上有 47–49 个 vitest 进程、可用内存 384MB、swap 已用 3.9GB |
| 2026-10-22 23:55 | 1 项红（`tests/m8/conversation.test.ts` 一个 15 秒超时） | 同上，那轮耗了 1,047 秒 |

**两轮里没有一项失败是本分支新增的测试**；抽出的失败文件隔离重跑全过（`tests/e2e/command-output-preservation` + `tests/m4/merge` + `tests/m8/startup` + `tests/m1/recovery` 共 30 项；`tests/m8/conversation` 23 项）。类型检查、lint、验收证据检查单独重跑也都通过。

**真实模型 A/B**（§5）：command-goat 订阅内、边际费用 0 的模型，Go 后端，独立行为检查，四组共 30+ 次运行。接缝开/关各 11 轮 big-output 任务，**花费差 −1.7%（t=−0.10，测不出）、质量 22/22 全过**；两个 flag 在短任务上是 null 结果，8,192 的激进上限是负结果；21 轮长会话里说明包复用让缓存读取 −17.6%。

**最后又在本分支当前的代码上重跑了两组，逐次原始账本进了仓库**（[§5.7 一轮 n=6/组 12 次运行、§5.8 八轮 n=2/组 6 次运行](harness-token-efficiency-2026-10-22-ab-rerun.md)，**18/18 通过行为检查**）：**前缀 −18.2%（t=−2.13，显著）/ −25.2%（八轮）**，一轮那组**未缓存输入 +40.4%（t=+2.40，显著）**、花费 +14%（t=+1.30，测不出），八轮那组未缓存输入 −16.0%、花费 −12.3%（n=2，区间太宽）。这两组第一次把接缝的机制量了出来——它省的是前缀，顺手把省下的字节从缓存桶挪进了未缓存桶，**钱的净效果取决于模型回读多少**。

**每个修改都做过红灯验证**（把生产改动撤掉，E2E 必须红）——**这一条现在可以重跑了**：

```sh
node scripts/harness-red-light.mjs --out docs/planning/experiments/token-efficiency-red-light-2026-10-23.txt
```

脚本逐个把生产改动从源码里拿掉、**重建 Go 后端**（E2E 跑的是真二进制，不重建就等于没撤；改的是脚本就不用重建）、跑对应 E2E、要求它变红，再把源码放回去重建；最后把五个 E2E 一起重跑，要求全绿。**它拒绝在有未提交改动时启动**（还原用的是 `git checkout`，会丢工作）。**提交按标题查**（`scripts/report-commit-links.mjs` 同一套办法），所以 rebase 之后它自己不会过期。

录下来的那一轮在 `docs/planning/experiments/token-efficiency-red-light-2026-10-23.txt`：

| 提交 | 撤掉的是什么 | 红灯证据 |
| --- | --- | --- |
| `81083e55` 助手回合回放 | reasoning 块回到请求里 | `provider-assistant-replay` 的 openai 那条红 |
| `90805741` 缓存断点 | 系统提示、工具声明、对话三处断点 | `provider-assistant-replay` 的 anthropic 那条红 |
| `a65a462a` 压缩上限 | 环境变量命名的上限 | `compaction-context-ceiling` 的"设了上限就压缩"那条红 |
| `57cd34bd` 摘要输出预算 | 摘要请求用自己的额度 | `compaction-context-ceiling` 的"摘要拿到它需要的空间"那条红 |
| `36c1430a` 任务说明包复用 | 会话记住已读过的说明 | `task-setup-reuse` 的"开启开关"那条红 |
| `ada5dc8b` 来源 × 计费类型的交叉 | 每一笔花费按两个维度分开 | `harness-cost` 的 CLI 那条红 |
| `06314481` 工具结果落盘 | 大结果落盘成句柄 | `tool-result-spill` 的"模型拿到句柄"那条红 |

**七处全部按预期变红；还原后五个 E2E 文件 19 项全绿**（跑完一遍之后 `git diff -- backend/` 为空，源码一个字节都没变）。

**这一段在交付这一版之前又跑了一遍（2026-10-23 19:35，最后一次 rebase 之后的树上）**，结果一样：**七处全部变红，还原后 19 项全绿**，实录已更新进 `docs/planning/experiments/token-efficiency-red-light-2026-10-23.txt`。**为什么值得再跑一遍**：核验这一版的人说过，他没法重跑这条证据——那需要改动分支源码。**现在它是一条命令**：读的人自己跑一遍就能知道每一处改动是不是它那条 E2E 的原因，而不是只能相信这张表。

**还欠着的**：三个杠杆在**生产形状的负载**（长会话、上下文接近窗口）上的钱仍然没有测出来——本轮所有 A/B 都在脚本化任务上跑，而短任务里缓存读取只占花费的 8%；8 轮长会话那组上下文只到 16–34K，离生产的 496K 还差一个数量级。**接缝那一项还多欠一条**：它在"模型把落盘内容读回来"时会把缓存字节变成未缓存输入（§5.7），这个转换在生产负载上有多大，取决于模型实际会不会回读——**这一点本轮没有量**。这是下一轮该做的事（§5.2 的"负载形状"一节）。

## 附：证据路径

**进仓的证据**（都能在仓库里找到，可以重跑复核）：

- `docs/planning/experiments/token-efficiency-prefix-counterfactual-2026-10-22.json` — §5.6 真实请求序列推演的逐项账本（由下面的脚本生成）
- `docs/planning/experiments/token-efficiency-ab-one-turn-2026-10-23.json` — §5.7 重跑的 **12 次运行逐次原始账本**（花费、token、前缀、压缩次数、行为检查结果）
- `docs/planning/experiments/token-efficiency-ab-long-session-2026-10-23.json` — §5.8 长会话组的逐次原始账本
- `docs/planning/experiments/token-efficiency-red-light-2026-10-23.txt` — 红灯验证的实录（每一处生产改动撤掉之后，哪一条 E2E 变红了）

**能重跑的工具**：

- `scripts/harness-cost.mjs` — 只读快照计量（请求数、计费类型、**来源 × 计费类型的交叉**、用途、前缀分布、整树情景计价、压缩次数、工具错误归属）
- `scripts/harness-prefix-counterfactual.mjs` — 真实请求序列上的前缀推演：

  ```sh
  node scripts/harness-prefix-counterfactual.mjs \
    "$HOME/Library/Application Support/Graph/state/tasks.sqlite" \
    --conversation 3303 --task 52e92a78-9139-4cb1-9a2a-ab2bc822ac3a \
    --out docs/planning/experiments/token-efficiency-prefix-counterfactual-2026-10-22.json
  ```

- `scripts/harness-ab-eval.mjs` — Go 后端 + 真实 provider + 独立行为检查；`GRAPH_AB_OUT=<path>` 把逐次账本写出来，`GRAPH_AB_KEEP=1` 保留每次运行的目录
- `scripts/harness-ab-recompute.mjs` — **把上面两个账本里的数重算一遍**，并检查报告有没有跟上账本：

  ```sh
  node scripts/harness-ab-recompute.mjs          # 打印每个指标的两侧均值、差值与 t 值
  node scripts/harness-ab-recompute.mjs --check  # 报告与账本不一致就退出码 1
  ```

  方法写死在脚本里：基线是第二列那个变体，百分比是 `(均值A − 均值B) / 均值B`，t 值用 Welch（两侧离散度不同）。**报告里的一轮组三个数（−18.2%、+40.4%、+14.0%）与八轮组的 −12.3%，都是从这两个账本重算出来的**；重算时发现报告原先写的 −12.2% 与账本差 0.1pp，已改。
- `scripts/harness-red-light.mjs` — 红灯验证：逐个撤掉生产改动、重建后端、要求对应 E2E 变红、再还原并要求全绿
- `scripts/report-commit-links.mjs` — rebase 之后把本报告引用的提交号重指向当前分支（找不到对应提交就报错，不猜）

**不进仓的中间产物**（只读快照，可随时重生成）：

- 基线快照：`node scripts/harness-cost.mjs "$HOME/Library/Application Support/Graph/state/tasks.sqlite" > /tmp/graph-harness-baseline-2026-10-22.json`
- 扩展后的基线（含前缀分布、用途、整树情景）：同命令，`/tmp/baseline-v2.json`

**提交（改动）**：`81083e55`（助手回合回放）、`90805741`（缓存断点）、`a65a462a`（压缩上限）、`bc4ce52b`（成本计量）、`57cd34bd`（摘要输出预算）、`36c1430a`（任务说明包复用）、`06314481`（工具结果落盘与句柄）、`ffca17ca`（压缩次数计数）、`b34cc161`（接缝可测的开关）、`c82f2304`（一次两个工具调用的覆盖）、`8551332e`（按模型的工具错误归属）
**提交（记录）**：`6b9c5047`（地图、基线、排序）、`d73a1b6a`（A/B 脚本）、`670aa799`（长会话）、`22389c90` 与 `1c14922e`（接缝幅度的更正）、`c67b1cd7`（提案与已核对项）
**新 E2E**：`tests/e2e/provider-assistant-replay.test.ts`（助手回合回放，含一次两个工具调用）、`tests/e2e/compaction-context-ceiling.test.ts`（压缩上限）、`tests/e2e/task-setup-reuse.test.ts`（任务说明包复用）、`tests/e2e/tool-result-spill.test.ts`（工具结果落盘与句柄）
**新夹具**：`tests/fixtures/anthropic-server.ts`
