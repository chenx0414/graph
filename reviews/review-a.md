# 独立审查：车道 a —— `scripts/diag-a.mjs` —— pass

- 审查节点：`review-a`（agent 路由器，`routes ['pass','fail']`，`input.route.declared=null`）
- 审查对象：impl-a 提交 `d1d954a`（`graph:impl-a:b2c36132-…`），父提交 `7165551`；本审查工作副本 HEAD = `d1d954a`，`git status --porcelain` 为空
- 审查依据：impl-a 交付件 `graph://tasks/a621e9d6-…/artifacts/deliverables/impl-a-diag-a@1`（digest `c1bf4103…`）与 impl-a→review-a 私信
- 结论：**pass** —— 5 条 lookFor 全部成立，**0 个阻塞项**，2 条非阻塞发现（其中 1 条禁止 merge 原样抄进 README），另附 1 条**不属于本车道但会卡死下游 `full-tests`** 的图级风险

> **第 2 轮增补（同一会话，operation `b2c36132`）**：车道 a 的 5 条 lookFor 在合并后的 HEAD `f3d0ced`（已含 impl-b/impl-c）上**复跑全部仍成立**，数字仍是 `218 / 1431`，三个 diag 脚本合跑对 1028 个文件零改动。门禁复跑：`typecheck` / `lint` / `check:evidence` 全 0，`test` 仍红（42 文件 / 128 用例）—— 但 §4 已被本轮用 **A/B 对照证明**重写：根因是工作副本 `node_modules` 软链，不是代码，且 `integration` 副本**根本没有 `node_modules`**。**第 1 轮 §4 的猜测性结论与「让 merge 去确认基线」的建议作废。**

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

### 4.3 A/B 对照：128 → 6

同一份源码、同一套依赖，只把 `node_modules` 换成文档规定的硬链接实体目录：

| 副本 | `node_modules` 形态 | 结果 |
| --- | --- | --- |
| 审查工作副本 | 软链到 `13-Graph/node_modules` | **42 文件 / 128 用例失败** |
| 对照副本 `/tmp/rev-a2-probe` | `cp -al` 硬链接实体目录 | **6 文件 / 6 用例失败** |

**122 of 128 的失败仅由软链造成**，与代码、与三个车道都无关。剩下 6 个也全是环境项，不是代码缺陷：`/usr/bin/which npm` 失败（本沙箱 PATH 内确实没有 `npm`：`spawnSync npm` → `ENOENT`）、`12-MediaBookmarks` 兄弟项目缺失（`tests/m7/page.test.ts:18` 依赖 `process.cwd()/../12-MediaBookmarks`）、以及对照副本放在 `/tmp` 导致的 `resolveRsiRoot` 路径断言。

### 4.4 修法（仓库已给出，照抄即可）

```sh
cp -al /Users/macmini/workspace/13-Graph/node_modules <工作副本>/node_modules
```

复现 A/B 对照（不改动任何工作副本）：

```sh
W=<工作副本>; P=/tmp/rev-a2-probe; rm -rf $P; mkdir -p $P
(cd $W && tar -cf - --exclude=.git --exclude=node_modules .) | (cd $P && tar -xf -)
cp -al /Users/macmini/workspace/13-Graph/node_modules $P/node_modules
(cd $P && node --run test)
```

### 4.5 另一处更硬的阻塞：`integration` 副本根本没有 `node_modules`

```
$ ls -ld ../integration/node_modules
ls: ../integration/node_modules: No such file or directory
$ (cd ../integration && node -e "require.resolve('vitest')")
vitest UNRESOLVED MODULE_NOT_FOUND
```

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

**唯一需要下游动手的事**：按 §4.4 给 `integration` 副本补硬链接依赖，再重跑 `full-tests`；不要让 `merge` 去改这 128 个用例。
