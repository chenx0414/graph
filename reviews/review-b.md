# 独立审查：车道 b —— `scripts/diag-b.mjs` —— pass（第 5 轮复跑）

- 审查节点：`review-b`（agent 路由器，`routes ['pass','fail']`，`input.route.declared=null`；图声明回边 `{from: review-b, to: impl-b, case: 'fail'}`）
- 审查焦点（取自图里 review-b 节点的 `input.focus`）：只评 impl-b 的产出 `scripts/diag-b.mjs`
- 被审对象：impl-b 提交 `6c0d039`（`graph:impl-b:af0aed52-066b-4259-8b0c-d2cabfa956ad`）新增的唯一文件
- 审查依据：`deliverables/diag-b-report@1`（digest `1eac27e6…`）、黑盒 E2E harness `deliverables/diag-b-e2e-harness@1`（digest `7c2e5bee…`）
- 被审文件指纹：`sha256(scripts/diag-b.mjs) = aba9bf43301a68e83947c2f54b6fa629edc3d274ebe618d5c455a2ae7847c1c6`（与第 1–4 轮**逐字节相同**）
- 本轮检出：`HEAD = e802596`（第 4 轮复跑时是 `547cf36`；此后图里新增了 `8a7672f` review-c 第 4 轮报告、`eedc7a6` 车道 c 的入口守卫修复、`c492fa0`/`f211a8a` review-a 第 4/5 轮报告）
- 结论：**pass** —— 3 条 lookFor 在**第 5 个检出**上**全部复跑成立**，**0 个阻塞项**；非阻塞发现 4 条沿用 + **1 条本轮新增**

> **本轮为何复跑**：图上没有记录任何下游证据失败，被审提交与被审文件都没变（指纹同上）。因此本轮把 3 条 lookFor 从零重跑，并做了一件前 4 轮都没做对的事：**用 2×2 交叉实验把「红门禁是否与三条车道有关」彻底定死**。结论推翻了第 4 轮报告里的一句断言（见 §5.3），替换成更强、可复现的证据。

---

## 0. 审查对象绑定

```
$ git log --oneline -- scripts/diag-b.mjs
6c0d039 graph:impl-b:af0aed52-066b-4259-8b0c-d2cabfa956ad      # 唯一一条

$ git show --name-status --format='%H %s' 6c0d039
6c0d03923cfc8f1ce53688092c2eb6def5daea59 graph:impl-b:af0aed52-066b-4259-8b0c-d2cabfa956ad
A	scripts/diag-b.mjs                                          # 既有文件 M/D/R 全为 0

$ git diff --name-status 7165551..HEAD
A	review-c-report.md   A	reviews/review-a.md   A	reviews/review-b.md   A	reviews/review-c.md
A	scripts/diag-a.mjs   A	scripts/diag-b.mjs    A	scripts/diag-c.mjs    # 整张图自车道基线起纯新增

$ git diff --name-status 7165551..HEAD -- src/     # 空
$ git diff --name-status 7165551..HEAD -- tests/   # 空
$ shasum -a 256 scripts/diag-b.mjs
aba9bf43301a68e83947c2f54b6fa629edc3d274ebe618d5c455a2ae7847c1c6
```

第 2 行是关键事实：**从车道基线 `7165551` 到本轮 HEAD，整张图没有改动任何一个 `src/` 或 `tests/` 文件**，全部是新增文件。因此「既有测试变红」不可能由三条车道的代码引起，只能来自环境/布局 —— 这一点本轮用实验证明了（§5）。

---

## 1. lookFor 逐条复跑

| lookFor（图中声明） | 判定 | 本轮关键证据 |
| --- | --- | --- |
| 脚本是否只读、是否只用 node 内置模块 | ✅ | 写/执行/网络类 API 扫描 0 命中；3 个 import 全 `node:`；连跑 3 次后 **1031 个文件**指纹 `diff` 为空、`git status` 空 |
| 是否确实只新增了这一个文件、未改动任何现有文件 | ✅ | §0；`tests/ src/ desktop/` 中 0 处引用；`package.json` 无 diag 脚本；`tsconfig.include` 不含 `scripts/**` |
| 统计结果是否正确、运行是否可重复 | ✅ | 第三套独立工具重算逐格吻合；3 次 stdout 逐字节一致、stderr 全 0 字节、退出码全 0；`--json` 两次一致 |

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
TREE IDENTICAL                      # 1031 个文件（排除 .git、node_modules）
$ git status --porcelain | wc -l
0
```

### 1.2 可重复性

```
$ diff -q run1.txt run2.txt && diff -q run1.txt run3.txt && echo RUNS BYTE-IDENTICAL
RUNS BYTE-IDENTICAL
$ shasum -a 256 run1.txt run2.txt run3.txt
c882af3544cd6f9311ac9a84db48a8486f742122551184ef9c4f4f826f5bd5fc   （×3，与第 4 轮同一输出指纹）
$ node scripts/diag-b.mjs --json > json1.txt; … > json2.txt; diff -q → JSON DETERMINISTIC
parsed ok; keys: target,modules,extensions,largest,total,skipped
total: {"files":196,"lines":53915,"bytes":2652346}
```

输出指纹与第 4 轮**完全相同**，说明 `src/` 侧的输入在两次检出之间没变，发布过的数字没有过时。

### 1.3 统计结果——独立重算（第三条路径）

`git ls-files src`（198 个跟踪文件）→ 扩展名白名单过滤 → `wc -l` 数行、`stat -f%z` 数字节、`tail -c1` 探测末尾换行（无换行则 +1）：

```
MODULE          FILES    LINES     BYTES
src/catalog        15     2525    120625
src/core           44    13979    753600
src/git             3     1270     67656
src/runtime        55    13467    680135
src/server         16     4738    220316
src/web            63    17936    810014
TOTAL             196    53915   2652346
```

与脚本输出的 `196 / 53,915 / 2,652,346` **逐格相同**；分模块求和 = TOTAL。

- **跳过账目**：`comm` 比对 198 个跟踪文件与筛出的 196 个，差集恰为 2 个 —— `src/catalog/models-dev.snapshot.json`、`src/web/assets/graph-icon.png`，与脚本的 `2 non-source file(s) skipped.` 对上；`find src -type f | wc -l` 也是 198，无遗漏、无重复计数。
- **扩展名分解**独立重算逐格吻合：`.cjs 1/40`、`.css 4/3,988`、`.html 1/13`、`.mjs 1/79`、`.ts 158/40,025`、`.tsx 31/9,770`。
- **Top-10** 独立重算同名同序（`styles.css 3,656` … `rsi.ts 1,077`）。

### 1.4 CLI 面——15 种调用的退出码契约

```
(无参数)                        exit=0  stderr=0B    stdout 1370B
--help / -h                     exit=0  stderr=0B
--json                          exit=0  stderr=0B    stdout 2344B
--json --target src/git --json  exit=0  stderr=0B    （重复开关幂等）
--target src/git                exit=0  stderr=0B
--target <绝对路径>/src          exit=0  stderr=0B
--target <含空格的目录>          exit=0  stderr=0B    （目录名含空格正常工作）
--target <空目录>                exit=0  stderr=0B    （不崩：TOTAL 0/0/0 + Largest files (top 0)）
--target .                      exit=0  stderr=0B
--target /definitely/not/here   exit=1  stderr=74B    ENOENT … scandir
--target scripts/diag-b.mjs     exit=1  stderr=186B   ENOTDIR
--target（缺值）                 exit=1  stderr=38B    --target requires a directory
--bogus                         exit=1  stderr=34B    unknown argument
--target --json                 exit=1  stderr=183B   ENOENT … '--json'（见 §4.3）
```

### 1.5 行/字节口径的两个边界（本轮新测）

```
$ node scripts/diag-b.mjs --json --target <含 CRLF 的 .ts>     → lines 3, bytes 9   （与 wc 一致）
$ node scripts/diag-b.mjs --json --target <无末尾换行的 .ts>   → lines 2, bytes 3   （编辑器口径正确）
```

---

## 2. 实现者的 E2E 证据可复跑（本轮从产物库直接取出重跑）

```
$ shasum -a 256 <artifact: deliverables/diag-b-e2e-harness@1>
7c2e5beed32533375d13b26174e68c3beabd1847c283fa7a80be2240158571b9     # 与发布时一致
$ node <该文件>
fixture (hand-computed oracle): core=2 files/4 lines, runtime=1/2, web=1/4, total=4 files/10 lines, 2 skipped
  ok ×8  fixture
  ok ×8  real src tree（6 个模块与一次独立递归遍历逐个对齐）
  ok      real total equals sum of modules / non-empty
  ok      node --run typecheck passes
  ok      node --run lint passes
ALL PASSED (19 checks)          exit=0
```

该 harness 把脚本当黑盒（spawn + 只读 stdout/退出码，不 import 实现），fixture 用手算 oracle 且覆盖「无末尾换行」与「被跳过的 PNG + JSON」，真实树用另一套遍历交叉验证，符合「E2E 优先、断言只对外部行为」。

---

## 3. 同族排查：review-c 曾判 fail 的那一类缺陷，车道 b 不存在

review-c 对车道 c 的阻塞结论是：`argv[1]` 与 `import.meta.url` 比对构成的入口守卫，在**符号链接调用**下静默 `exit 0`、零输出。车道 b 的 `import.meta.url` 只用于「按脚本自身位置推仓库根」，不与调用路径比对：

```
$ grep -n 'argv\[\|import\.meta\.url' scripts/diag-b.mjs
31:  const scriptDirectory = resolve(fileURLToPath(import.meta.url), '..');   # 自身位置
51:    const argument = argv[index];                                          # 仅参数解析
58:      target = argv[index + 1];
```

| 调用写法 | exit | stdout 指纹 |
| --- | --- | --- |
| 绝对 realpath | 0 | `c882af3544cd…` |
| 绝对符号链接 | 0 | `c882af3544cd…` |
| 符号链接 + 相对路径（cwd = 链接所在目录） | 0 | `c882af3544cd…` |
| cwd 内相对路径 | 0 | `c882af3544cd…` |

四种写法**逐字节相同**（distinct digests = 1），stderr 全空。车道 b 不存在该族缺陷。

---

## 4. 非阻塞发现（5 条，均不建议为此返工）

### 4.1 树内的符号链接被静默丢弃，连 `skipped` 都不计（本轮再次复现，机制与最坏形态不变）

机制：`listChildren` 用 `readdir(withFileTypes)`，其类型判定是 **lstat 语义** —— 符号链接既 `isDirectory() === false` 又 `isFile() === false`，于是既不进模块桶、也不进 `skipped`，直接消失。

```
$ find fx/real -mindepth 1 ! -type f ! -type d
fx/real/linked-file.ts -> mod/one.ts     fx/real/linked-dir -> mod/
$ node scripts/diag-b.mjs --target fx/real
real/mod        2      3      6
TOTAL           2      3      6
1 non-source file(s) skipped.          # 只有 data.json；两个链接彻底消失，无任何提示
```

**最坏形态（有效链接，源码只能经树内符号链接到达）**：整棵树报 `0`，且没有任何提示：

```
$ ln -sfn ../elsewhere fx2/tree/linked-src && test -d fx2/tree/linked-src && echo YES
YES
$ find -L fx2/tree -type f
fx2/tree/linked-src/only.ts                       # 跟随链接能看到 1 个 5 行的 .ts
$ node scripts/diag-b.mjs --target fx2/tree
TOTAL            0            0            0        0.0        exit=0   stderr=0B
$ node scripts/diag-b.mjs --target fx2/elsewhere      # 对照：直指真实目录
elsewhere        1            5           10        5.0        exit=0
```

树内「指向文件的符号链接」还会**少报**：`tree/real.ts` + `tree/alias.ts -> real.ts` 报 `1 files / 2 lines`（跟随/计入应为 2 个文件）。

**为何仍判非阻塞**（三条可验证事实）：①本交付物的用途是报告**本仓库 `src/`** 的规模，而 `find src -mindepth 1 ! -type f ! -type d | wc -l` = **0** —— 默认目标上不存在这个缺口；②已发布的 `196 / 53,915 / 2,652,346` 用三套独立工具重算过，是完整的；③触发需要使用者主动把 `--target` 指到一棵含符号链接的第三方目录。**一行修法**：在 `listChildren` 里把既非目录也非文件的条目计入 `skipped`（或跟随链接）；改完不影响本仓库任何数字。

### 4.2 模块切分硬编码 POSIX 分隔符

`moduleOf` 用 `rel.indexOf('/')` 切模块；Windows 上 `path.relative` 返回 `\`，所有文件会塌进同一个裸 prefix 桶。本仓库无 Windows runner，仅作记录。

### 4.3 `--target` 会吞掉紧跟的开关

`node scripts/diag-b.mjs --target --json` 把 `--json` 当路径，报 `ENOENT … '--json'` 并 exit 1。退出码正确、也没有静默错算，只是报错信息不够直白。

### 4.4 「先写测试再实现」的过程主张在仓库里无法复核

车道是单次提交（`6c0d039` 一次成型），仓库内没有留下先红的运行记录，harness 也只存在于产物库（以维持「只新增一个文件」）。这是过程主张而非产品主张，且 harness 本轮 19/19 可复跑，故不判 fail。

### 4.5 本轮新增：`Bytes` 列是「解码后文本的 UTF-8 字节数」，不等于文件大小

`bytes` 由 `Buffer.byteLength(await readFile(file,'utf8'))` 得到。若某个「源码」文件含非法 UTF-8 字节，解码会把它替换成 U+FFFD（3 字节），字节数**变大**：

```
$ stat -f%z ok.ts bad.ts            →  4 / 14        （磁盘共 18 字节）
$ node scripts/diag-b.mjs --json --target <该目录>
"total": {"files":2,"lines":4,"bytes":24}          # 比磁盘多 6 字节（3 个坏字节各膨胀 2）
```

**为何仍判非阻塞**：本仓库 196 个被统计文件全部是合法 UTF-8 文本 —— 独立重算的 `stat -f%z` 求和 **2,652,346** 与脚本 `total.bytes` **完全相等**，所以已发布的字节数没有偏差；触发需要有人把 `--target` 指到含二进制内容的目录（那时该文件也多半不该按 `.ts` 计入）。**文档口径**：`Bytes` 应写成「文件内容的 UTF-8 字节数」，不要写成「磁盘占用」。

---

## 5. 门禁复跑 + 红门禁的中立性（本轮做了 2×2 交叉实验，并修正第 4 轮的一处断言）

### 5.1 门禁结果

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `node --run typecheck` | 0 | |
| `node --run lint` | 0 | |
| `node --run check:evidence` | 0 | `Acceptance evidence is unchanged.` |
| `node --run check` | **1** | `Test Files 42 failed \| 175 passed (217)`、`Tests 128 failed \| 1340 passed (1468)`、Duration 219.67 s |

42 个失败文件全部落在 `tests/console`(11) / `m0`(3) / `m3`(5) / `m7`(4) / `m8`(19)；**没有任何一个失败提到本车道**（`grep -nE 'diag-b|scripts/diag' check.log` = 0 命中）。三个数字与第 1–4 轮**逐个相同**。

### 5.2 两侧对照（本轮实测，与第 4 轮的说法不同）

把车道基线 `7165551` 整棵树 `git archive` 到 `/tmp/rvb-attempt5/base`（该树里一个 `diag-*.mjs` 都没有），对五个失败目录各跑一次：

```
基线 7165551（/tmp，188 个测试文件）   Test Files  41 failed | 147 passed (188)   Tests  127 failed
HEAD  e802596（工作副本）              Test Files  42 failed | 146 passed (188)   Tests  128 failed
失败文件集合差异：基线独有  tests/console/rsi.test.ts
                  HEAD 独有 tests/m8/integration.test.ts、tests/m8/startup.test.ts
                  共同    40 个文件
```

**修正**：第 4 轮报告写的是「两侧 42/128 完全相同」。本轮实测**不是**相同。下面用交叉实验把这 3 个文件的差异定位。

### 5.3 交叉实验：差异来自「检出位置」，不来自「内容」

| 被测文件 | 基线内容 @ `/tmp` | HEAD 内容 @ `/tmp` | HEAD 内容 @ 工作副本 |
| --- | --- | --- | --- |
| `tests/m8/integration.test.ts` + `tests/m8/startup.test.ts` | **11 passed** | **11 passed** | **2 failed**（`daemon exited early with 0`；CLI 入口用例 15s 超时） |
| `tests/console/rsi.test.ts` | **1 failed / 28 passed** | **1 failed / 28 passed** | **29 passed** |

同一份 HEAD 内容（含全部三个 `diag-*.mjs`）放到 `/tmp` 就 11/11 全过、放回工作副本就挂 —— 说明 `m8/integration` 与 `m8/startup` 的失败由**工作副本的父目录布局**（同级还有 8 个 worktree 目录等）决定，与三条车道新增的文件无关；反过来 `rsi.test.ts` 在任何 `/tmp` 副本里都失败、在工作副本里通过，因为它的期望值由检出路径 `realpath` 推导（`expect(resolveRsiRoot({}, '/nowhere')).toBe(await realpath(graphAppRoot))`），换目录就变。

配合 §0 的事实（`7165551..HEAD` 对 `src/`、`tests/` 的 diff **为空**），红门禁与三条车道的因果关系被彻底排除。

**对下游的含义**：`full-tests` 节点跑的是同一条 `node --run check`，且它所在的 `integration` 检出与本工作副本**同父目录**，所以上面这些失败在它上面同样会发生；`{from: full-tests, to: merge}` 的回边会因此反复唤醒 `merge`，而 `merge` 只改 `scripts/README.md`，改不动 `tests/`。**这是布局问题，不是交付物问题；人工验收时不要把它算到三条车道的账上。**

---

## 6. 给 merge 的硬约束

1. **禁止把 §4.1 的记账缺口写进 README 的能力描述。** 可以说「按模块目录统计源码规模、行数与字节」，**不要**写成「遍历目标目录下的所有文件」—— 含符号链接时后者不成立（`TOTAL 0` 且 exit 0）。
2. **`Bytes` 口径写准**（§4.5）：是「文件内容的 UTF-8 字节数」，不是「磁盘占用」；本仓库实测两者相等（2,652,346），但口径不要含糊。
3. README 里 `diag-b` 的用法示例照抄已实测的三条：`node scripts/diag-b.mjs`、`--json`、`--target <dir>`，并注明默认目标是 `<repo>/src`。
4. 三条车道的数字口径互不相同且**都对**（a：测试面 216 文件 / 1422 声明；b：源码规模 196 / 53,915 / 2,652,346；c：npm 脚本 30 个），README 不要把它们混成「同一套指标的三种叫法」。
5. **操作提示**：`scripts/diag-b.mjs` 在其他分支上有同名不同内容的历史版本（上一个任务的图里 impl-b 也做过），合并要按 commit 挑文件，不要按文件名挑。
6. harness 只存在于产物库、不在仓库内（这是为了让车道严格只新增一个文件），README 不要把它写成「仓库内的测试」。
7. **不要把 `node --run check` 的红当成交付缺陷**（§5.3），也不要在 README 或验收说明里承诺「全量测试通过」。

---

## 7. 判定

| lookFor | 判定 |
| --- | --- |
| 脚本是否只读、是否只用 node 内置模块 | ✅ |
| 是否确实只新增了这一个文件、未改动任何现有文件 | ✅ |
| 统计结果是否正确、运行是否可重复 | ✅ |

**verdict = pass，`route = 'pass'`。** 3 条 lookFor 在第 5 个检出（`e802596`）上复跑成立，**0 个阻塞项**，返工理由：无。

非阻塞发现 5 条：§4.1（符号链接静默丢弃）、§4.2（POSIX 分隔符硬编码）、§4.3（`--target` 吞开关）、§4.4（过程主张不可复核）、**§4.5（本轮新增：`Bytes` 是解码后字节数）**。
本轮相对第 4 轮的净变化：0 个新增阻塞项、1 条新增非阻塞发现、1 处对第 4 轮断言的**修正**（红门禁两侧并非完全相同，差异已用 2×2 交叉实验定位到检出位置）。
