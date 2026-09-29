# 独立审查：车道 b —— `scripts/diag-b.mjs` —— pass（第 4 轮复跑）

- 审查节点：`review-b`（agent 路由器，`routes ['pass','fail']`，`input.route.declared=null`）
- 被审对象：impl-b 提交 `6c0d039`（`graph:impl-b:af0aed52-066b-4259-8b0c-d2cabfa956ad`）新增的唯一文件 `scripts/diag-b.mjs`
- 审查依据：`deliverables/diag-b-report@1`（digest `1eac27e6…`）、黑盒 E2E harness `deliverables/diag-b-e2e-harness@1`（digest `7c2e5bee…`）
- 被审文件指纹：`sha256(scripts/diag-b.mjs) = aba9bf43301a68e83947c2f54b6fa629edc3d274ebe618d5c455a2ae7847c1c6`（与第 1、2、3 轮**逐字节相同**）
- 本轮检出：`HEAD = 547cf36`（已并入 review-c 第 3 轮的 `5957267` 判 fail 提交）；impl-c 正在另一条分支上返工车道 c
- 结论：**pass** —— 5 条 lookFor 在第 4 个集成检出上**全部复跑成立**，**0 个阻塞项**；4 条非阻塞发现不变（其中 §2.1 本轮拿到了精确机制与有效链接复现）

> **本轮为何复跑**：图上没有记录任何下游证据失败，被审提交也没变（指纹同上）。因此本轮把 5 条 lookFor 与图级门禁风险在**第 4 个集成检出**上从零重跑一遍，确认前 3 轮的 pass 没有因为合流而过时，并补上一项前 3 轮没做过的中立性证明（见 §7.9，基线提交在 `/tmp` 里实跑对照）。

---

## 0. 审查对象绑定

```
$ git log --oneline HEAD -- scripts/diag-b.mjs
6c0d039 graph:impl-b:af0aed52-066b-4259-8b0c-d2cabfa956ad      # HEAD 历史里关于该文件的唯一一条

$ git show --name-status --format='%H %s' 6c0d039
6c0d03923cfc8f1ce53688092c2eb6def5daea59 graph:impl-b:af0aed52-066b-4259-8b0c-d2cabfa956ad
A	scripts/diag-b.mjs

$ git diff --name-status 7165551..HEAD
A	review-c-report.md   A	reviews/review-a.md   A	reviews/review-b.md   A	reviews/review-c.md
A	scripts/diag-a.mjs   A	scripts/diag-b.mjs    A	scripts/diag-c.mjs
$ shasum -a 256 scripts/diag-b.mjs
aba9bf43301a68e83947c2f54b6fa629edc3d274ebe618d5c455a2ae7847c1c6   scripts/diag-b.mjs
```

车道提交 = 「新增 `scripts/diag-b.mjs` 一个文件」，既有文件 M/D/R 全为 0；整张图自车道基线 `7165551` 起也是**纯新增**，没有任何一条改过仓库既有文件。兄弟车道新增的文件都在 `scripts/`、`reviews/` 与根目录，不落在 `src/` 下，所以合流不会扰动本车道的口径。

---

## 1. 五条 lookFor 复跑结果

| lookFor | 判定 | 本轮关键证据 |
| --- | --- | --- |
| 脚本只读 | ✅ | 写/执行类 API 扫描 0 命中；连跑 3 次后 **1031 个文件**指纹 `diff` 为空（`TREE IDENTICAL`）、`git status --porcelain` 空、脚本自身指纹不变 |
| 只用 node 内置模块 | ✅ | 3 个 import 全 `node:` 协议；车道提交不含 `package.json` / lockfile / tsconfig |
| 只新增 1 个文件、未改现有文件 | ✅ | §0；`tests/`/`src/`/`desktop/` 中 0 处引用该脚本，`package.json` 的 scripts 里 0 处提到它，`tsconfig.json` 的 `include` 不含 `scripts/**` |
| 统计结果正确 | ✅ | 第三套独立工具重算：`196 / 53,915 / 2,652,346` 逐格吻合，跳过账目恰为 2 个 |
| 运行可重复 | ✅ | 3 次 stdout 逐字节一致、stderr 全 0 字节、退出码全 0；`--json` 两次一致 |

### 1.1 只读（静态 + 动态）

```
$ grep -nE 'writeFile|appendFile|mkdir|rm\(|rmdir|unlink|rename|createWriteStream|copyFile|chmod|truncate|spawn|exec|child_process|process\.chdir|process\.env|fetch\(|https?\.request' scripts/diag-b.mjs
NONE
$ grep -n '^import' scripts/diag-b.mjs
19:import { readdir, readFile } from 'node:fs/promises';
20:import { basename, extname, join, relative, resolve } from 'node:path';
21:import { fileURLToPath } from 'node:url';

$ for i in 1 2 3; do node scripts/diag-b.mjs > run$i.txt 2> run$i.err; echo "run$i exit=$?"; done
run1 exit=0   run2 exit=0   run3 exit=0
$ wc -c run{1,2,3}.err
0 / 0 / 0
$ diff -q tree-before.txt tree-after.txt && echo "TREE IDENTICAL"
TREE IDENTICAL                      # 1031 files（排除 .git、node_modules）
$ git status --porcelain
(空)
```

### 1.2 可重复性

```
$ diff -q run1.txt run2.txt && diff -q run1.txt run3.txt && echo RUNS BYTE-IDENTICAL
RUNS BYTE-IDENTICAL
$ node scripts/diag-b.mjs --json > json1.txt; node scripts/diag-b.mjs --json > json2.txt
$ diff -q json1.txt json2.txt && echo JSON DETERMINISTIC
JSON DETERMINISTIC
$ shasum -a 256 run1.txt
c882af3544cd6f9311ac9a84db48a8486f742122551184ef9c4f4f826f5bd5fc   # 与第 3 轮同一输出指纹
$ node scripts/diag-b.mjs --json | node -e '…JSON.parse…'
parsed ok; top keys: target,modules,extensions,largest,total,skipped
total: {"files":196,"lines":53915,"bytes":2652346}
```

`--json` 是合法 JSON，`total` 与文本表一致。

### 1.3 统计结果——独立重算（与前两轮不同的第三条路径）

`git ls-files src`（版本库视角 198 个跟踪文件）→ 扩展名白名单过滤（不做通配展开）→ `wc -l` 数行、`stat -f%z` 数字节、`tail -c1` 探测末尾换行：

```
MODULE          FILES    LINES     BYTES  NONT
src/catalog        15     2525    120625     0
src/core           44    13979    753600     0
src/git             3     1270     67656     0
src/runtime        55    13467    680135     0
src/server         16     4738    220316     0
src/web            63    17936    810014     0
TOTAL             196    53915   2652346     0
```

与脚本输出的 `196 / 53,915 / 2,652,346` **逐格相同**；分模块求和 = TOTAL；`NONT=0`（196 个文件全部有末尾换行，故两种行数口径在本树不会分歧）。

- **跳过账目**：`comm` 比对「`git ls-files src` 的 198 个」与「筛出的 196 个」，差集恰为 2 个 —— `src/catalog/models-dev.snapshot.json`、`src/web/assets/graph-icon.png`，与脚本的 `2 non-source file(s) skipped.` 对上；`find src -type f | wc -l` 也是 198，无遗漏、无重复计数。
- **扩展名分解**独立重算吻合：`.cjs 1/40`、`.css 4/3,988`、`.html 1/13`、`.mjs 1/79`、`.ts 158/40,025`、`.tsx 31/9,770`。
- **Top-10** 与脚本输出一致（`styles.css 3,656` … `rsi.ts 1,077`）。

### 1.4 CLI 面——11 种调用全部符合退出码契约

```
(无参数)                      exit=0  stderr=0B    stdout 1370B
--help / -h                   exit=0  stderr=0B
--json                        exit=0  stderr=0B
--json --target src/git --json exit=0 stderr=0B      # 重复开关幂等
--target src/git              exit=0  stderr=0B     # 走「文件直挂 target 根」分支
--target <绝对路径>/src        exit=0  stderr=0B
--target <含空格的目录>         exit=0  stderr=0B
--target <空目录>              exit=0  stderr=0B     # 不崩，0/0 + Largest files (top 0)
--target .                    exit=0  stderr=0B     # 按模块目录切分，桶名为工作副本目录名
--target /definitely/not/here exit=1  stderr=74B    # diag-b: ENOENT … scandir
--target scripts/diag-b.mjs   exit=1  stderr=186B    # ENOTDIR
--target（缺值）               exit=1  stderr=38B    # --target requires a directory
--bogus                       exit=1  stderr=34B    # unknown argument
```

### 1.5 实现者的 E2E 证据可复跑（本轮从产物库直接取出重跑）

```
$ node <artifact: deliverables/diag-b-e2e-harness@1>     # sha256 与发布时一致
fixture (hand-computed oracle): core=2 files/4 lines, runtime=1/2, web=1/4, total=4 files/10 lines, 2 skipped
  ok  fixture run exits 0 …（8 项手算 oracle）
  ok  src/catalog matches independent walk (15 files / 2525 lines) …（6 个模块）
  ok  real total equals sum of modules
  ok  node --run typecheck passes
  ok  node --run lint passes
ALL PASSED (19 checks)          exit=0
```

该 harness 把脚本当黑盒（spawn + 只读 stdout/退出码，不 import 实现），fixture 用手算 oracle 且含「无末尾换行的文件」与「被跳过的 PNG + JSON」，真实树用另一套遍历交叉验证，符合「E2E 优先、断言只对外部行为」。

---

## 2. 非阻塞发现（4 条，均不建议为此返工）

### 2.1 树内的非普通文件（符号链接）被静默丢弃，连 `skipped` 都不计 —— `scripts/diag-b.mjs`

机制（本轮确认到确切原因）：目录遍历用 `readdir(withFileTypes)`，其类型判定是 **lstat 语义**，符号链接既 `isDirectory() === false` 又 `isFile() === false`，于是既不进模块桶、也不进 `skipped`，直接消失。

```
$ find /tmp/rvb-attempt4/fx/real -type f          # 3 个常规文件
…/data.json   …/mod/one.ts   …/mod/two.ts
$ find /tmp/rvb-attempt4/fx/real -mindepth 1 ! -type f ! -type d   # 2 个符号链接
…/linked-file.ts -> mod/one.ts     …/linked-dir -> mod/

$ node scripts/diag-b.mjs --target /tmp/rvb-attempt4/fx/real
real/mod        2      3      6
TOTAL           2      3      6
1 non-source file(s) skipped.          # 只有 data.json；两个链接彻底消失，无任何提示
```

**最坏形态（本轮用有效链接复现，排除上一轮的歧义）**：源码只能经树内符号链接到达时，整棵树报 `0`：

```
$ ln -s ../elsewhere fx2/tree/linked-src        # 有效链接：tree/../elsewhere 存在
$ test -d fx2/tree/linked-src && echo YES
YES
$ find -L fx2/tree -type f
fx2/tree/linked-src/only.ts                      # 跟随链接能看到 1 个 5 行的 .ts
$ node scripts/diag-b.mjs --target fx2/tree
TOTAL            0            0            0        0.0        exit=0   # 无任何提示
$ node scripts/diag-b.mjs --target fx2/elsewhere      # 对照：直指真实目录
elsewhere        1            5           10        5.0        exit=0
```

另外，树内「指向文件的符号链接」会**少报**：`tree/real.ts` + `tree/alias.ts -> real.ts` 报 `1 files / 2 lines`（应为 2 个文件）。

**为何仍判非阻塞**（三条可验证事实）：①本交付物的用途是报告**本仓库 `src/`** 的规模，而 `find src -mindepth 1 ! -type f ! -type d` 输出为空 —— `src/` 下没有任何非普通文件，脚本在该路径上不存在这个缺口；②已发布的 `196 / 53,915 / 2,652,346` 用三套独立工具重算过，是完整的；③触发需要使用者主动把 `--target` 指到一棵含符号链接的第三方目录。**一行修法**：把 `listChildren` 里既非目录也非文件的条目计入 `skipped`（或跟随链接）；改完不影响本仓库任何数字。

### 2.2 模块切分硬编码 POSIX 分隔符 —— `scripts/diag-b.mjs`

`moduleOf` 用 `rel.indexOf('/')` 切模块；Windows 上 `path.relative` 返回 `\`，所有文件会塌进同一个裸 prefix 桶。本仓库无 `.github/`、无 Windows runner，开发与门禁都在 macOS/Linux，仅作记录。

### 2.3 `--target` 会吞掉紧跟的开关 —— `scripts/diag-b.mjs`

`node scripts/diag-b.mjs --target --json` 把 `--json` 当路径，报 `ENOENT … '--json'` 并 exit 1。退出码正确、也没有静默错算，只是报错信息不够直白。

### 2.4 实现者「先写测试再实现」的过程主张在仓库里无法复核 —— `scripts/diag-b.mjs` / `deliverables/diag-b-e2e-harness@1`

车道是单次提交（`6c0d039` 一次成型），仓库内没有留下先红的运行记录，harness 也刻意只存在于产物库（以维持「只新增一个文件」）。这是过程主张而非产品主张，且 harness 本轮 19/19 可复跑，故不判 fail。

---

## 3. 同族排查：review-c 判 fail 的那一类缺陷，车道 b 不存在

review-c 对车道 c 的阻塞结论是：`argv[1]` 与 `import.meta.url` 比对构成的入口守卫，在**符号链接调用**下静默 `exit 0`、零输出。本轮把同族触发条件在车道 b 上逐条跑：

```
$ grep -n 'argv\[' scripts/diag-b.mjs
51:    const argument = argv[index];
58:      target = argv[index + 1];        # 只有参数解析，没有把调用路径与自身位置比对的入口守卫
```

| 调用写法 | exit | stdout 指纹 |
| --- | --- | --- |
| 绝对 realpath `node "$W/scripts/diag-b.mjs"` | 0 | `c882af3544cd…` |
| 绝对符号链接 `node /tmp/…/links/link-diag-b.mjs` | 0 | `c882af3544cd…` |
| `/var/tmp` 链（跨 `/var` → `/private/var`） | 0 | `c882af3544cd…` |
| 相对 `./diag-b.mjs`（cwd = `scripts/`） | 0 | `c882af3544cd…` |
| 相对 `./link-diag-b.mjs`（cwd = 符号链接所在目录） | 0 | `c882af3544cd…` |

五种调用写法输出**逐字节相同**（distinct digests: 1）、退出码全 0、stderr 全空。车道 b 唯一的缺省定位方式是「按脚本自身位置推仓库根」，与调用路径无关，因此不存在车道 c 那个阻塞缺陷。

---

## 4. 门禁复跑与红门禁的中立性证明

| 命令 | 退出码 |
| --- | --- |
| `node --run typecheck` | 0 |
| `node --run lint` | 0 |
| `node --run check:evidence` | 0（`Acceptance evidence is unchanged.`） |
| `node --run check` | **1**：`Test Files 42 failed \| 175 passed (217)`、`Tests 128 failed \| 1340 passed (1468)`、Duration 206.36 s |

三个数字与第 1、2、3 轮**逐个相同**，既没变好也没变坏。42 个失败文件全部落在 `tests/console|m0|m3|m7|m8`；**没有任何一个失败提到本车道的文件**（`grep -c 'diag-b' check.log` = 0；`grep -rl diag-b tests/ src/ desktop/` 为空）。

**本轮新增的中立性证明（前 3 轮只做过 HEAD 侧比较）**：把车道基线提交 `7165551` 整个 `git archive` 到 `/tmp`（那棵树里**一个 `diag-*.mjs` 都没有**，`scripts/` 下无该文件），对同一组失败用例目录在两侧各跑一次：

```
$ ( cd /tmp/rvb-attempt4/base && node node_modules/vitest/vitest.mjs run tests/m0 tests/m3 tests/m7 tests/m8 tests/console )
 Test Files  42 failed | 146 passed (188)      Tests  128 failed | 1169 passed (1297)   ← 基线 7165551（无 diag-*.mjs）
$ node node_modules/vitest/vitest.mjs run tests/m0 tests/m3 tests/m7 tests/m8 tests/console
 Test Files  42 failed | 146 passed (188)      Tests  128 failed | 1169 passed (1297)   ← HEAD 547cf36（含 diag-*.mjs）
```

**逐个数字相同**：这 128 个失败在车道开始之前就全部存在，与三条车道新增的文件无关。

**失败机制（与第 2 轮一致，本轮日志原样复现）**：

```
check.log:1257: Error: ENOENT: no such file or directory, copyfile
  '<worktree>/12-MediaBookmarks/src/config.js' -> '/var/folders/…/graph-m7-page-…/src/config.js'
check.log:1261:     18|   await copyFile(join(process.cwd(), '..', '12-MediaBookmarks', 'src',…
$ ls ..            → graph-m7-acceptance impl-a impl-b impl-c integration review-a review-b review-c
```

`tests/m7/page.test.ts` 等用例从 `process.cwd()/../12-MediaBookmarks` 取素材，而该兄弟项目只存在于**真实仓库的父目录**，工作副本的父目录里只有本任务的工作树目录 —— 这是**工作树布局造成的必然失败**。日志另有 2 处 `Test timed out in 15000ms` 与 1 处 `daemon exited early with 0`，属负载抖动。

**对下游的含义（不变）**：`full-tests` 节点跑的是同一条 `node --run check`，且它所在的 `integration` 检出与本工作副本**同父目录**，所以上面这条 m7 失败在它上面同样必然发生；`{from: full-tests, to: merge}` 的回边会因此反复唤醒 `merge`，而 `merge` 只改 `scripts/README.md`，改不动 `tests/`。**这是布局问题，不是交付物问题；人工验收时不要把它算到三条车道的账上。**

---

## 5. 给 merge 的硬约束

1. **禁止把 §2.1 的记账缺口写进 README 的能力描述。** 可以说「按模块目录统计源码规模、行数与字节」，**不要**写成「遍历目标目录下的所有文件」—— 含符号链接时后者不成立（`TOTAL 0` 且 exit 0）。
2. README 里 `diag-b` 的用法示例照抄已实测的三条：`node scripts/diag-b.mjs`、`--json`、`--target <dir>`，并注明默认目标是 `<repo>/src`。
3. 三条车道的数字口径互不相同且**都对**（a：测试面 216 文件 / 1422 声明；b：源码规模 196 / 53,915 / 2,652,346；c：npm 脚本 30 个），README 不要把它们混成「同一套指标的三种叫法」。
4. **操作提示**：`scripts/diag-b.mjs` 在其他分支上有同名不同内容的历史版本（上一个任务的图里 impl-b 也做过），合并要按 commit 挑文件，不要按文件名挑。
5. harness 只存在于产物库、不在仓库内（这是为了让车道严格只新增一个文件），README 不要把它写成「仓库内的测试」。

---

## 6. 判定

| lookFor | 判定 |
| --- | --- |
| 脚本是否只读 | ✅ |
| 是否只用 node 内置模块 | ✅ |
| 是否只新增 1 个文件、未改现有文件 | ✅ |
| 统计结果是否正确 | ✅ |
| 运行是否可重复 | ✅ |

**verdict = pass**，`route.case = 'pass'`。5 条 lookFor 全部在第 4 个集成检出上复跑成立，**0 个阻塞项**，返工理由：无。

非阻塞发现仍是 §2.1–§2.4 四条（§2.1 本轮补上了确切机制与「有效符号链接」的最坏形态复现），无新增阻塞项。
