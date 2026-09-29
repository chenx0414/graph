# 独立审查：车道 a —— `scripts/diag-a.mjs` —— pass

- 审查节点：`review-a`（agent 路由器，`routes ['pass','fail']`，`input.route.declared=null`）
- 审查对象：impl-a 提交 `d1d954a`（`graph:impl-a:b2c36132-…`），父提交 `7165551`；`scripts/diag-a.mjs` 的 blob 自该提交到当前 HEAD `bf47906` 未变；本审查工作副本 `git status --porcelain` 仅 `M reviews/review-a.md`（即本报告自身）
- 审查依据：impl-a 交付件 `graph://tasks/a621e9d6-…/artifacts/deliverables/impl-a-diag-a@1`（digest `c1bf4103…`）与 impl-a→review-a 私信
- 结论：**pass** —— 5 条 lookFor 全部成立，**0 个阻塞项**，2 条非阻塞发现（其中 1 条禁止 merge 原样抄进 README），另附 1 条**不属于本车道但会卡死下游 `full-tests`** 的图级风险

> **第 2 轮增补（同一会话，operation `b2c36132`）**：车道 a 的 5 条 lookFor 在合并后的 HEAD `f3d0ced`（已含 impl-b/impl-c）上**复跑全部仍成立**，数字仍是 `218 / 1431`，三个 diag 脚本合跑对 1028 个文件零改动。门禁复跑：`typecheck` / `lint` / `check:evidence` 全 0，`test` 仍红（42 文件 / 128 用例）—— 但 §4 已被本轮用 **A/B 对照证明**重写：根因是工作副本 `node_modules` 软链，不是代码，且 `integration` 副本**根本没有 `node_modules`**。**第 1 轮 §4 的猜测性结论与「让 merge 去确认基线」的建议作废。**

> **第 3 轮复核（同一会话再次返工，HEAD `bf47906`，已含 review-b/review-c 的报告文件）**：判定不变，仍为 **pass**，0 阻塞项。
> 车道 a 的 5 条 lookFor 在新 HEAD 上**逐条重跑仍全部成立**，且 `scripts/diag-a.mjs` 的 blob 从车道提交到 HEAD **一字节未变**（`8a4185ba…` == `8a4185ba…`），数字仍是 `218 / 1431`（`find`/`grep` 独立复算吻合，连跑 3 次同摘要）。三个 diag 脚本合跑对 **1030** 个文件零改动。
> 门禁复跑：`typecheck` / `lint` / `check:evidence` 全 0；`test` 仍红（42 文件 / 128 of 1468）。

> **第 4 轮复核（HEAD `640199f`，已并入 review-b 的 `reviews/review-b.md`）**：判定不变，仍为 **pass**，0 阻塞项。
> 车道 a 的 5 条 lookFor 在新 HEAD 上**逐条重跑仍全部成立**，`scripts/diag-a.mjs` 的 blob 仍是 `8a4185ba…`（车道提交 / HEAD / 工作副本三处一致）；数字仍是 `218 / 1431`（`find`/`grep` 独立复算吻合，连跑 3 次同摘要 `7dae6b3d…`）。三个 diag 脚本合跑对 1030 个文件的指纹 diff 为空。
> 门禁复跑：`typecheck` / `lint` / `check:evidence` 全 0；`test` 1（42 文件 / 128 of 1468）。
> 本轮 A/B 对照**独立复现**为 42/128 → **4/4**，基线提交 `7165551` 同样 4/4 且报错逐字相同。
> 本轮修正并补充两点：(a) 上一轮探针记录的 5/5 中，第 5 个（`tests/m8/settings-ui.test.ts`）经证是我自己**并发跑两套 vitest** 造成的负载抖动，单独复跑 4 次全绿（探针 3/3、工作副本 1/1），不是缺陷，真实基线是 4；(b) §4.5 的阻塞比上轮记录的**更早也更硬** —— `integration` 副本上不仅 `typecheck`，`node --run test` 同样在第一步就 `vitest: command not found`（真实退出码 1）。详见 §8。
> 本轮把 §4 的归因**从「已证明与车道无关」升级为「已证明是既有的环境基线」**：A/B 对照本轮为 128 → **4**，且这 4 个在**车道之前的基线提交 `7165551`** 上用同样的硬链接依赖**同样失败**（`Test Files 4 failed (4)`），因此它们与三个 diag 车道无因果关系、也不是本任务能修的代码缺陷。`integration` 副本仍然没有 `node_modules`（`tsc: command not found`），§4.5 的死锁风险**今天依然成立**。详见 §4.3 / §4.5 / §7。

---

## 0. 审查对象绑定

```
$ git show --name-status --format='%H %s' d1d954a
d1d954a994fef59d1f1ea67dd2bd3367ad722e98 graph:impl-a:b2c36132-2b79-4271-96a2-858acbf83a34
A	scripts/diag-a.mjs

$ git diff --name-status 7165551 d1d954a
A	scripts/diag-a.mjs            # 55 insertions, 0 deletions
```

车道提交恰好等于「新增 `scripts/diag-a.mjs` 一个文件」，没有任何既有文件的 M/D/R。

---

## 1. lookFor 逐条核对

### 1.1 脚本是否只读 —— 成立（两路独立取证）

**静态取证**：`scripts/diag-a.mjs` 全文 55 行，对写/执行类 API 做穷举扫描，命中数为 0：

```
$ grep -nE "writeFile|appendFile|mkdir|rm\(|unlink|rename|createWriteStream|copyFile|chmod|truncate|spawn|exec|process\.exit|process\.env" scripts/diag-a.mjs
（无输出）
```

全文只 import `node:fs/promises` 的 `readdir/readFile`、`node:path`、`node:url`，唯一的副作用是末尾 `console.log`。

**动态取证**：对 1025 个文件（排除 `.git`、`node_modules`）做 `path + size + mtime` 指纹，跑脚本前后逐行 diff：

```
$ fp > /tmp/rev-a-fp-before.txt && node scripts/diag-a.mjs && fp > /tmp/rev-a-fp-after.txt
$ diff /tmp/rev-a-fp-before.txt /tmp/rev-a-fp-after.txt && echo "NO CHANGES"
NO CHANGES: script is read-only      # 1025 files fingerprinted

$ git status --porcelain
（空）                                  # 未留下任何未跟踪残留
```

**结论**：只读成立，且是「跑完之后工作副本逐字节不变」这一级别，不只是看代码。

### 1.2 是否只用 node 内置模块 —— 成立

三个 import 全部是 `node:` 协议内置模块。`package.json` / `pnpm-lock.yaml` 在 `7165551..d1d954a` 的 diff 中不存在（见 §0 的 name-status），即没有新增任何依赖。

### 1.3 是否确实只新增了这一个文件、未改动任何现有文件 —— 成立

见 §0。补充一条零耦合取证：全仓检索 `diag-a` 只有两处命中，都在 `tests/m2/verification.test.ts:229,235`，且是**伪造载荷里的字符串字面量**（`files: ['scripts/diag-a.mjs']` 出现在构造出来的 multiview `correctness` 维度里），从不读取真实文件。因此该脚本对现有测试与产品代码零影响。

### 1.4 统计结果是否正确 —— 成立（含一处被证伪的注释，见 §2.1）

**独立复算（不复用脚本任何逻辑）**：

| 口径 | 独立复算 | diag-a 输出 |
| --- | --- | --- |
| test 文件（`*.test.*`/`*.spec.*`，排除 `.git`/`node_modules`） | `find` = **218** | 218 ✅ |
| 声明行（`^\s*(it\|test)(\.\w+)*\s*[(`]`） | `grep -rhE` = **1431** | 1431 ✅ |

两个数字都由与脚本不同的工具（`find` / `grep`）独立算出并完全吻合。

**与真实测试运行器交叉核对**（决定性证据，见 §4）：

```
$ node --run test
 Test Files  42 failed | 175 passed (217)
      Tests  128 failed | 1340 passed (1468)
```

- 静态声明 1431 与运行时 1468 的差 **+37** 已被完整解释为 `test.each` 展开，不是误计。单文件验证：`tests/m0/pi-instance.test.ts` 有 14 条声明、其中 1 条 `test.each(['write','crash'])` 2 行 → 运行时 `Tests 15 passed (15)`，即 13×1 + 1×2 = 15，**声明数是运行时用例数的正确下界**。全仓 17 条 `.each` 展开后多出 39 条（多出的 2 条来自 fixture 之外的口径差，见下），量级自洽。
- 声明行正则 `/^\s*(?:it|test)(?:\.\w+)*\s*[(`]/` 不会误吞 `it: 5,`（`:` 不在字符类里）、不会误吞 `await it(...)`（行首不符），逐行 `split('\n')` 后应用故无跨行误判；`describe` 不计入，与脚本自述定义一致。

**自述定义与实现的对应**：脚本头注释声明的口径是「文件名以 `.test.<ext>`/`.spec.<ext>` 结尾」+「文件内以 `it`/`test` 开头的声明行」。实现（`TEST_FILE` / `TEST_CASE` 两个正则 + `collectTestFiles`）与该定义**逐字一致**，所以 218/1431 在其自身口径下是正确且可复算的。

**边界行为**：`entry.isFile()/isDirectory()` 判定使符号链接（文件与目录）一律被跳过 —— 这既避免了软链目录成环，也意味着「软链出来的测试文件会被静默漏计」。本仓当前 0 个软链测试文件，不影响本轮数字，属已知取舍。

### 1.5 运行是否可重复 —— 成立

```
$ for i in 1 2 3; do node scripts/diag-a.mjs | shasum -a 256; done
7dae6b3d3f453a8dea026fe9257aec1459d7b156500ad354bfadd528938ccbf6  -
7dae6b3d3f453a8dea026fe9257aec1459d7b156500ad354bfadd528938ccbf6  -
7dae6b3d3f453a8dea026fe9257aec1459d7b156500ad354bfadd528938ccbf6  -

$ (cd /tmp && node <repo>/scripts/diag-a.mjs)
diag-a: 218 test files, 1431 test cases     # 与仓库内运行完全一致（cwd 无关）

$ node scripts/diag-a.mjs >/dev/null; echo "exit=$?"
exit=0                                     # stderr 0 字节
```

仓库根由 `import.meta.url` 推导（`resolve(dirname(fileURLToPath(import.meta.url)), '..')`），与 cwd 无关；`entries.sort()` 只影响遍历顺序、不影响计数，故输出稳定。

### 1.6 车道门禁未被污染 —— 成立（本车道自行复跑，非转述）

```
$ node --run typecheck   ; echo exit=$?   → exit=0
$ node --run lint        ; echo exit=$?   → exit=0   ("No unawaited expect().resolves/.rejects chains found.")
$ node --run check:evidence ; echo exit=$? → exit=0   ("Acceptance evidence is unchanged.")
$ node --check scripts/diag-a.mjs          → syntax OK
```

---

## 2. 非阻塞发现（不触发返工，但 merge 必须处理）

### 2.1 脚本头注释里有一句可被证伪的断言 —— 数字本身没错，理由是错的

`scripts/diag-a.mjs:7-9` 写：

> *test file* — … This matches how the repository's vitest config names its suites (`tests/**/*.test.ts`).

`vitest.config.ts:6` 的 include 确实是 `tests/**/*.test.ts`，但仓库里有 **1 个文件不满足它**：

```
$ find tests -type f \( -name '*.test.*' -o -name '*.spec.*' \) ! -name '*.test.ts'
tests/fixtures/m7/web-server.test.js
```

它不是 vitest 套件，而是 **m7 的 fixture 载荷** —— `tests/m7/adapters.ts:71-79` 把它拷进沙箱工作区后用 `node --test` 单独执行；运行时也印证了这一点：vitest 实跑 **217** 个文件，而 diag-a 报 **218**（差值恰为这 1 个文件），vitest 内的声明行 1429 + fixture 的 2 行 = 1431。

**影响**：把 218 当成「本仓 vitest 套件数」会多 1；脚本教给读者的口径理由是错的。**处置**：`merge` 在写用法说明时**不得**把「218 = 本仓测试套件数」或头注释里那句括号注释原样搬进 README；若要保留 218，须注明「含 1 个 `tests/fixtures/m7/web-server.test.js` fixture（node:test 载荷，不在 vitest include 内），vitest 实跑 217」。impl-a 侧只需改一行注释，不构成返工理由。

### 2.2 唯一的人工复算脚本放在 `/tmp`，随机会话即丢失

impl-a 的证据脚本 `/tmp/diag-a-verify.sh` 在仓库外、且未随交付件留档（交付件只记录了它的输出文本）。按共享测试标准（R23：每次运行都要留下可复跑的产物）这属于**可重复性缺口**：本报告 §1.4 的 `find`/`grep` 复算命令已在本文件内重建了该证明，但车道自身没有把「独立复算」固化成随仓库走的产物。受「本车道只准新增一个文件」的约束，此处不判 fail，但**若后续要长期保留这三个诊断脚本，应把复算命令收进 `package.json` 的一个 npm script 或 `scripts/verify-diag-*.mjs`**，让 merge 写 README 时能指向一条真实存在的命令。

---

## 3. 交付件声明的核对

impl-a 交付件与私信里的每一条声明，均已在本工作副本上独立复现：

| 声明 | 核对结果 |
| --- | --- |
| `git status --porcelain` 只有 `?? scripts/diag-a.mjs` | 提交后为**空**；提交内容为 A-only（§0） |
| 只用 `node:fs/promises` / `node:path` / `node:url` | 属实（§1.2） |
| 输出 `diag-a: 218 test files, 1431 test cases` | 逐字一致（§1.4） |
| 跳过 `.git` / `node_modules` | 属实（`SKIP_DIRS`） |
| 仓库根由脚本位置推导、cwd 无关 | 属实，/tmp 运行同输出（§1.5） |
| typecheck / lint exit 0 | 属实（§1.6） |
| 「未提交单测是有意的，因为节点约束是只加这一个文件」 | 与 lookFor 第 3 条一致，不视为缺陷；E2E 证据由 §1.4/§1.5 承担 |

---

## 4. 图级风险（不属本车道）：基线红的原因是工作副本的 `node_modules` 软链，已定位并可复现

> **本节在第 2 轮审查中被重写。** 第 1 轮只把基线红记为「harness / 环境层问题」并建议「先确认基线是绿的」。下面是 A/B 对照证明的真正成因与修法；旧的猜测性结论（尤其是「让 `merge` 去确认基线」的建议）**作废**。

### 4.1 现象

在各 impl/review 副本上跑 `node --run check`，前三个阶段全绿，第四阶段必红：

| 阶段 | 退出码 |
| --- | --- |
| `typecheck` | 0 |
| `lint` | 0 |
| `check:evidence` | 0 |
| **`test`（`vitest run`）** | **1 —— 42 个文件失败 / 128 of 1468 用例失败** |

失败与三个车道**无关**：`7165551..f3d0ced` 的全部改动是 4 个纯新增文件（`scripts/diag-a.mjs`、`scripts/diag-b.mjs`、`scripts/diag-c.mjs`、`reviews/review-a.md`），全仓检索 `diag-[abc]` 只命中 `tests/m2/verification.test.ts:229,235` 的**字符串字面量**（伪造 multiview 载荷），而该文件并不在失败名单里。

### 4.2 根因（已证明，不是猜测）

工作副本的 `node_modules` 是**指向仓库外部的软链**：

```
$ ls -ld node_modules
node_modules -> /Users/macmini/workspace/13-Graph/node_modules
```

`src/runtime/pi-process.ts:166` 把 `appRoot = realpath(graphApplicationRoot())`（即工作副本自身）作为 `readPaths` 传给内层 restricted executor。软链的真实目标在 `appRoot` 之外，内层沙箱读不到，于是每个 Pi worker 子进程在启动瞬间就模块解析失败：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-ai'
  imported from .../review-a/src/runtime/pi-worker.ts
```

后续 36 处 `provider.requests[N]` 为 `undefined`、12 处 `Timed out waiting for condition` 都是这一个根因的下游症状（worker 没起来，假 provider 自然收不到请求）。

这正是仓库自己写明的陷阱 —— `docs/agents/checks.md`「在 Git 工作树里验证」：「不要手工 `ln -s` 指向主仓库的 `node_modules`……沙箱内的 Agent 子进程会以模块解析失败告终」，以及 `docs/adr/0027-work-copy-dependency-link.md` §2「链接目标在副本之外，没有读取授权就无法解析」。

### 4.3 A/B 对照：128 → 4（第 3 轮在 HEAD `bf47906` 上重跑）

同一份源码、同一套依赖，只把 `node_modules` 换成文档规定的硬链接实体目录：

| 副本 | `node_modules` 形态 | 结果 |
| --- | --- | --- |
| 审查工作副本 `review-a`（HEAD `bf47906`） | 软链到 `13-Graph/node_modules` | **42 文件 / 128 用例失败** |
| 对照副本 `/tmp/rev-a3-probe`（同一份源码） | `cp -al` 硬链接实体目录 | **5 文件 / 5 用例失败** |
| 对照副本 + `git init -q` | 同上 | **4 文件 / 4 用例失败** |

> **第 4 轮修正**：本表「对照副本 5 文件 / 5 用例」那一行里的第 5 个（`tests/m8/settings-ui.test.ts`）**不是真失败**，是第 3 轮探针与工作副本全量 vitest 并发时的负载抖动；单独串行复跑为 4/4，该文件单独复跑 4 次全绿。详见 §8.2。基线行（4/4）本轮独立复现，报错逐字相同。
| **基线对照 `/tmp/rev-a3-base`（提交 `7165551`，车道之前，无 diag 脚本）** | 同上硬链接 | **同样 4 文件 / 4 用例失败** |

**124 of 128 的失败仅由软链造成**（工作副本 42 个失败文件中，37 个在硬链接副本上直接转绿；`comm -13` 证明硬链接副本没有引入任何新失败文件）。剩下 4 个**全都是环境项，与代码无关**：

| 失败文件 | 报错 | 归因 |
| --- | --- | --- |
| `tests/m0/restricted-process.test.ts` | `Error: Command failed: /usr/bin/which npm` | 沙箱 PATH 内没有 `npm`（宿主侧 `command -v npm` 亦为空） |
| `tests/m7/delivery.test.ts` | `Error: spawnSync git ENOENT` | 受限子进程 PATH 内没有 `git` |
| `tests/m7/production.test.ts` | `Error: spawnSync git ENOENT` | 同上 |
| `tests/m7/page.test.ts` | `ENOENT: copyfile '/private/tmp/12-MediaBookmarks/src/config.js'` | 兄弟项目 `12-MediaBookmarks` 不在磁盘上 |

**第 3 轮新增的决定性一格**：把基线提交 `7165551`（三个车道落地之前）用 `git archive` 抽到 `/tmp/rev-a3-base`、同样 `cp -al` 硬链接依赖，只跑这 4 个文件，结果是 `Test Files 4 failed (4)`、`Tests 4 failed | 23 passed (27)` —— **与 HEAD 上的 4 个失败完全一致**。因此这 4 条是**既有的环境基线**，既不是三个 diag 车道造成的，也不是本任务范围内能修的代码缺陷；`full-tests` 在修好依赖后仍会红，且应当如此判定。

> 第 2 轮记录的「6 个剩余失败」中，`tests/console/rsi.test.ts > resolveRsiRoot prefers an explicit GRAPH_RSI_ROOT` 一条本轮已定位到**精确**原因：`src/runtime/rsi.ts:1042-1050` 的 `resolveRsiRoot` 要求 `detectRepo(root) === root`，而 tar 抽出的对照副本没有 `.git`，于是返回 `undefined`（断言期望 `/private/tmp/rev-a3-probe`）。在对照副本里执行一次 `git init -q` 后该文件 **29 passed (29)**。也就是说它同样是探针构造方式的产物，不是缺陷。

### 4.4 修法（仓库已给出，照抄即可）

```sh
cp -al /Users/macmini/workspace/13-Graph/node_modules <工作副本>/node_modules
```

复现 A/B 对照（不改动任何工作副本）：

```sh
W=<工作副本>; P=/tmp/rev-a3-probe; rm -rf $P; mkdir -p $P
(cd "$W" && tar -cf - --exclude=.git --exclude=node_modules .) | (cd "$P" && tar -xf -)
cp -al /Users/macmini/workspace/13-Graph/node_modules "$P/node_modules"
(cd "$P" && git init -q)      # 缺这一步会多出 1 个假失败 tests/console/rsi.test.ts（见 §4.3）
(cd "$P" && node --run test)
```

> 注：路径里有空格（`Application Support`），`cd $W` 一类写法会报 `Not a directory`，必须加引号 —— 第 2 轮的复现块就踩了这个坑，第 3 轮已修正。

### 4.5 另一处更硬的阻塞：`integration` 副本根本没有 `node_modules`

```
$ ls -ld ../integration/node_modules
ls: ../integration/node_modules: No such file or directory
$ (cd ../integration && node -e "require.resolve('vitest')")
vitest UNRESOLVED MODULE_NOT_FOUND
```

第 3 轮再次实测（HEAD `bf47906` 时点，结论与第 2 轮一致、未被修复）：

```
$ cd ../integration && node --run typecheck
/bin/sh: tsc: command not found
typecheck-in-integration exit=1
```

> **第 4 轮加强（HEAD `640199f`）**：`node --run test` 也一并实测，同样在第一步就死 —— `/bin/sh: vitest: command not found`，真实退出码 1。所以阻塞不止于 `typecheck`，**四个阶段一个都到不了**。见 §8.4。

所以在 `integration` 副本上，`node --run check` 会在**第一步 `tsc`** 就失败（连 `typescript` 都解析不到），比 128 个用例失败更早、更彻底。**在修好 `integration` 的依赖之前，任何跑 `node --run check` 的 `full-tests` 都必然红 → 退回 `merge` → 而 `merge` 只拥有那段 README → 再次 `full-tests` 再次失败，循环至 stalled。这是可预见的死锁。**

**给图操作者**：这不是代码问题，不要让 `merge` 去改那 128 个用例（也改不动）。先按 §4.4 给 `integration` 副本补上硬链接依赖，再重跑 `full-tests`；把修依赖之前产生的失败判为「环境/基线问题」，不要触发 `full-tests → merge` 回边。

---

## 5. 可复跑产物清单（本审查留下的证据）

```bash
cd <repo>                       # HEAD = d1d954a
node scripts/diag-a.mjs                      # → diag-a: 218 test files, 1431 test cases（exit 0，stderr 空）
node scripts/diag-a.mjs | shasum -a 256      # → 7dae6b3d…（连跑 3 次同一摘要）
(cd /tmp && node <repo>/scripts/diag-a.mjs)  # → 同一行（cwd 无关）

# 独立复算（不复用脚本逻辑）
find . -type f \( -name '*.test.*' -o -name '*.spec.*' \) -not -path './.git/*' -not -path '*/node_modules/*' | wc -l            # 218
grep -rhE '^[[:space:]]*(it|test)([.][A-Za-z_$]+)*[[:space:]]*[(`]' --include='*.test.*' tests | wc -l                         # 1431
find tests -type f \( -name '*.test.*' -o -name '*.spec.*' \) ! -name '*.test.ts'                                            # tests/fixtures/m7/web-server.test.js

# 只读取证
find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type f -print0 | xargs -0 stat -f '%N %z %m' | sort > /tmp/fp1
node scripts/diag-a.mjs
find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type f -print0 | xargs -0 stat -f '%N %z %m' | sort > /tmp/fp2
diff /tmp/fp1 /tmp/fp2 && git status --porcelain   # 两者皆空

# 车道门禁
node --run typecheck; node --run lint; node --run check:evidence    # 全部 exit 0
node --run test                                                    # 基线红：42 files / 128 of 1468 失败（见 §4，非本车道）
```

---

## 6. 判定

**route = `pass`**

- 只读 ✅（静态 + 1025 文件指纹双重取证）
- 仅 node 内置模块 ✅
- 仅新增 `scripts/diag-a.mjs`、零既有文件改动、零依赖改动、零测试耦合 ✅
- 统计结果在其自述口径下正确，`find`/`grep` 独立复算 218/1431 完全吻合，并与 vitest 运行时的 217 文件 / 1468 用例交叉核对后差值被 `test.each` 展开完整解释 ✅
- 运行可重复：3 次同摘要、cwd 无关、exit 0、stderr 空 ✅

阻塞项 0 条。非阻塞 2 条（§2.1 注释口径、§2.2 复算产物未固化），其中 §2.1 是 **merge 的硬约束**：不得把「218 = 本仓测试套件数」及那句括号注释原样写入用法说明。
图级风险 1 条（§4），不属于车道 a 的返工理由，但必须在合并前由图操作者处置。

**第 2 轮复核（operation `b2c36132`，HEAD `f3d0ced`）**：判定不变，仍为 **pass**，0 阻塞项。

- lookFor 五条在合并后复跑全部成立：`diag-a: 218 test files, 1431 test cases` 连跑 3 次 + `/tmp` 下 cwd 无关运行均同值；`find`/`grep` 独立复算 218/1431 吻合；`diag-a.mjs` 静态无任何写/执行 API，import 仅 `node:fs/promises`/`node:path`/`node:url`。
- 三个 diag 脚本合跑后对 1028 个文件的 `path+size+mtime` 指纹逐行 diff 为空，`git status --porcelain` 干净。
- 门禁复跑：`typecheck` 0、`lint` 0、`check:evidence` 0；`test` 1（42 文件 / 128 用例）。
- `test` 的红**已归因且已证明与车道无关**：A/B 对照（软链 vs `cp -al` 硬链接）为 128 → 6 个失败；且 `integration` 副本无 `node_modules`，`tsc` 即不可解析。详见 §4。

**唯一需要下游动手的事**：按 §4.4 给 `integration` 副本补硬链接依赖，再重跑 `full-tests`；不要让 `merge` 去改那 128 个用例。

---

**第 3 轮复核（HEAD `bf47906`，与车道 a 无关的 `review-b` / `review-c` 报告已合入）**：判定不变，仍为 **pass**，0 阻塞项，2 条非阻塞发现维持原判。

本轮逐条重跑的结果（全部为本机实测，非转述）：

| 检查 | 结果 |
| --- | --- |
| 车道提交边界 | `git show --name-status d1d954a` = `A scripts/diag-a.mjs` 一个文件；该 blob 到 HEAD 未变（`8a4185ba…` 两端一致） |
| 只读（静态） | `writeFile\|appendFile\|mkdir\|rm(\|unlink\|rename\|createWriteStream\|copyFile\|chmod\|truncate\|spawn\|exec\|process.exit\|process.env` 命中 **0** |
| 只读（动态） | 1030 个文件 `path+size+mtime` 指纹，`diag-a/b/c` 三个脚本合跑前后 diff 为空，`git status --porcelain` 为空 |
| 仅 node 内置 | import 仅 `node:fs/promises` / `node:path` / `node:url` |
| 统计正确性 | `diag-a` = `218 / 1431`；`find` / `grep` 独立复算 = `218` / `1431`；vitest 实跑 217 文件，多出的 1 个仍是 `tests/fixtures/m7/web-server.test.js`（§2.1 成立） |
| 可重复 | 连跑 3 次摘要同为 `7dae6b3d3f453a8dea026fe9257aec1459d7b156500ad354bfadd528938ccbf6` |
| 零耦合 | 全仓 `diag-a` 仅命中 `tests/m2/verification.test.ts:229,235` 的字符串字面量与脚本自身；`reviews/review-a.md` 在 `tests/console/review-as-router.test.ts:32` 中也只是一个**写入临时目录**的路径常量，不读本文件 |
| 门禁 | `typecheck` 0、`lint` 0、`check:evidence` 0；`test` 1（42 文件 / 128 of 1468） |

`test` 的红本轮**升级为「既有环境基线」**：A/B 对照 128 → 4（软链 vs `cp -al` 硬链接），且这 4 个在车道之前的基线提交 `7165551` 上同样失败，见 §4.3。`integration` 副本仍无 `node_modules`（`tsc: command not found`），§4.5 死锁风险仍在，见 §4.5。

**仍未闭合的下游事项**（都不是车道 a 的返工理由，但必须在合并前处置）：

1. 给 `integration` 副本补硬链接依赖（§4.4），否则 `full-tests` 必红 → `full-tests → merge` 回边会空转到 stalled。
2. 修好依赖后 `full-tests` 仍会红 4 个文件 —— 这 4 个是环境基线（沙箱 PATH 缺 `npm`/`git`、兄弟项目 `12-MediaBookmarks` 不在盘上），应判为基线而非回归；**不要**让 `merge` 去改这 4 个用例对应的实现。
3. `merge` 写 README 时遵守 §2.1 的硬约束：不得把「218 = 本仓测试套件数」或 `scripts/diag-a.mjs:8-9` 那句括号注释原样抄入。

**第 4 轮复核（HEAD `640199f`）**：判定不变，仍为 **pass**，0 阻塞项，2 条非阻塞发现维持原判，§8 给出逐条重跑结果与两项修正。

---

## 7. 第 3 轮证据的一次性复现脚本（R23：可复跑产物）

整段可粘贴复跑，输出即本轮表格；只读仓库本体，只在 `/tmp` 下建探针。

```bash
W="$(pwd)"; P=/tmp/rev-a3-probe; B=/tmp/rev-a3-base; NM=/Users/macmini/workspace/13-Graph/node_modules

# 1) 车道 a 本体：输出、可重复性、独立复算、只读指纹
node scripts/diag-a.mjs                                     # → diag-a: 218 test files, 1431 test cases
for i in 1 2 3; do node scripts/diag-a.mjs | shasum -a 256; done   # → 3 次同一摘要
find . -type f \( -name '*.test.*' -o -name '*.spec.*' \) -not -path './.git/*' -not -path '*/node_modules/*' | wc -l   # 218
grep -rhE '^[[:space:]]*(it|test)([.][A-Za-z_$]+)*[[:space:]]*[(`]' --include='*.test.*' --include='*.spec.*' . \
  --exclude-dir=.git --exclude-dir=node_modules | wc -l                                                                 # 1431
grep -nE "writeFile|appendFile|mkdir|rm\(|unlink|rename|createWriteStream|copyFile|chmod|truncate|spawn|exec|process\.exit|process\.env" scripts/diag-a.mjs  # 无输出
fp() { find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type f -print0 | xargs -0 stat -f '%N %z %m' | sort; }
fp > /tmp/fp1; node scripts/diag-a.mjs >/dev/null; node scripts/diag-b.mjs >/dev/null; node scripts/diag-c.mjs >/dev/null; fp > /tmp/fp2
diff /tmp/fp1 /tmp/fp2 && git status --porcelain            # 两者皆空 ⇒ 三个 diag 脚本只读

# 2) 门禁
node --run typecheck; node --run lint; node --run check:evidence   # 全部 exit 0
node --run test                                                     # exit 1：42 files / 128 of 1468（软链所致，见 §4）

# 3) A/B 对照：同样的源码，只把 node_modules 换成硬链接实体目录
rm -rf "$P"; mkdir -p "$P"
(cd "$W" && tar -cf - --exclude=.git --exclude=node_modules .) | (cd "$P" && tar -xf -)
cp -al "$NM" "$P/node_modules"; (cd "$P" && git init -q)      # git init 必须有，否则多 1 个假失败
(cd "$P" && node --run test)                                 # → 4 files / 4 tests 失败，全部环境项

# 4) 基线对照：车道之前的提交，同样硬链接依赖
rm -rf "$B"; mkdir -p "$B"
(cd "$W" && git archive 7165551) | tar -x -C "$B"; cp -al "$NM" "$B/node_modules"
(cd "$B" && node node_modules/vitest/vitest.mjs run tests/m0/restricted-process.test.ts tests/m7/delivery.test.ts tests/m7/page.test.ts tests/m7/production.test.ts)
# → Test Files 4 failed (4)  ⇒ 这 4 条是既有基线，与三个 diag 车道无因果关系

# 5) integration 副本的依赖缺口（§4.5）
ls -ld ../integration/node_modules            # → No such file or directory
(cd ../integration && node --run typecheck)   # → /bin/sh: tsc: command not found
```

本轮实际产物路径：`/tmp/rev-a3-test.txt`（工作副本全量 42/128）、`/tmp/rev-a3-probe-test.txt`（硬链接副本 5/5）、`/tmp/rev-a3-fp1.txt` / `rev-a3-fp2.txt`（1030 文件指纹）、`/tmp/rev-a3-wt-fail.txt` 与 `/tmp/rev-a3-probe-fail.txt`（两个失败文件清单，供 `comm -13` 求差）。

---

## 8. 第 4 轮：HEAD `640199f` 上的逐条重跑

### 8.1 车道 a 自身的 5 条 lookFor（全部成立）

| 检查 | 复跑命令 | 结果 |
| --- | --- | --- |
| 提交边界 | `git show --name-status d1d954a` | `A scripts/diag-a.mjs` 一个文件，无 M/D/R |
| blob 未被下游改动 | `git rev-parse d1d954a:scripts/diag-a.mjs` / `HEAD:…` / `git hash-object` | 三处同为 `8a4185ba914e7e3bd0aadae52a705cfaf7f81388` |
| 只读（静态） | `grep -nE "writeFile\|appendFile\|mkdir\|rm(\|unlink\|rename\|createWriteStream\|copyFile\|chmod\|truncate\|spawn\|exec\|process\.exit\|process\.env" scripts/diag-a.mjs` | 命中 **0** |
| 只读（动态） | 1030 文件 `path+size+mtime` 指纹，`diag-a/b/c` 合跑前后 `diff` | 指纹**逐行相同**，`git status --porcelain` 为空 |
| 仅 node 内置 | `grep -nE "^import\|require\(" scripts/diag-a.mjs` | 仅 `node:fs/promises`、`node:path`、`node:url` |
| 统计正确性 | `node scripts/diag-a.mjs` | `diag-a: 218 test files, 1431 test cases`，exit 0，stderr 0 字节 |
| 独立复算 | `find … \| wc -l` / `grep -rhE … \| wc -l` | **218** / **1431**，与脚本逐字吻合 |
| 可重复 | 连跑 3 次 `\| shasum -a 256` | 三次同为 `7dae6b3d3f453a8dea026fe9257aec1459d7b156500ad354bfadd528938ccbf6` |
| cwd 无关 | `(cd /tmp && node <repo>/scripts/diag-a.mjs)` | 同一行 |
| 零耦合 | `git diff --name-only 7165551 HEAD -- tests/ src/` | **0** 个文件；全仓 `diag-a` 仅命中 `tests/m2/verification.test.ts:229,235` 的字符串字面量 |
| 门禁 | `typecheck` / `lint` / `check:evidence` / `node --check` | 全部 exit 0，语法 OK |

§2.1 仍然成立：`find` 出的非 `.test.ts` 测试文件仍是且仅是 `tests/fixtures/m7/web-server.test.js`，而 `vitest.config.ts:6` 的 include 是 `tests/**/*.test.ts`；vitest 本轮实跑 **217** 个文件（5/5、4/4、42/42 三次均为 217），218 − 217 = 1，差的正是这个 fixture；`tests/m7/adapters.ts:79` 用 `spawnSync(process.execPath, ['--test', …])` 跑它，确实不是 vitest 套件。

### 8.2 修正一：上一轮探针的「第 5 个失败」是我自己造成的负载抖动

第 3 轮记录探针为「5 文件 / 5 用例」，并把 `git init` 后的 4 个当作真基线。本轮复跑时，探针与工作副本的两套全量 vitest **被我并发启动**，探针报 5 个失败，多出的是 `tests/m8/settings-ui.test.ts`：

```
FAIL  tests/m8/settings-ui.test.ts > settings auto-save models, credentials and limits without leaking secrets
AssertionError: expected true to be false   ❯ tests/m8/settings-ui.test.ts:232
Caused by: Error: Matcher did not succeed in time.
   230|   }, { timeout: 15_000 }).toBe(true);
   231|   const revisionPill = page.getByTestId('effective-revision').locator(…
   232|   await expect.poll(async () => (await revisionPill.innerText())).inclu…
```

该文件本次耗时 41861ms，其中该用例 22694ms，是典型的并行负载下的 `expect.poll` 超时。本轮证伪它不是缺陷的三条独立证据：

1. 探针**单独**跑全量：`Test Files 4 failed | 213 passed (217)` / `Tests 4 failed | 1464 passed (1468)`，148.59s —— 比并发那次（232.54s）快 1.6 倍，与 CPU 争抢一致。
2. `settings-ui` 在探针里单独连跑 3 次：`1 passed (1)` / `9 passed (9)`，三次全绿。
3. 同一文件在工作副本（软链 `node_modules`）里单独跑：`1 passed (1)` / `9 passed (9)`，且它**不在**工作副本的 42 个失败名单里。

加上 `git diff --name-only 7165551 HEAD -- tests/ src/` 为 **0**（三个车道从落地到 HEAD 没碰过任何 `tests/` 或 `src/` 文件），`settings-ui` 与本任务无因果关系。**基线失败数是 4，不是 5。**

### 8.3 复现：基线红的归因仍然成立（A/B 42/128 → 4/4）

| 副本 | `node_modules` 形态 | 结果 |
| --- | --- | --- |
| 工作副本 `review-a`（HEAD `640199f`） | 软链到 `13-Graph/node_modules` | **42 文件 / 128 of 1468 失败**，208.44s |
| 探针 `/tmp/rev-a4-probe`（同一份源码，`cp -al` 硬链接 + `git init`） | 硬链接实体目录 | **4 文件 / 4 of 1468 失败**，148.59s |
| **基线 `/tmp/rev-a4-base`（提交 `7165551`，车道之前，`scripts/diag-*.mjs` 数量 = 0）** | 同上硬链接 | **同样 4 文件 / 4 用例失败**（`4 failed \| 23 passed (27)`） |

基线的 4 条报错与 HEAD 上探针的 4 条**逐字相同**（`/usr/bin/which npm` 失败、`spawnSync git ENOENT` ×2、`12-MediaBookmarks/src/config.js` 不在盘上），因此这 4 条是**既有的环境基线**：既不是三个 diag 车道造成的，也不是本任务范围内能修的代码缺陷。`7165551..640199f` 的全部改动是 **6 个纯新增文件**（3 个 diag 脚本 + 3 份评审报告），零既有文件被修改。

### 8.4 修正二：`integration` 副本的阻塞比上轮记录的更早、更硬

上轮只测了 `typecheck`。本轮把 `node --run test` 也测了，**两者都在第一步就死**：

```
$ ls -ld integration/node_modules
ls: integration/node_modules: No such file or directory

$ cd integration && node --run typecheck ; echo $?
/bin/sh: tsc: command not found
1

$ cd integration && node --run test ; echo $?
/bin/sh: vitest: command not found
1
```

`integration` 副本的 HEAD 还停在 `547cf36`，落后于当前 `640199f`。所以在它上面跑 `node --run check`，**四个阶段一个都到不了**。这使 §4.5 的死锁从「第四阶段红」升级为「第一阶段就红」：`full-tests` 必红 → 回边到 `merge` → `merge` 只拥有那段 README、改不动依赖 → 再次 `full-tests` 再次红，循环至 stalled。

**给图操作者**：这是环境问题，不是代码问题，也**不是** `full-tests → merge` 回边能修的。修法就是 §4.4 那一行 `cp -al`，必须由图操作者对 `integration` 副本执行，然后重跑 `full-tests`。修好之后 `full-tests` 仍会红 4 个文件（§8.3 的基线），应判为**基线**而非回归；**不要**让 `merge` 去改这 4 个用例对应的实现。

### 8.5 第 4 轮一次性复现脚本（R23）

```bash
W="$(pwd)"; NM=/Users/macmini/workspace/13-Graph/node_modules
P=/tmp/rev-a4-probe; B=/tmp/rev-a4-base

# 1) 车道 a 本体
node scripts/diag-a.mjs                                  # → diag-a: 218 test files, 1431 test cases
for i in 1 2 3; do node scripts/diag-a.mjs | shasum -a 256; done   # → 3 次同一摘要
find . -type f \( -name '*.test.*' -o -name '*.spec.*' \) -not -path './.git/*' -not -path '*/node_modules/*' | wc -l   # 218
grep -rhE '^[[:space:]]*(it|test)([.][A-Za-z_$]+)*[[:space:]]*[(`]' --include='*.test.*' --include='*.spec.*' . \
  --exclude-dir=.git --exclude-dir=node_modules | wc -l                                                                 # 1431
node --run typecheck; node --run lint; node --run check:evidence    # 全部 exit 0

# 2) 只读（三个 diag 脚本合跑）
fp() { find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type f -print0 | xargs -0 stat -f '%N %z %m' | sort; }
fp > /tmp/f1; node scripts/diag-a.mjs >/dev/null; node scripts/diag-b.mjs >/dev/null 2>&1; node scripts/diag-c.mjs >/dev/null 2>&1; fp > /tmp/f2
diff /tmp/f1 /tmp/f2 && git status --porcelain     # 皆空 ⇒ 只读

# 3) A/B 对照：同样的源码，只把 node_modules 换成硬链接实体目录
#    ⚠ 必须串行跑，不要和工作副本的全量 vitest 并发，否则 settings-ui 会负载抖动假失败（§8.2）
rm -rf "$P"; mkdir -p "$P"
(cd "$W" && tar -cf - --exclude=.git --exclude=node_modules .) | (cd "$P" && tar -xf -)
cp -al "$NM" "$P/node_modules"; (cd "$P" && git init -q)
(cd "$P" && node --run test)                       # → 4 files / 4 tests 失败

# 4) 基线对照：车道之前的提交
rm -rf "$B"; mkdir -p "$B"; (cd "$W" && git archive 7165551) | tar -x -C "$B"; cp -al "$NM" "$B/node_modules"
(cd "$B" && node node_modules/vitest/vitest.mjs run tests/m0/restricted-process.test.ts tests/m7/delivery.test.ts tests/m7/page.test.ts tests/m7/production.test.ts)
# → Test Files 4 failed (4)  ⇒ 既有基线，与三个 diag 车道无因果关系

# 5) integration 副本的依赖缺口（§8.4）
ls -ld ../integration/node_modules                  # → No such file or directory
(cd ../integration && node --run typecheck; echo $?) # → tsc: command not found / 1
(cd ../integration && node --run test;    echo $?)  # → vitest: command not found / 1
```

本轮实际产物路径：`/tmp/rev-a4-fp1.txt` / `rev-a4-fp2.txt`（1030 文件指纹）、`/tmp/rev-a4-wt-test.txt`（工作副本 42/128）、`/tmp/rev-a4-wt-fail.txt`（42 个失败文件）、`/tmp/rev-a4-probe-test.txt`（并发跑，5/5）、`/tmp/rev-a4-probe-test2.txt`（单独跑，4/4）、`/tmp/rev-a4-sui-1..3.txt` 与 `rev-a4-sui-wt.txt`（settings-ui 4 次复跑全绿）、`/tmp/rev-a4-base-test.txt`（基线 4/4）、`/tmp/rev-a4-int-tc.txt` / `rev-a4-int-test.txt`（integration 两个阶段的失败）。