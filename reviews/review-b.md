# 车道 b 评审报告（review-b，形状 A：评审即路由器）

- 节点：`review-b`（agent 路由器，routes = `["pass", "fail"]`，`input.route.declared = null`，即本节点自主判定）
- 模型：`opencode-go:space-bunny-free`
- 被评对象：`impl-b` operation `88905311-4b97-4db4-8f88-2d22fbee8493` 的产出
- 评审对象文件：`scripts/diag-b.mjs`，sha256 `7654b9dd2445b238d25e9fe514592e9d48736f672a78d29fd64a317389ee57fa`（214 行）
- 评审工作树 HEAD：`c332da9`（merge 后含车道 b 的提交 `548c14f`）
- **判定：pass**

## 结论

impl-b 的交付（`scripts/diag-b.mjs`）满足全部三条 lookFor，且其报告里所有关键声明都被我独立复现。
无阻断项。

## lookFor 逐条核验（全部独立复跑，证据在本报告第 3 节）

### 1. 只读、只用 node 内置模块 —— 成立
- 导入面仅 4 条，全部是 `node:` 内置模块：
  `node:fs/promises`（readFile/readdir/stat）、`node:fs`（realpathSync）、`node:path`、`node:url`。
- 全文件无任何变更类 API：`writeFile|appendFile|unlink|rm|rmdir|mkdir|rename|createWriteStream|chmod|truncate|process.chdir|writeSync` 匹配数为 **0**。
- `package.json` 无 `diag-b` 入口，无新依赖；`git diff -- package.json` 为空。
- **实测只读**：对整个工作树（排除 `.git`/`node_modules`）逐文件 sha256 再整体 sha256，跑过 `diag-b`（表格/`--json`/`--help` 各一次）前后指纹**逐字节相同**
  （`43ad52015ee39ce5bc420d2a4f2d95e384d3da789cb1427e3b4ad7cb5e4f7442`），且 `git status --porcelain` 输出 0 行。

### 2. 只新增这一个文件、未改动任何现有文件 —— 成立
- `git show --stat 548c14f` = `scripts/diag-b.mjs | 214 +++`（1 file changed, 214 insertions），纯新增。
- `git show --name-only 548c14f` 只列出 `scripts/diag-b.mjs`。
- 该车道合并后（`c332da9`）与合并前（`ceb56e9`）在本评审相关面 **无差异**（见第 3 节说明）。
- 注：同一个 merge-base 作用域提交 `ceb56e9` 里出现的 `reviews/review-c.md` 与 `scripts/diag-c.mjs` 属于**车道 c**（作者/归属不同），不是车道 b 的产物；车道 b 自己的提交只有 `scripts/diag-b.mjs` 一个文件。

### 3. 统计结果正确、运行可重复 —— 成立
- **独立重算**：我另写了一个与 impl-b 无关的遍历脚本（`/tmp/rev-b-walk.mjs`），对 `src/` 重算得
  `{files:196, lines:54175, bytes:2668294, skipped:2}`，与 `diag-b` 的 `--json` 输出**完全一致**
  （catalog 15/2550、core 44/14075、git 3/1382、runtime 55/13477、server 16/4738、web 63/17953，total 196/54175）。
- **可重复**：连续 3 次表格运行输出 sha256 三次相同（`4ab12adb2e17edcc…`）；两次 `--json` 输出**逐字节相同**，stderr 均为 0 字节，exit 0。
- **语义正确（手工 oracle）**：自建 fixture（含尾随换行、无尾随换行、空文件、嵌套目录、3 个非源码文件）得
  `core 4/6`、`runtime 1/1`、`web 1/1`、`total 6/8`、`skipped 3`，与 impl-b 报告的手算 oracle 完全吻合；
  空文件计 0 行、无尾随换行的 `1\n2` 计 2 行，均正确。
- **边界正确**：符号链接指向的目录不被下潜（自建环 `m/a/loop -> m` 能正常终止，exit 0，不会死循环）、符号链接指向的文件不被重复计数；
  直接放在 target 根下的源码文件归入 target 自身名（`t` 1 文件）。
- **错误路径**：`--target /nope`、`--nope`、`--target`（缺值）三者均单行 stderr（前缀 `diag-b: `）且 exit 1，无堆栈、无部分表格。
- **symlink 调用**：经 `/tmp/rev-b-link.mjs` 软链接调用仍正确测量真实 `src/` 并 exit 0（无「静默空输出」缺陷）。
- **仓库门禁**：`node --run typecheck`、`node --run lint` 均 exit 0。

## 红线复核（共享测试标准）

- **R23（E2E + 可复跑产物）**：impl-b 提供的是黑盒 E2E 测试装置（`deliverables/diag-b-e2e-harness`，从不 import 被测对象，只跑子进程断言 stdout/stderr/exit），
  我**亲自复跑**该装置：31/31 ALL PASSED，exit 0。
- **R22（先红后绿）**：在一个不含 `scripts/diag-b.mjs` 的副本上复跑同一装置，得到 **6 passed / 8 failed**，
  失败原因是 `Cannot find module '.../scripts/diag-b.mjs'`（正确的失败原因），且残留的 6 个通过项全是不触及被测对象的错误路径判定与 typecheck/lint。
  证实装置是**有判别力**的、非同义反复。
- **R27（层次）**：采用黑盒 E2E（子进程 + 独立 oracle），未依赖被测实现细节，符合首选层次。

## 非阻断观察（不改变 verdict）

1. **元数据小漂移（不属 impl-b 责任、不影响结论）**：`deliverables/diag-b-e2e-harness` 制品记录的摘要文本里写明
   `sha256 42309a8a4d3af7df20cc1640c3fb62c03f1a845750eed7e7275b648c9167c0bb`，但该制品实际内容 sha256 为
   `7062b8ad4a27645bf7778519271699b0a8cd175c86ce7953adde377b98ecf95f`。报告正文（`deliverables/diag-b-report`）引用的
   `7062b8ad…` 才是正确值；差异仅在制品 metadata 摘要字段，且是两个不同制品命名空间（impl-b 前后两轮）的措辞遗留。
   我复跑用的是实际字节，31/31 结果不受影响。**给 merge / 后续引用者的提醒：以实际字节 digest 为准。**
2. **`node --run check` 在本检出为红**：42 failed files / 128 failed tests，`diag-b` 在日志中出现 0 次；
   把 `scripts/diag-b.mjs` 移出后重跑，失败文件集合 `diff` 为空——**红是既存环境问题，与本车道无关**。
   这是 **full-tests 节点的预期输入**：整合副本若 `node_modules` 完好，应以「三车道是否改变失败文件集合」而非「红/绿」为判据。

## 上游依赖与本节点的自洽性说明

- 本评审只依据冻结证据（impl-b 的 `evidence_only` 交接、其发布的 3 份制品）与我在**本评审工作树**内对**同一份被评字节**（sha256 `7654b9dd…`）的只读复跑；
  未检视实现者转录，未改动任何实现文件。
- 本评审自身产出交付物即本文件：`reviews/review-b.md`（同时发布为 namespace `reviews` / name `review-b`），非空，符合「评审必须写报告，不能空口放行」的约束。

## verdict：pass

三条 lookFor 全部成立，测试标准无违规，无阻断项。本车道的验收项 `b-pass` 成立，路由判 **pass**。
