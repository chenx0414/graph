# Graph harness 证据与工具：2026-10-23

[返回总报告](harness-token-efficiency-2026-10-22.md) · [返回验证与证据](harness-token-efficiency-2026-10-22-verification.md)

**这一篇是"证据本身"**：每一处生产改动的红灯证据、那些证据文件在哪里、哪些脚本能重跑、怎么把报告里的提交号对上当前分支。**门禁轮次与红轮归因在[验证那一篇](harness-token-efficiency-2026-10-22-verification.md)**——那篇讲的是"跑了多少轮、哪一轮红了、为什么红"。

**每个修改都做过红灯验证**（把生产改动撤掉，E2E 必须红）——**这一条现在可以重跑了**：

```sh
node scripts/harness-red-light.mjs --out docs/planning/experiments/token-efficiency-red-light-2026-10-23.txt
```

脚本逐个把生产改动从源码里拿掉、**重建 Go 后端**（E2E 跑的是真二进制，不重建就等于没撤；改的是脚本就不用重建）、跑对应 E2E、要求它变红，再把源码放回去重建；最后把五个 E2E 一起重跑，要求全绿。**它拒绝在有未提交改动时启动**（还原用的是 `git checkout`，会丢工作）。**提交按标题查**（`scripts/report-commit-links.mjs` 同一套办法），所以 rebase 之后它自己不会过期。

录下来的那一轮在 `docs/planning/experiments/token-efficiency-red-light-2026-10-23.txt`：

| 提交 | 撤掉的是什么 | 红灯证据 |
| --- | --- | --- |
| `896c4267` 助手回合回放 | reasoning 块回到请求里 | `provider-assistant-replay` 的 openai 那条红 |
| `564b2e1f` 缓存断点 | 系统提示、工具声明、对话三处断点 | `provider-assistant-replay` 的 anthropic 那条红 |
| `4da24e67` 压缩上限 | 环境变量命名的上限 | `compaction-context-ceiling` 的"设了上限就压缩"那条红 |
| `da6b399c` 摘要输出预算 | 摘要请求用自己的额度 | `compaction-context-ceiling` 的"摘要拿到它需要的空间"那条红 |
| `ee34c3c6` 任务说明包复用 | 会话记住已读过的说明 | `task-setup-reuse` 的"开启开关"那条红 |
| `06d0be82` 来源 × 计费类型的交叉 | 每一笔花费按两个维度分开 | `harness-cost` 的 CLI 那条红 |
| `eaf21599` 工具结果落盘 | 大结果落盘成句柄 | `tool-result-spill` 的"模型拿到句柄"那条红 |

**七处全部按预期变红；还原后五个 E2E 文件 19 项全绿**（跑完一遍之后 `git diff -- backend/` 为空，源码一个字节都没变）。

**这一段在交付这一版的树上跑过两遍**（19:35 那次在 rebase 到 `4d33d34c` 之后的树上，20:38 那次在 rebase 到 `08623209`、也就是 main 把 harness 对照/知识那套重构搬进来之后的树上），结果一样：**七处全部变红，还原后 19 项全绿**，实录在 `docs/planning/experiments/token-efficiency-red-light-2026-10-23.txt`。**为什么值得反复跑**：核验这一版的人说过，他没法重跑这条证据——那需要改动分支源码。**现在它是一条命令**：读的人自己跑一遍就能知道每一处改动是不是它那条 E2E 的原因，而不是只能相信这张表。

**实录按提交标题记录，不按哈希**：rebase 会改写哈希，标题不会——**实录之前就因为这个过期过两次**，每次 rebase 之后里面那七个号都成了悬空号（核验反馈里点名的就是这个问题）。**所以实录里写的是标题**，要哈希自己查：`git log --format="%h %s" --grep="<标题>"`。**脚本仍然会查标题在不在分支上**——不在就停手，而不是写一行关于不存在的东西。

**脚本拒绝在有未提交改动时启动**：它还原源码用的是 `git checkout`，带着未提交的改动跑会把改动抹掉。这一点本轮被验证到了：改完脚本立刻跑，它自己拦下来了。

## 证据与工具

**进仓的证据**（都能在仓库里找到，可以重跑复核）：

- `docs/planning/experiments/token-efficiency-prefix-counterfactual-2026-10-22.json` — §5.6 真实请求序列推演的逐项账本（由下面的脚本生成）
- `docs/planning/experiments/token-efficiency-ab-one-turn-2026-10-23.json` — §5.7 重跑的 **12 次运行逐次原始账本**（花费、token、前缀、压缩次数、行为检查结果）
- `docs/planning/experiments/token-efficiency-ab-long-session-2026-10-23.json` — §5.8 长会话组的逐次原始账本
- `docs/planning/experiments/token-efficiency-red-light-2026-10-23.txt` — 红灯验证的实录（每一处生产改动撤掉之后，哪一条 E2E 变红了）
- `docs/planning/harness-token-efficiency-2026-10-22-kernel.md` — 内核版本追踪（这一段原本在这一篇里，单独成篇）

**能重跑的工具**：

- `scripts/harness-cost.mjs` — 只读快照计量（请求数、计费类型、**来源 × 计费类型的交叉**、用途、前缀分布、整树情景计价、压缩次数、工具错误归属）

**错误文本不在账本里，要查它在持久记录里**（§2.7 那 11 条就是这么查出来的）：

```sh
node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/Library/Application Support/Graph/state/tasks.sqlite",{readOnly:true});
for(const n of ["Plugin helper is closed","Pi host channel closed","Runtime is closed"]){
  const rows=db.prepare("select record from graph_durable_entries where record like ?").all("%"+n+"%");
  const kinds={}; for(const r of rows){const k=JSON.parse(r.record).kind; kinds[k]=(kinds[k]||0)+1;}
  console.log(n, rows.length, kinds);
}'
```

**每一种消息按记录种类分组之后，"来自哪条路径"自己就显出来了**：`pi.tool-result` 是工具结果，`graph.legacy-history` 与 `graph.imported-history` 是导入的历史。
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

**提交（改动）**：`896c4267`（助手回合回放）、`564b2e1f`（缓存断点）、`4da24e67`（压缩上限）、`e8d8db21`（成本计量）、`da6b399c`（摘要输出预算）、`ee34c3c6`（任务说明包复用）、`eaf21599`（工具结果落盘与句柄）、`fee2a692`（压缩次数计数）、`b8a99fdf`（接缝可测的开关）、`2083a564`（一次两个工具调用的覆盖）、`2b22abc5`（按模型的工具错误归属）
**提交（记录）**：`8ec7a1cc`（地图、基线、排序）、`b4690862`（A/B 脚本）、`9ea0657a`（长会话）、`dd640ed8` 与 `c26bfc9e`（接缝幅度的更正）、`c43648c6`（提案与已核对项）
**新 E2E**：`tests/e2e/provider-assistant-replay.test.ts`（助手回合回放，含一次两个工具调用）、`tests/e2e/compaction-context-ceiling.test.ts`（压缩上限）、`tests/e2e/task-setup-reuse.test.ts`（任务说明包复用）、`tests/e2e/tool-result-spill.test.ts`（工具结果落盘与句柄）
**新夹具**：`tests/fixtures/anthropic-server.ts`
