# 独立审查：车道 b —— `scripts/diag-b.mjs` —— pass

- 审查节点：`review-b`（agent 路由器，`routes ['pass','fail']`，`input.route.declared=null`）
- 审查对象：impl-b 提交 `6c0d039`（`graph:impl-b:af0aed52-…`），其父为合流提交 `f3d0ced`（`f3d0ced` 的另一侧是车道基线 `7165551`）；第 1 轮工作副本 HEAD = `f3d0ced`，第 2 轮复跑 HEAD = `7eafb82`，第 3 轮复跑 HEAD = `28d5797`（三次都是同一被审提交 `6c0d039`，文件指纹三次均未变，见 §6.2 与 §7.2）
- 审查依据：impl-b 交付件 `graph://tasks/a621e9d6-…/artifacts/deliverables/diag-b-report@1`（digest `1eac27e6…`）与黑盒 E2E harness `deliverables/diag-b-e2e-harness@1`（digest `7c2e5bee…`）
- 被审文件指纹：`sha256(scripts/diag-b.mjs) = aba9bf43301a68e83947c2f54b6fa629edc3d274ebe618d5c455a2ae7847c1c6`
- 结论：**pass** —— 5 条 lookFor 全部成立，**0 个阻塞项**；4 条非阻塞发现（均不在本车道必改范围），另附 1 条**不属于本车道、但会卡死下游 `full-tests`** 的图级风险。第 3 轮复跑结论不变（§7）

> **第 2 轮复跑（同一会话，operation `1c299710`）**：5 条 lookFor 在合并后的 HEAD `7eafb82`（已含 impl-a/impl-c/review-a/review-c）上**复跑全部仍成立**，被审文件仍逐字节同指纹 `aba9bf43…`，数字仍是 `196 / 53,915 / 2,652,346`（兄弟车道新增的文件全在 `scripts/`、`reviews/`，不落在 `src/` 下，所以合流没有扰动本车道口径）。impl-b 的 E2E harness 从产物库取出重跑仍 19/19。**结论不变：pass，0 阻塞项，返工理由仍为空。**
>
> 第 1 轮两处说法在本轮被更硬的证据取代，**以此为准**：
> 1. **基线提交写错了一个**（§0/§3）：本车道的车道前基线是 **`7165551`**，不是 `3cf2e35`。`3cf2e35` 是 `7165551` 的父提交，而 `7165551` 本身已改过 `tests/console/review-as-router.test.ts`（属既有 harness 提交）。第 1 轮拿 `3cf2e35` 当基线，等于比在了更早的一侧。
> 2. **§3 对红门禁的归因过软**（原文归为「负载抖动 / 跨检出临时路径」）：本轮拿到了具体机制，见 §6。`node --run check` 仍然红，数字与第 1 轮完全一致（42 文件 / 128 用例），**没有变好也没有变坏**。
>
> **第 3 轮复跑（同一会话，operation `a752b543`，HEAD `28d5797`，已并入 review-c 的 `b8480ee`）**：图未记录任何下游证据失败，故本轮把 5 条 lookFor 与图级风险在**第三个集成检出**上从零重跑。被审文件仍是 `aba9bf43…`，`git log --oneline HEAD -- scripts/diag-b.mjs` 只有 `6c0d039` 一条。数字仍是 `196 / 53,915 / 2,652,346`；`node --run check` 仍是红的，且三个数字与前两轮**逐个相同**（42 / 175 / 217，128 / 1340 / 1468）。本轮新增两项此前没做过的取证：①**针对 review-c 在车道 c 上判 fail 的那一类缺陷做同族排查**（`argv[1]` 入口守卫 → 符号链接下静默退出 0），结论是**车道 b 不存在该缺陷**，四种调用写法输出逐字节相同；②把符号链接记账缺口的**最坏形态**跑出来了（一棵源码全在符号链接后的目录会报 `TOTAL 0/0` 且 exit 0、无任何提示），仍判非阻塞，理由见 §7.6。**结论不变：pass，0 阻塞项，返工理由仍为空。**

---

## 0. 审查对象绑定

```
$ git show --name-status --format='%H %s' 6c0d039
6c0d03923cfc8f1ce53688092c2eb6def5daea59 graph:impl-b:af0aed52-066b-4259-8b0c-d2cabfa956ad
A	scripts/diag-b.mjs

$ git show --stat 6c0d039
 scripts/diag-b.mjs | 200 +++++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 200 insertions(+)
```

车道提交恰好等于「新增 `scripts/diag-b.mjs` 一个文件」，200 行全为新增，既有文件的 M/D/R 数为 0。

---

## 1. lookFor 逐条核对

### 1.1 脚本是否只读 —— 成立（静态 + 动态两路取证）

**静态**：全文 200 行，只 import 三个 `node:` 内置模块；副作用只有 `console.log` / `console.error` / `process.exit`。

```
$ grep -nE "writeFile|appendFile|mkdir|rm\(|unlink|rename|createWriteStream|copyFile|chmod|truncate|rmdir|spawn|exec|process\.chdir|process\.env" scripts/diag-b.mjs
NONE
```

**动态**：对工作副本 1110 个条目（排除 `.git`、`node_modules`）做跑前/跑后指纹，连跑 3 次：

```
$ for i in 1 2 3; do node scripts/diag-b.mjs > /tmp/rvb/run$i.txt 2>/tmp/rvb/run$i.err; echo "run$i exit=$?"; done
run1 exit=0
run2 exit=0
run3 exit=0
$ wc -c /tmp/rvb/run{1,2,3}.err
0 / 0 / 0                      # stderr 全空
$ diff /tmp/rvb/tree-before.txt /tmp/rvb/tree-after.txt && echo "TREE IDENTICAL"
TREE IDENTICAL
$ shasum -a 256 scripts/diag-b.mjs
aba9bf43301a68e83947c2f54b6fa629edc3d274ebe618d5c455a2ae7847c1c6   # 跑前跑后一致
$ git status --porcelain
GIT CLEAN                      # 无未跟踪残留
```

只读成立，且是「跑完之后工作副本逐字节不变」这一级别，不只是看代码。

### 1.2 是否只用 node 内置模块 —— 成立

```
$ grep -n "^import" scripts/diag-b.mjs
19:import { readdir, readFile } from 'node:fs/promises';
20:import { basename, extname, join, relative, resolve } from 'node:path';
21:import { fileURLToPath } from 'node:url';
```

三个 import 全是 `node:` 协议内置。车道提交不含 `package.json` / `pnpm-lock.yaml`，即零新增依赖。

### 1.3 是否只新增了这一个文件、未改动任何现有文件 —— 成立

见 §0。三条零耦合旁证：

- 全仓检索 `diag-b`：**0 处引用**（`scripts/diag-b.mjs` 自身除外）。该脚本不被任何测试或产品代码加载。
- `tsconfig.json` 的 `include` 是 `["src/**/*.ts","desktop/**/*.ts","tests/**/*.ts","examples/**/*.ts","vitest.config.ts"]` —— `scripts/**` 不在 typecheck 范围内。
- `node --run lint`（`scripts/check-floating-promises.mjs`）不扫描 `scripts/`。

所以这 200 行对现有门禁零影响，与 §3 的实测一致。

### 1.4 统计结果是否正确 —— 成立（本审查独立重算，未采信实现者的口径）

用**另一套工具**（`find` + `wc -l` + `tail -c1` 探测末尾换行 + `stat -f%z`）逐模块重算，与脚本输出逐格比对：

| 模块 | 脚本 files/lines/bytes | 独立重算 | |
| --- | --- | --- | --- |
| src/catalog | 15 / 2,525 / 120,625 | 15 / 2525 / 120625 | ✅ |
| src/core | 44 / 13,979 / 753,600 | 44 / 13979 / 753600 | ✅ |
| src/git | 3 / 1,270 / 67,656 | 3 / 1270 / 67656 | ✅ |
| src/runtime | 55 / 13,467 / 680,135 | 55 / 13467 / 680135 | ✅ |
| src/server | 16 / 4,738 / 220,316 | 16 / 4738 / 220316 | ✅ |
| src/web | 63 / 17,936 / 810,014 | 63 / 17936 / 810014 | ✅ |
| **TOTAL** | **196 / 53,915 / 2,652,346** | **196 / 53915 / 2652346** | ✅ |

- **分模块求和 = TOTAL**（196 = 15+44+3+55+16+63；53,915 与 2,652,346 同）——内部自洽。
- **扩展名分解**独立重算同样逐项吻合：`.ts` 158/40,025、`.tsx` 31/9,770、`.css` 4/3,988、`.cjs` 1/40、`.html` 1/13、`.mjs` 1/79；求和 196 文件 / 53,915 行，与 TOTAL 一致。
- **Top-10 最大文件**用 `wc -l | sort -k1,1nr` 独立排出，与脚本输出顺序与数值完全一致（`styles.css` 3656、`task-runtime.ts` 2394、`operation-lifecycle.ts` 1387 …）。
- **skipped = 2** 核对无误：`src/web/assets/graph-icon.png`（1,108,537 B）与 `src/catalog/models-dev.snapshot.json`（5,215,991 B，1 行）。全树 198 个常规文件 = 196 计数 + 2 跳过，无遗漏。
- **行数口径**：全部 196 个文件末尾都有换行（`nont=0`），故 `wc -l` 与「编辑器口径」两种算法在本树必然相等；脚本的口径本身在 impl-b 的 fixture 上被无末尾换行的文件单独验过（见 §1.6）。
- **bytes 口径**：脚本量的是 `Buffer.byteLength(utf8解码后的文本)`，本树 6 个模块的合计与 `stat -f%z` 逐字节相等，说明这些文件全是合法 UTF-8，该口径在本树无误差。

另测 CLI 全表：`--help` → exit 0；`--target src/git` → exit 0 且正确走「文件直接位于 target 根」分支（module 桶名 `git`，3 文件/1,270 行）；`--target <不存在目录>` → `diag-b: ENOENT …` exit 1；`--target <文件>` → `ENOTDIR` exit 1；`--target`（缺值）→ 明确报错 exit 1；`--bogus` → `unknown argument` exit 1；空目录 → 不崩，输出 0/0 并打印 `Largest files (top 0)`。

### 1.5 运行是否可重复 —— 成立

连续 3 次运行 stdout 逐字节相同、stderr 全空、退出码全 0（见 §1.1 命令）。可重复性有设计支撑：模块与扩展名按名称排序，largest 按 `行数降序 → 路径升序` 排序，即目录遍历顺序（LIFO 栈）不会泄漏到输出。`--json` 两次运行同样逐字节一致。

### 1.6 实现者的 E2E 证据可复跑（本审查独立复跑，不采信其结论）

把 `deliverables/diag-b-e2e-harness@1` 从产物库直接取出、在本工作副本里重跑：

```
$ node <artifact:deliverables/diag-b-e2e-harness@1>
fixture (hand-computed oracle): core=2 files/4 lines, runtime=1/2, web=1/4, total=4 files/10 lines, 2 skipped
  ok  fixture run exits 0
  … 8 项 fixture 检查
  ok  src/catalog matches independent walk (15 files / 2525 lines)
  … 6 个真实模块逐一吻合
  ok  node --run typecheck passes
  ok  node --run lint passes

ALL PASSED (19 checks)
```

该 harness 把被审脚本当黑盒（`execFile` spawn、只读 stdout 与退出码，不 import 实现），fixture 用**手算 oracle**且含「无末尾换行的文件」与「被跳过的 PNG + JSON」，真实树用**另一套递归遍历**交叉验证 —— 符合「E2E 优先、断言只对外部行为」的要求，是可复跑的留痕件（不是一句「我测过了」）。

---

## 2. 非阻塞发现（4 条，均不建议为此返工）

### 2.1 非普通文件（符号链接等）被静默丢弃，且连 `skipped` 都不计 —— `scripts/diag-b.mjs`

`listChildren` 只认 `isDirectory()` / `isFile()`；符号链接两者皆非，于是既不进任何模块桶、也不进 `skipped`。fixture 实测：

```
$ find /tmp/rvb/fixture/real -type f      # 真实存在的 3 个常规文件
/tmp/rvb/fixture/real/data.json
/tmp/rvb/fixture/real/mod/one.ts
/tmp/rvb/fixture/real/mod/two.ts
（另有 linked-file.ts -> mod/one.ts、linked-dir -> mod/ 两个符号链接）

$ node scripts/diag-b.mjs --target /tmp/rvb/fixture/real
Module      Files  Lines  Bytes
real/mod        2      5     10
TOTAL           2      5     10
1 non-source file(s) skipped.        # 只有 json；两个链接彻底消失，无任何提示
```

一个含符号链接源码的目录会被**静默少报**，而这类工具最危险的失效模式正是「安静地少报」。**本仓库不受影响**：`find src -mindepth 1 ! -type f ! -type d` 输出为空，`src/` 下无任何符号链接，故已发布的 196/53,915/2,652,346 是完整的。属潜在记账缺口，非当前错误。

### 2.2 模块切分硬编码 POSIX 分隔符 —— `scripts/diag-b.mjs`

`moduleOf` 用 `rel.indexOf('/')` 切模块；Windows 上 `path.relative` 返回 `\`，所有文件会塌进同一个裸 prefix 桶，分模块表失去意义。本仓库无 `.github/`、无 Windows runner，开发与门禁都在 macOS/Linux，故不构成现实缺陷，仅作记录。

### 2.3 `--target` 会吞掉紧跟的开关 —— `scripts/diag-b.mjs`

`node scripts/diag-b.mjs --target --json` 会把 `--json` 当成路径：

```
$ node scripts/diag-b.mjs --target --json
diag-b: ENOENT: no such file or directory, scandir '…/review-b/--json'   # exit 1
```

退出码正确、也没有静默错算，属报错信息不够直白的小瑕疵。

### 2.4 实现者「先写测试再实现」的过程主张无法从仓库复核

impl-b 报告称「harness 先写先跑、因脚本缺失而 exit 1 失败，之后才写 `scripts/diag-b.mjs`」。车道是**单次提交**（`6c0d039` 一次成型），仓库内没有留下先红的运行记录，harness 也刻意放在产物库而非仓库以维持「只新增一个文件」。这是过程主张而非产品主张，且 harness 本身 19/19 可复跑（§1.6），故不判 fail；只是「先红后绿」在本车道缺少可回溯的留痕。

---

## 3. 图级风险：不属于车道 b，但会让下游 `full-tests` → `merge` 回边空转

`node --run check` 在本集成副本上是**红的**：`Test Files 42 failed | 175 passed (217)`、`Tests 128 failed | 1340 passed (1468)`，失败集中在 `tests/m0|m3|m7|m8|console`。

**已证明与本车道无关**（比实现者的自证方法更干净：不是「临时移除文件」，而是把**车道工作开始前的基线提交 `3cf2e35` 整个解包到 /tmp**，那棵树里一个 `diag-*.mjs` 都没有）：

| 检出 | test files failed | tests failed | tests passed |
| --- | --- | --- | --- |
| HEAD `f3d0ced`（含 diag-b.mjs） | 42 | 128 | 1340 |
| 基线 `3cf2e35`（**无任何 diag-*.mjs**） | 42 | 128 | 1340 |

两次失败文件清单 42 项对 42 项，差异仅 4 项且全部有独立解释：`tests/console/rsi.test.ts`（只在我解包到 `/tmp/rvb/base` 时失败，断言 `GRAPH_RSI_ROOT` 等于工程根，是我的临时路径造成的）、`tests/m1/recovery.test.ts` 与 `tests/m8/startup.test.ts`（均为 `Test timed out in 15000ms`）、`tests/m8/integration.test.ts`（`daemon exited early with 0`）——典型的负载抖动。

失败根因是环境，不是代码：日志里出现 `spawnSync git ENOENT`、`Command failed: /usr/bin/which npm`、`node:internal/modules/package_json_reader`、`ENOENT …/12-MediaBookmarks/src/config.js`（跨检出临时路径）。`node --run typecheck` 与 `node --run lint` 均 exit 0，红的只有 `vitest` 那一段。

**对下游的影响**：`full-tests` 节点跑的就是 `node --run check`，它会判不过并按图声明回边把 `merge` 叫醒；但重跑 `merge` 改的是 README，改不动这 128 个测试。**这条回边会空转到 stalled，而原因是环境不是交付物。** `.githooks/pre-push` 同样执行 `node --run check`，因此任何推送动作也会被同一原因挡下。请人工验收时按此判断，不要把它算到三条车道的账上（review-c 已在 `reviews/review-c@1` 独立记录了同一现象）。

---

## 4. 给 merge 的三条硬约束

1. **禁止把 2.1 的记账缺口写进 README 的能力描述。** README 可以说「按模块目录统计源码规模、行数与字节」，**不要**写成「遍历目标目录下的所有文件」——含符号链接时后者不成立。
2. README 里给 `diag-b` 的用法示例请照抄已实测的三条：`node scripts/diag-b.mjs`、`--json`、`--target <dir>`，并注明默认目标是 `<repo>/src`。
3. 三条车道的数字口径互不相同且**都对**（a 统计测试面 216 文件/1422 声明，b 统计源码规模 196/53,915，c 统计 npm 脚本 30 个），README 不要把它们混成「同一套指标的三种叫法」。

---

## 5. 判定

| lookFor | 判定 | 关键证据 |
| --- | --- | --- |
| 脚本是否只读 | ✅ | 3 次运行后 1110 条目指纹不变、git clean、写类 API 扫描 0 命中 |
| 是否只用 node 内置模块 | ✅ | 3 个 `node:` import，车道提交不含 lockfile/package.json |
| 是否只新增 1 个文件、未改现有文件 | ✅ | `git show --name-status` = `A scripts/diag-b.mjs`；全仓 0 引用；不在 typecheck/lint 扫描范围 |
| 统计结果是否正确 | ✅ | 6 个模块 + 扩展名分解 + Top-10 全部用独立工具重算并逐格吻合；分模块求和 = TOTAL |
| 运行是否可重复 | ✅ | 3 次 stdout 逐字节一致、stderr 全空、退出码全 0；输出排序不依赖遍历顺序 |

**verdict = pass**，`route.case = 'pass'`。5 条 lookFor 全部成立，0 个阻塞项。返工理由：无。

---

## 6. 第 2 轮复跑记录（operation `1c299710`，HEAD `7eafb82`）

### 6.1 触发原因

图已推进：三条实现者 + 三条评审全部合入任务分支，`HEAD` 从第 1 轮的 `f3d0ced` 前进到 `7eafb82`。本节把 5 条 lookFor 与图级风险在**新的集成检出**上重跑一遍，确认第 1 轮的 pass 没有因为合流而过时。

### 6.2 被审对象没变

```
$ shasum -a 256 scripts/diag-b.mjs
aba9bf43301a68e83947c2f54b6fa629edc3d274ebe618d5c455a2ae7847c1c6     # 与第 1 轮逐字节一致

$ git show --name-status --format='%H %s' 6c0d039
A	scripts/diag-b.mjs                                                  # 仍是唯一新增，既有文件 M/D/R = 0

$ for c in d1d954a 989ad2f 6c0d039 5e076f0 7336143 66ca241 a4168be; do git show --name-status --format='' $c; done
A	scripts/diag-a.mjs     A	scripts/diag-c.mjs     A	scripts/diag-b.mjs
A	review-c-report.md    A	reviews/review-a.md    A	reviews/review-b.md
M	reviews/review-a.md                                                    # review-a 第 2 轮改的它自己的产物
```

三个实现者提交各自只新增一个全新文件，没有任何一个改过仓库既有文件。

### 6.3 lookFor 复跑（全部仍成立）

| lookFor | 本轮证据 | 判定 |
| --- | --- | --- |
| 只读 | 静态扫描写/执行类 API **0 命中**；连跑 3 次 `exit=0`，`1112` 条目指纹跑前跑后 `diff` 为空（`TREE IDENTICAL`），`git status --porcelain` 空 | ✅ |
| 只用 node 内置 | 3 个 import 全 `node:` 协议；提交不含 `package.json` / lockfile | ✅ |
| 只新增 1 个文件 | 见 §6.2 | ✅ |
| 统计结果正确 | 见 §6.4 独立重算 | ✅ |
| 可重复 | 3 次 stdout 逐字节一致（`RUNS BYTE-IDENTICAL`）、stderr 全 0 字节、退出码全 0 | ✅ |

### 6.4 独立重算（换一套工具，不采信脚本口径）

```
$ for m in catalog core git runtime server web; do find src/$m -type f \( -name '*.ts' -o … \) … ; done
src/catalog       15     2525 120625
src/core          44    13979 753600
src/git            3     1270  67656
src/runtime       55    13467 680135
src/server        16     4738 220316
src/web           63    17936 810014
```

扩展名分解（`.cjs 1/40`、`.css 4/3,988`、`.html 1/13`、`.mjs 1/79`、`.ts 158/40,025`、`.tsx 31/9,770`）与 Top-10（`styles.css 3656` … `rsi.ts 1077`）同样逐项吻合脚本输出；**全树 196 个计数文件 + 2 个跳过**（`graph-icon.png` 1,108,537 B、`models-dev.snapshot.json` 5,215,991 B）= `find src -type f` 的 198 个普通文件，无遗漏、无重复计数；196 个计数文件**全部有末尾换行**（`nont=0`），故 `wc -l` 口径与本树不产生分歧；`find src -mindepth 1 ! -type f ! -type d` 为空，故 §2.1 的符号链接缺口在本树未被触发。

CLI 面复跑：`--help` 0、`--json` 0、`--target src/git` 0、`--target <不存在>` 1、`--bogus` 1、`--target`（缺值）1。§2.1 与 §2.3 两条非阻塞发现**原样复现**（fixture 里的 2 个符号链接彻底消失且不进 `skipped`；`--target --json` 报 ENOENT 退出 1）。

### 6.5 实现者的 E2E 证据可复跑

从产物库直接取 `deliverables/diag-b-e2e-harness@1`（`shasum` = `7c2e5bee…`，与发布时一致）在本检出重跑：**`ALL PASSED (19 checks)`** —— 8 项手算 fixture oracle + 9 项真实树独立遍历 + `typecheck` + `lint`。

### 6.6 门禁复跑

| 命令 | 退出码 |
| --- | --- |
| `node --run typecheck` | 0 |
| `node --run lint` | 0 |
| `node --run check:evidence` | 0 |
| `node --run check` | **非 0**：`Test Files 42 failed \| 175 passed (217)`、`Tests 128 failed \| 1340 passed (1468)`，耗时 199 s |

`node --run check` = `typecheck && lint && test && check:evidence`，前两段通过、`test` 红、因此 `check:evidence` 在 `check` 链路里没跑到（单独跑是 0）。三个数字与第 1 轮**完全相同**。

### 6.7 红门禁的机制（取代 §3 的「负载抖动」说法）

第 1 轮只说到「环境」，本轮拿到可复现的具体原因之一：

```
$ node node_modules/vitest/vitest.mjs run tests/m7/page.test.ts
FAIL  tests/m7/page.test.ts > B站 page requires login …
Error: ENOENT: no such file or directory, copyfile
  '<task-worktree-dir>/12-MediaBookmarks/src/config.js' -> '/var/folders/…/graph-m7-page-…/src/config.js'
 ❯ tests/m7/page.test.ts:18:3
    18|   await copyFile(join(process.cwd(), '..', '12-MediaBookmarks', 'src', …

$ ls ..                     # 工作副本的父目录
graph-m7-acceptance  impl-a  impl-b  impl-c  integration  review-a  review-b  review-c

$ ls /Users/macmini/workspace | tr '\n' ' '   # 真实仓库的父目录
… 12-MediaBookmarks 13-Graph … graph-rsi
```

`tests/m7/page.test.ts` 与 `tests/m7/clone.ts` 从 `process.cwd()/../12-MediaBookmarks` 拷文件。该兄弟项目只存在于**真实仓库的父目录**，Graph 的工作副本父目录里只有本任务的工作树目录，于是这条 `ENOENT` 是**工作树布局造成的必然失败**，与三条车道新增的文件毫无关系。

`tests/console/*` 是另一类（例：`tests/console/presets.test.ts:87` 报 `provider.requests[0]` 为 `undefined`，即桩根本没收到请求），同样与本车道无关；本车道不负责把 42 个失败文件逐个归因。

**关键推论（对人工验收与 `full-tests`）**：`full-tests` 跑的是同一个 `node --run check`，而它所在的 `integration` 检出与本工作副本**同父目录**，因此上面这条 m7 失败在 `integration` 上同样必然发生。图上 `{from: full-tests, to: merge}` 的回边会因此反复唤醒 `merge`，而 `merge` 只改 `scripts/README.md`，改不动 `tests/`。**这是布局问题，不是交付物问题；三条 pass 不应因此被回退。**

### 6.8 本轮结论

- 5 条 lookFor 全部仍成立，**0 个阻塞项**，非阻塞发现仍是 §2.1–§2.4 四条，无新增。
- 给 `merge` 的三条硬约束（§4）不变，其中第 1 条（禁止把符号链接的记账缺口写成「遍历所有文件」）依然有效。
- `verdict = pass`，`route.case = 'pass'`，返工理由：无。

---

## 7. 第 3 轮复跑记录（operation `a752b543`，HEAD `28d5797`）

### 7.1 为什么要复跑

图里**没有任何一条下游证据被记为失败**：三条车道 + 三条评审都已合入任务分支，HEAD 从第 2 轮的 `7eafb82` 前进到 `28d5797`（并入了 review-c 的 `b8480ee`，而 review-c 对**车道 c** 判了 fail）。因此本轮不是「按失败返工」，而是把本节点喂给下游的 5 条 lookFor 逐条**在新的集成检出上重跑一遍**，确认前两轮的 pass 没有因为合流而过时，并补上此前两轮没做的同族排查。

### 7.2 被审对象仍然没变

```
$ git rev-parse --short HEAD
28d5797
$ git log --oneline -3
28d5797 Merge branch '…/review-c' into graph/task/zhong-deng-…
b8480ee graph:review-c:76b32066-b148-4697-9510-c5d70729500c
bf47906 graph:review-b:a752b543-3196-4c73-b8e4-5ae4be854a16   # 第 2 轮本节点自己的提交

$ shasum -a 256 scripts/diag-b.mjs
aba9bf43301a68e83947c2f54b6fa629edc3d274ebe618d5c455a2ae7847c1c6   # 第 1、2、3 轮同一指纹

$ git log --oneline HEAD -- scripts/diag-b.mjs
6c0d039 graph:impl-b:af0aed52-066b-4259-8b0c-d2cabfa956ad          # HEAD 历史里只有这一条

$ git show --name-status --format='' 6c0d039
A	scripts/diag-b.mjs                                               # 仍是唯一新增，既有文件 M/D/R = 0

$ git diff --name-status 7165551..HEAD
A	review-c-report.md      A	reviews/review-a.md      A	reviews/review-b.md
A	scripts/diag-a.mjs      A	scripts/diag-b.mjs       A	scripts/diag-c.mjs
```

三条车道 + 三条评审**全部只做新增，没有任何一条改过仓库既有文件**，所以车道 b 的数字口径不会被合流扰动（兄弟车道新增的文件都在 `scripts/`、`reviews/` 与根目录，不落在 `src/` 下）。

> **给 merge 的一个操作提示（§7.7 的具体来源）**：`git log --all -- scripts/diag-b.mjs` 会看到 **4 个不同的 blob**，其中 `8512b60` / `50eb7be` / `31b829b` 属于**上一个任务**的分支 `graph/task/zhong-deng-dang-graph-xing-zhuang-a-ben-a2d46de9`（impl-b 在那个图里也做过同名脚本），只有 `6c0d039` 属于本图。合并时请按 commit 挑文件，不要按文件名挑。

### 7.3 只读（静态 + 动态）——成立

```
$ grep -nE "writeFile|appendFile|mkdir|rm\(|unlink|rename|createWriteStream|copyFile|chmod|truncate|rmdir|spawn|exec|child_process|process\.chdir|process\.env|fetch\(|http" scripts/diag-b.mjs
NONE
$ grep -n "^import" scripts/diag-b.mjs
19:import { readdir, readFile } from 'node:fs/promises';
20:import { basename, extname, join, relative, resolve } from 'node:path';
21:import { fileURLToPath } from 'node:url';

$ for i in 1 2 3; do node scripts/diag-b.mjs > run$i.txt 2> run$i.err; echo "run$i exit=$?"; done
run1 exit=0   run2 exit=0   run3 exit=0
$ wc -c run{1,2,3}.err
0 / 0 / 0
$ diff -q run1.txt run2.txt && diff -q run1.txt run3.txt && echo RUNS BYTE-IDENTICAL
RUNS BYTE-IDENTICAL
$ node scripts/diag-b.mjs --json > json1.txt; node scripts/diag-b.mjs --json > json2.txt; diff -q json1.txt json2.txt && echo JSON DETERMINISTIC
JSON DETERMINISTIC

# 工作副本 1030 个文件（排除 .git、node_modules）跑前/跑后指纹
$ diff -q tree-before.txt tree-after.txt && echo "TREE IDENTICAL"
TREE IDENTICAL
$ git status --porcelain
(空)
```

3 个 import 全是 `node:` 内置；车道提交不含 `package.json` / lockfile；跑完之后 1030 个文件逐字节不变，工作副本干净。零耦合旁证仍成立：全仓 `diag-b` 的引用只有 `scripts/diag-b.mjs` 自身和三份评审报告（`reviews/review-a.md`、`reviews/review-b.md`、`review-c-report.md`），`package.json` 的 scripts 里没有它，`tsconfig.json` 的 `include` 不含 `scripts/**`，`node --run lint`（`scripts/check-floating-promises.mjs`）也不扫 `scripts/`。

### 7.4 统计结果——用第三套工具重算，逐格吻合

第 1 轮用 `find`+`wc -l`，第 2 轮换了一次实现；本轮改用**第三条完全不同的路径**：`git ls-files`（版本库视角的 198 个跟踪文件）→ `case` 语句过滤扩展名（不做通配展开）→ `wc -l` 数行、`stat -f%z` 数字节。

```
$ git ls-files src | wc -l            → 198
独立筛出的源码文件                        → 196
src/catalog     15 files   2525 lines  120625 bytes  nont=0
src/core        44 files  13979 lines  753600 bytes  nont=0
src/git          3 files   1270 lines   67656 bytes  nont=0
src/runtime     55 files  13467 lines  680135 bytes  nont=0
src/server      16 files   4738 lines  220316 bytes  nont=0
src/web         63 files  17936 lines  810014 bytes  nont=0
TOTAL          196 files  53915 lines 2652346 bytes  nont=0
```

与脚本输出的 `196 / 53,915 / 2,652,346` **逐格相同**；分模块求和 = TOTAL；`nont=0` 说明 196 个文件全部有末尾换行，故 `wc -l` 与脚本的 `countLines` 在本树不会分歧。

- **skipped 账目**：`comm` 比对「`find src -type f` 的 198 个」与「独立筛出的 196 个」，差集恰好 2 个 —— `src/catalog/models-dev.snapshot.json`、`src/web/assets/graph-icon.png`，与脚本的 `2 non-source file(s) skipped.` 对上，无遗漏、无重复计数。
- **符号链接**：`find src -mindepth 1 ! -type f ! -type d` 输出为空 —— `src/` 下没有任何非普通文件，所以已发布的数字是完整的（§2.1 的缺口在本树未被触发）。
- **扩展名分解**独立重算同样吻合：`.ts 158/40,025`、`.tsx 31/9,770`、`.css 4/3,988`、`.mjs 1/79`、`.cjs 1/40`、`.html 1/13`。
- **Top-10** 用 `sort -k1,1nr -k2,2` 独立排出，顺序与数值与脚本输出完全一致（`styles.css 3656`、`task-runtime.ts 2394`、`operation-lifecycle.ts 1387` … `rsi.ts 1077`）。

### 7.5 CLI 面——11 种调用全部符合退出码契约

```
(无参数)                     exit=0  stderr=0B
--help / -h                  exit=0  stderr=0B
--json                       exit=0  stderr=0B
--json --target src/git --json  exit=0  stderr=0B      # 重复开关幂等
--target src/git             exit=0  stderr=0B          # 走「文件直挂 target 根」分支
--target <绝对路径>/src       exit=0  stderr=0B
--target /definitely/not/here exit=1 stderr=74B         # ENOENT
--target scripts/diag-b.mjs  exit=1 stderr=186B         # ENOTDIR
--target（缺值）              exit=1 stderr=38B
--bogus                      exit=1 stderr=34B          # unknown argument
```

### 7.6 同族排查：review-c 判 fail 的那一类缺陷，车道 b 没有

review-c 对车道 c 的阻塞结论是：`argv[1]` 与 `import.meta.url` 比对构成的入口守卫，在符号链接调用下**静默 exit 0、零输出**。这是「工具的退出码契约被自己的守卫推翻」，所以判 fail。本轮把同一族触发条件在车道 b 上逐条跑了一遍：

```
$ grep -n "argv\[1\]" scripts/diag-b.mjs
(无)                                    # 只有第 31 行从 import.meta.url 推 repoRoot，没有入口守卫
```

| 调用写法 | exit | stdout | stdout 指纹 |
| --- | --- | --- | --- |
| 绝对 realpath `node "$W/scripts/diag-b.mjs"` | 0 | 1371 B | `c882af35…` |
| 绝对符号链接 `node /tmp/rvb3/link-diag-b.mjs` | 0 | 1371 B | `c882af35…` |
| `$TMPDIR` 链下的符号链接（`/var` → `/private/var`） | 0 | 1371 B | `c882af35…` |
| 相对路径 `./diag-b.mjs`（cwd = 符号链接所在目录） | 0 | 1371 B | `c882af35…` |
| 相对路径 `./diag-b.mjs`（cwd = `scripts/`） | 0 | 1371 B | `c882af35…` |

五种写法输出**逐字节相同**、退出码全 0、stderr 全空。**车道 b 不存在车道 c 的那个阻塞缺陷**；车道 b 唯一的缺省定位方式是「按脚本自身位置推仓库根」，与调用路径无关。

### 7.7 非阻塞发现，本轮状态

| 编号 | 内容 | 本轮状态 |
| --- | --- | --- |
| §2.1 | 树内的非普通文件（符号链接）既不进模块桶、也不进 `skipped`，静默丢弃 | **原样复现，且本轮跑出了最坏形态**（见下） |
| §2.2 | `moduleOf` 硬编码 POSIX `/` 切模块，Windows 上分模块表会塌成一桶 | 仍未触发（仓库无 Windows runner） |
| §2.3 | `--target` 会吞掉紧跟的开关：`--target --json` 报 ENOENT | 原样复现（退出码仍是 1，只是报错信息不直白） |
| §2.4 | 「先写测试后写实现」的过程主张在仓库里没有留痕 | 性质未变（过程主张，harness 可复跑） |

§2.1 的最坏形态（**这是本轮新增的取证**，之前只报了「少报」）：

```
$ # 一棵源码全部位于符号链接之后的目录
$ find -L fx2/tree -type f        → real/only.ts（5 行）
$ node scripts/diag-b.mjs --target fx2/tree
Module      Files       Lines       Bytes  Avg lines
------  -------  ----------  ----------  ---------
------  -------  ----------  ----------  ---------
TOTAL         0           0             0        0.0
By extension
Largest files (top 0)
exit=0                                        # ← 0 文件 0 行 0 字节，退出码 0，且没有任何提示

$ # 对照：根目录本身是符号链接时 readdir 会跟随，结果正确
$ node scripts/diag-b.mjs --target fx2/tree/linked
TOTAL           1           5            10        5.0        exit=0
```

也就是说缺陷的边界很清楚：**只有「树内部」的非普通文件会被吞**，target 自身是符号链接不受影响。对本车道的判定仍然是非阻塞，理由是三条可验证的事实：①交付物的用途是报告**本仓库 `src/`** 的规模，而 `find src -mindepth 1 ! -type f ! -type d` 为空，脚本不存在 `src/` 路径；②已发布的 `196 / 53,915 / 2,652,346` 用三套独立工具重算过，是完整的；③触发需要使用者主动把 `--target` 指到一棵含符号链接的第三方目录。**但它必须继续写进 merge 的约束**：README 不得把 `--target` 描述成「遍历目标目录下所有文件」；一行修法是把 `listChildren` 里既非目录也非文件的条目计入 `skipped`（或跟随链接），改完不影响本仓库任何数字。

### 7.8 实现者的 E2E 证据可复跑

从产物库直接取 `deliverables/diag-b-e2e-harness@1`（`shasum -a 256` = `7c2e5beed32533375d13b26174e68c3beabd1847c283fa7a80be2240158571b9`，与发布时一致），在本检出重跑：

```
fixture (hand-computed oracle): core=2 files/4 lines, runtime=1/2, web=1/4, total=4 files/10 lines, 2 skipped
  ok  fixture run exits 0 …（8 项）
  ok  src/catalog matches independent walk (15 files / 2525 lines)
  …（6 个真实模块 + 2 项真实树断言）
  ok  node --run typecheck passes
  ok  node --run lint passes
ALL PASSED (19 checks)          exit=0
```

一处**留给后人的观察（非阻塞）**：harness 的真实树那一段只断言 `files` 与 `lines`，不比对 `bytes`、`largest` 与非普通文件；本轮用 `stat -f%z` 独立补齐了 bytes，`largest` 也已独立排出（§7.4）。另外 harness 只存在于产物库、不在仓库里（这是为了让车道严格只新增一个文件），README 不要把它写成「仓库内的测试」。

### 7.9 门禁复跑

| 命令 | 退出码 | 备注 |
| --- | --- | --- |
| `node --run typecheck` | 0 | |
| `node --run lint` | 0 | |
| `node --run check:evidence` | 0 | `Acceptance evidence is unchanged.` |
| `node --run check` | **1** | `Test Files 42 failed \| 175 passed (217)`、`Tests 128 failed \| 1340 passed (1468)`、Duration 223.97 s |

三个数字与第 1、2 轮**逐个相同**，既没变好也没变坏。42 个失败文件全部落在 `tests/console|m0|m3|m7|m8`；**没有一个测试引用本车道的文件**（`tests/` 里唯一出现的 `diag-` 字样是 `tests/m2/verification.test.ts:229/235` 里伪造的 multiview 评审正文里的字符串 `'scripts/diag-a.mjs'`，而 `tests/m2` 不在失败清单里）。

机制与第 2 轮一致，本轮再次在日志里看到原样的一行：

```
check.log:1257  Error: ENOENT: no such file or directory, copyfile
  '<worktree>/12-MediaBookmarks/src/config.js' -> '/var/folders/…/graph-m7-page-…/src/config.js'
check.log:1261     18|   await copyFile(join(process.cwd(), '..', '12-MediaBookmarks', 'src', …

$ ls ..            → graph-m7-acceptance impl-a impl-b impl-c integration review-a review-b review-c
$ ls /Users/macmini/workspace | grep 12-  → 12-MediaBookmarks
```

`tests/m7/page.test.ts` 等用例从 `process.cwd()/../12-MediaBookmarks` 取素材，而该兄弟项目只存在于**真实仓库的父目录**，工作副本的父目录里只有本任务的工作树目录 —— 这是**工作树布局造成的必然失败**，与三条车道新增的文件无关（日志另有 2 处 `Test timed out in 15000ms`，属负载抖动）。**对下游的含义不变**：`full-tests` 节点跑的是同一条 `node --run check`，且它所在的 `integration` 检出与本工作副本**同父目录**，所以上面这条失败在它上面同样必然发生；`{from: full-tests, to: merge}` 的回边会因此反复唤醒 `merge`，而 `merge` 只改 `scripts/README.md`，改不动 `tests/`。**这是布局问题，不是交付物问题，人工验收时不要把它算到三条车道的账上。**

### 7.10 本轮结论

- 5 条 lookFor 在第三个集成检出上**全部仍成立**，**0 个阻塞项**，非阻塞发现仍是 §2.1–§2.4 四条（§2.1 已补上最坏形态的复现），无新增阻塞项。
- 同族排查结论：review-c 在车道 c 上判 fail 的「符号链接下静默退出 0」缺陷，**车道 b 不存在**（§7.6，五种调用写法输出逐字节相同）。
- 给 merge 的三条硬约束（§4）不变；新增一条操作提示：`scripts/diag-b.mjs` 在其他分支上有同名不同内容的历史版本，合并要按 commit 挑（§7.2）。
- `verdict = pass`，`route.case = 'pass'`，返工理由：无。
