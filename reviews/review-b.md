# 独立审查：车道 b —— `scripts/diag-b.mjs` —— pass

- 审查节点：`review-b`（agent 路由器，`routes ['pass','fail']`，`input.route.declared=null`）
- 审查对象：impl-b 提交 `6c0d039`（`graph:impl-b:af0aed52-…`），父提交 `f3d0ced` 的前一侧；本审查工作副本 HEAD = `f3d0ced`
- 审查依据：impl-b 交付件 `graph://tasks/a621e9d6-…/artifacts/deliverables/diag-b-report@1`（digest `1eac27e6…`）与黑盒 E2E harness `deliverables/diag-b-e2e-harness@1`（digest `7c2e5bee…`）
- 被审文件指纹：`sha256(scripts/diag-b.mjs) = aba9bf43301a68e83947c2f54b6fa629edc3d274ebe618d5c455a2ae7847c1c6`
- 结论：**pass** —— 5 条 lookFor 全部成立，**0 个阻塞项**；4 条非阻塞发现（均不在本车道必改范围），另附 1 条**不属于本车道、但会卡死下游 `full-tests`** 的图级风险

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
