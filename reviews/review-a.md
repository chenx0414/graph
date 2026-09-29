# 独立审查：车道 a —— `scripts/diag-a.mjs` —— pass（第 6 轮复核，HEAD `191dd71`）

- 审查节点：`review-a`（agent 路由器，`routes ['pass','fail']`，`input.route.declared=null`）；交付件路径 `reviews/review-a.md`
- 审查对象：impl-a 提交 `d1d954a`（`graph:impl-a:b2c36132-…`），父提交 `7165551`；`scripts/diag-a.mjs` 的 blob 自该提交到 HEAD 未变
- 审查依据：`graph://tasks/a621e9d6-…/artifacts/deliverables/impl-a-diag-a@1`（digest `c1bf4103…`）、impl-a→review-a 私信、以及本节点前 5 轮报告 `reviews/review-a`@10
- 本轮触发原因：图中**没有**任何下游证据被记录为失败，故按指示「重跑本节点喂给下游的检查」；车道文件与判定口径均未变
- 结论：**route = `pass`**，**0 个阻塞项**；非阻塞 3 条（§3）+ 图级风险 1 条（§4）+ 车道外观察 1 条（§6）

## 0. 轮次沿革（前 5 轮结论，本轮未变，仅按新 HEAD 复跑）

| 轮次 | HEAD | 判定 | 阻塞项 | 本轮变化 |
| --- | --- | --- | --- | --- |
| 1 | `d1d954a` | pass | 0 | 5 条 lookFor 全部成立 |
| 2 | `f3d0ced` | pass | 0 | §4 由「猜测」改写为 A/B 对照证明 |
| 3 | `bf47906` | pass | 0 | 128 → 4/4；基线提交同样 4/4 |
| 4 | `640199f` | pass | 0 | 修正「探针第 5 个失败」= 自身并发负载抖动；`integration` 阻塞前移到第 1 阶段 |
| 5 | `c7193df` | pass | 0 | 计数可从干净检出复现；新增 §5(c) 软链目录静默少计 |
| **6（本轮）** | **`191dd71`** | **pass** | **0** | 5 条 lookFor 逐条重跑全绿；A/B 与基线对照第三次独立复现；`integration` 副本 HEAD 已推进到 `191dd71` 但依赖缺口未补 |

## 1. 审查对象绑定（未变）

```
$ git show --name-status --format='%H %s' d1d954a
d1d954a994fef59d1f1ea67dd2bd3367ad722e98 graph:impl-a:b2c36132-2b79-4271-96a2-858acbf83a34
A	scripts/diag-a.mjs

$ git rev-parse d1d954a:scripts/diag-a.mjs   → 8a4185ba914e7e3bd0aadae52a705cfaf7f81388
$ git rev-parse HEAD:scripts/diag-a.mjs     → 8a4185ba914e7e3bd0aadae52a705cfaf7f81388
$ git hash-object  scripts/diag-a.mjs       → 8a4185ba914e7e3bd0aadae52a705cfaf7f81388
```

车道提交恰好等于「新增 `scripts/diag-a.mjs` 一个文件」（55 行新增，0 删除），无任何 M/D/R，无依赖改动。

相对第 5 轮的 HEAD 变化（`c7193df..191dd71`，5 个提交）**只碰了两份评审报告**：

```
$ git diff --name-status c7193df HEAD
M	reviews/review-a.md
M	reviews/review-b.md

$ git diff --name-only 7165551 HEAD -- tests/ src/   | wc -l   → 0
$ git diff --name-status 7165551 HEAD                # 7 个纯新增文件
A	review-c-report.md
A	reviews/review-a.md
A	reviews/review-b.md
A	reviews/review-c.md
A	scripts/diag-a.mjs
A	scripts/diag-b.mjs
A	scripts/diag-c.mjs
```

即：三个车道从落地到最新 HEAD **从未修改过任何既有文件**（`tests/`、`src/`、`package.json` 全部 0 改动），车道 a 的文件一字节未变。起点工作副本 `git status --porcelain` 为空。

## 2. 车道 a 的 5 条 lookFor 逐条重跑（本机实测，HEAD `191dd71`）

| # | lookFor | 复跑命令 | 本轮结果 |
| --- | --- | --- | --- |
| 1 | 只读 | 静态：`grep -nE "writeFile\|appendFile\|mkdir\|rm(\|unlink\|rename\|createWriteStream\|copyFile\|chmod\|truncate\|spawn\|exec\|process\.exit\|process\.env" scripts/diag-a.mjs` | 命中 **0**（`rc=1`） |
| 1 | 只读 | 动态：1031 个文件 `path+size+mtime` 指纹，`diag-a/b/c` 三个脚本合跑前后 `diff` | 指纹**逐行相同**；`git status --porcelain` 为空 |
| 2 | 仅 node 内置 | `grep -nE "^import\|require\(" scripts/diag-a.mjs`；`node --check` | 仅 `node:fs/promises` / `node:path` / `node:url`；语法 OK |
| 3 | 只新增一个文件 | §1 的 `--name-status` + blob 三处一致 | 成立；且全仓检索 `diag-a` 仅命中 `tests/m2/verification.test.ts:229,235` 的**字符串字面量**（伪造 multiview 载荷）与脚本自身 |
| 4 | 统计正确 | `node scripts/diag-a.mjs` vs `find`/`grep` 独立复算 | 输出 `diag-a: 218 test files, 1431 test cases`；独立复算 **218** / **1431**，逐字吻合 |
| 5 | 可重复 | 连跑 3 次 `\| shasum -a 256`；`(cd /tmp && node <repo>/scripts/diag-a.mjs)`；stderr 字节数；退出码 | 3 次同为 `7dae6b3d3f453a8dea026fe9257aec1459d7b156500ad354bfadd528938ccbf6`；cwd 无关同输出；stderr **0 字节**；`exit=0` |

补充（本轮重做的可复现性取证，第 5 轮已首次做过，仍然成立）：

```
# 计数不受未跟踪 / 被忽略文件影响
$ find . -type f \( -name '*.test.*' -o -name '*.spec.*' \) -not -path './.git/*' -not -path '*/node_modules/*' \
    | sed 's|^\./||' | sort | comm -23 - <(git ls-files | sort) | wc -l        → 0（218 个计数文件全部被 Git 跟踪）
$ git status --porcelain --ignored | grep -cE '\.(test|spec)\.'               → 0（无未跟踪/被忽略的测试文件）
$ find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type l -print | wc -l   → 0（本仓树内 0 软链）
```

补充（软链调用免疫，第 5 轮已首次做过，仍然成立 —— 与车道 c 被判 fail 的那一类缺陷不同）：

```
$ ln -s "$W/scripts/diag-a.mjs" /tmp/rev-a6-link/diag-a.mjs
$ node /tmp/rev-a6-link/diag-a.mjs                        → diag-a: 218 test files, 1431 test cases   exit=0
$ ln -s "$W" /tmp/rev-a6-link/repo-link
$ node /tmp/rev-a6-link/repo-link/scripts/diag-a.mjs      → 同一行                                                  exit=0
```

根因：仓库根由 `import.meta.url` 推导（Node 默认 realpath 主模块），且 diag-a **不接受任何参数**，不存在 diag-c 那种「参数里带软链就静默跳过整个条目」的入口。

## 3. 车道门禁（本轮自行复跑，非转述）

```
$ node --run typecheck      ; echo exit=$?   → exit=0
$ node --run lint           ; echo exit=$?   → exit=0   ("No unawaited expect().resolves/.rejects chains found.")
$ node --run check:evidence ; echo exit=$?   → exit=0   ("Acceptance evidence is unchanged.")
$ node --check scripts/diag-a.mjs            → syntax OK
$ node --run test           ; echo exit=$?   → exit=1   Test Files 42 failed | 175 passed (217)
                                            Tests  128 failed | 1340 passed (1468)   real 3m40.9s
```

`test` 的红**第三次被独立归因且与车道无关**（本轮 A/B 严格串行，遵守第 4 轮自己定的「勿并发」纪律）：

| 副本 | `node_modules` 形态 | 结果 |
| --- | --- | --- |
| 审查工作副本 `review-a`（HEAD `191dd71`） | 软链到 `/Users/macmini/workspace/13-Graph/node_modules` | **42 文件 / 128 of 1468 失败**，3m40.9s |
| 探针 `/tmp/rev-a6-probe`（同一份源码，`cp -al` 硬链接 + `git init -q`） | 硬链接实体目录 | **4 文件 / 4 of 1468 失败**，2m7.9s |
| **基线 `/tmp/rev-a6-base`（提交 `7165551`，车道之前，`scripts/diag-*.mjs` = 0 个）** | 同上硬链接 | **4 failed (4) / 4 failed \| 23 passed (27)** |

- 探针的 4 个失败文件与基线的 4 个**完全相同**：`tests/m0/restricted-process.test.ts`、`tests/m7/delivery.test.ts`、`tests/m7/page.test.ts`、`tests/m7/production.test.ts`；报错逐字相同（`/usr/bin/which npm` 失败、`spawnSync git ENOENT` ×2、`/private/tmp/12-MediaBookmarks/src/config.js` 不在盘上）—— 全部是环境项（沙箱 PATH 缺 `npm`/`git`、兄弟项目不在盘上）。
- 硬链接副本**没有引入任何新失败文件**：`comm -13 工作副本失败清单 探针失败清单 | wc -l → 0`；即 42 → 4 的差额全部由软链造成。
- 工作副本的失败文件集合与第 5 轮**逐行相同**：`diff /tmp/rev-a5-wt-fail.txt /tmp/rev-a6-wt-fail.txt` 无输出（各 42 行）。
- 探针内 `node scripts/diag-a.mjs` 仍输出 `218 / 1431`；探针与仓库的 `scripts/diag-a.mjs` 摘要相同（`11460a7e…`）。

**结论**：这 4 条是**既有的环境基线**，既不是三个 diag 车道造成的（`7165551..HEAD` 只有 7 个纯新增文件，`tests/`/`src/` 零改动），也不是本任务可修的代码缺陷。

## 4. 图级风险（不属本车道，但仍未闭合，会卡死 `full-tests`）

`integration` 副本本轮已推进到与工作副本相同的 HEAD，**但依赖缺口依旧没补**：

```
$ cd ../integration && git rev-parse --short HEAD        → 191dd71
$ ls -ld ../integration/node_modules                     → ls: ../integration/node_modules: No such file or directory
$ (cd ../integration && node --run typecheck; echo $?)    → /bin/sh: tsc: command not found   → exit=1
$ (cd ../integration && node --run test;    echo $?)      → /bin/sh: vitest: command not found → exit=1
$ (cd ../integration && node -e "require.resolve('vitest')") → vitest UNRESOLVED MODULE_NOT_FOUND
```

所以在 `integration` 副本上 `node --run check` **四个阶段一个都到不了**，第一阶段即红。`full-tests` 必红 → 回边到 `merge` → `merge` 只拥有那段 README、改不动依赖 → 再次 `full-tests` 再次红，循环至 stalled。**这是可预见的死锁，仍然成立。**

**修法（必须由图操作者对 `integration` 副本执行，一行）**：

```sh
cp -al /Users/macmini/workspace/13-Graph/node_modules <integration 副本>/node_modules
```

修好后 `full-tests` 仍会红 **4 个文件**（§3 的基线），应判为**环境基线**而非回归；**不要**让 `merge` 去改这 4 个用例对应的实现。之所以必须修依赖：否则 4 个门禁阶段一个都跑不到。

> 附：工作副本与探针之所以必须用硬链接实体目录，是因为 `src/runtime/pi-process.ts:166` 把 `appRoot = realpath(graphApplicationRoot())`（工作副本自身）作为 `readPaths` 交给内层受限执行器；软链的真实目标在 `appRoot` 之外，worker 子进程启动即 `ERR_MODULE_NOT_FOUND: @earendil-works/pi-ai`，后续 36 处 `provider.requests[N] undefined` 都是这一根因的下游症状。仓库自己写明了这条纪律：`docs/agents/checks.md`「在 Git 工作树里验证」+ `docs/adr/0027-work-copy-dependency-link.md` §2。

## 5. 非阻塞发现（3 条，均不触发返工）

### 5.1 头注释里有一句可被证伪的断言 —— 数字对，理由错

`scripts/diag-a.mjs:6-8` 写「test file … matches how the repository's vitest config names its suites (`tests/**/*.test.ts`)」。`vitest.config.ts:6` 的 include 确实是 `tests/**/*.test.ts`，但仓库里有 **1 个文件不满足它**：

```
$ find tests -type f \( -name '*.test.*' -o -name '*.spec.*' \) ! -name '*.test.ts'
tests/fixtures/m7/web-server.test.js
```

它不是 vitest 套件，而是 m7 的 fixture 载荷：`tests/m7/adapters.ts:71` 把它拷进沙箱工作区，`:79` 用 `spawnSync(process.execPath, ['--test', …])` 单独跑。运行时印证：vitest 本轮实跑 **217** 个文件，diag-a 报 **218**，差 1；`tests/m7/adapters.ts:118` 与 `tests/m7/production.test.ts:32` 直接读它。

**对 `merge` 的硬约束**：写用法说明时**不得**把「218 = 本仓测试套件数」或头注释里那句括号注释原样搬进 README。若要保留 218，须注明「含 1 个 `tests/fixtures/m7/web-server.test.js`（`node:test` 载荷，不在 vitest include 内），vitest 实跑 217」。impl-a 侧只需改一行注释，不构成返工理由。

### 5.2 独立复算产物不在仓库内

impl-a 的复算脚本 `/tmp/diag-a-verify.sh` 本轮实测仍在宿主 `/tmp`（2680 B），但不在 Git 跟踪内（`git ls-files | grep -c diag-a-verify → 0`），随机会话即丢；独立复算命令目前只存在于本报告 §6。受「本车道只准新增一个文件」的约束不判 fail。**若要长期保留这三个诊断脚本**，应把复算收进 `package.json` 的一个 npm script 或 `scripts/verify-diag-*.mjs`，让 `merge` 的 README 能指向一条真实存在的命令。

### 5.3 树内存在软链目录时静默少计（本条自第 5 轮起仍成立，本轮重新复现）

`readdir(withFileTypes)` 的 `isDirectory()`/`isFile()` 对软链条目**都**返回 false，软链目录里的测试文件既不进计数也不报错。最小复现（`/tmp/rev-a6-fixt`，脚本本体未改）：

```
无软链：                                       → diag-a: 2 test files, 3 test cases
加入 tests/aliased -> linked/（内含 two.test.ts） → diag-a: 2 test files, 3 test cases, exit=0   ← 少计 1 文件 1 用例，无任何提示
```

本仓树内 0 个软链（`find … -type l | wc -l → 0`），所以 §2 的 218/1431 **不受影响**，不判阻塞。按 R27 记为**文档缺口**：`scripts/diag-a.mjs:5-12` 对「文件」的定义没有排除软链条目。修法二选一（impl-a 侧一行）：入口处对软链条目 `realpath` 后再判类型，或在头注释写明「软链条目不计」。

## 6. 本轮可复跑产物（R23）

```bash
W="$(pwd)"; NM=/Users/macmini/workspace/13-Graph/node_modules
P=/tmp/rev-a6-probe; B=/tmp/rev-a6-base

# 1) 车道 a 本体
node scripts/diag-a.mjs                                            # → diag-a: 218 test files, 1431 test cases（exit 0、stderr 0 字节）
for i in 1 2 3; do node scripts/diag-a.mjs | shasum -a 256; done      # → 3 次同一摘要 7dae6b3d…
(cd /tmp && node "$W/scripts/diag-a.mjs")                           # → 同一行（cwd 无关）
git rev-parse d1d954a:scripts/diag-a.mjs HEAD:scripts/diag-a.mjs; git hash-object scripts/diag-a.mjs   # → 三处同为 8a4185ba…
grep -nE "writeFile|appendFile|mkdir|rm\(|unlink|rename|createWriteStream|copyFile|chmod|truncate|spawn|exec|process\.exit|process\.env" scripts/diag-a.mjs   # → 无输出
git diff --name-only 7165551 HEAD -- tests/ src/ | wc -l            # → 0

# 独立复算（不复用脚本逻辑）
find . -type f \( -name '*.test.*' -o -name '*.spec.*' \) -not -path './.git/*' -not -path '*/node_modules/*' | wc -l   # 218
grep -rhE '^[[:space:]]*(it|test)([.][A-Za-z_$]+)*[[:space:]]*[(`]' --include='*.test.*' --include='*.spec.*' . \
  --exclude-dir=.git --exclude-dir=node_modules | wc -l                                                                          # 1431

# 2) 只读（三个 diag 脚本合跑）
fp() { find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type f -print0 | xargs -0 stat -f '%N %z %m' | sort; }
fp > /tmp/rev-a6-fp1.txt
node scripts/diag-a.mjs >/dev/null; node scripts/diag-b.mjs >/dev/null 2>&1; node scripts/diag-c.mjs >/dev/null 2>&1
fp > /tmp/rev-a6-fp2.txt; diff /tmp/rev-a6-fp1.txt /tmp/rev-a6-fp2.txt && git status --porcelain   # 皆空

# 3) 门禁
node --run typecheck; node --run lint; node --run check:evidence      # 全部 exit 0
node --run test                                                        # exit 1：42 files / 128 of 1468（软链所致）

# 4) A/B 对照（串行，勿与全量并发，否则 tests/m8/settings-ui.test.ts 会负载抖动假失败 —— 第 4 轮教训）
rm -rf "$P"; mkdir -p "$P"
(cd "$W" && tar -cf - --exclude=.git --exclude=node_modules .) | (cd "$P" && tar -xf -)
cp -al "$NM" "$P/node_modules"; (cd "$P" && git init -q)                # git init 必须有，否则多 1 个假失败
(cd "$P" && node --run test)                                          # → 4 files / 4 tests 失败

# 5) 基线对照（车道之前的提交）
rm -rf "$B"; mkdir -p "$B"; (cd "$W" && git archive 7165551) | tar -x -C "$B"; cp -al "$NM" "$B/node_modules"
(cd "$B" && node node_modules/vitest/vitest.mjs run tests/m0/restricted-process.test.ts tests/m7/delivery.test.ts \
   tests/m7/page.test.ts tests/m7/production.test.ts)                # → Test Files 4 failed (4)

# 6) integration 依赖缺口（§4）
ls -ld ../integration/node_modules                                     # → No such file or directory
(cd ../integration && node --run typecheck; echo $?)                  # → tsc: command not found / 1
(cd ../integration && node --run test;    echo $?)                     # → vitest: command not found / 1
```

本轮实际产物：`/tmp/rev-a6-fp1.txt`、`/tmp/rev-a6-fp2.txt`（1031 文件指纹）、`/tmp/rev-a6-files.txt`、`/tmp/rev-a6-tracked.txt`（可复现性比对）、`/tmp/rev-a6-err.txt`（stderr 0 字节）、`/tmp/rev-a6-typecheck.txt`、`/tmp/rev-a6-lint.txt`、`/tmp/rev-a6-evidence.txt`、`/tmp/rev-a6-wt-test.txt` + `/tmp/rev-a6-wt-fail.txt`（工作副本 42/128 及 42 行失败清单）、`/tmp/rev-a6-probe-test.txt` + `/tmp/rev-a6-probe-fail.txt`（硬链接探针 4/4）、`/tmp/rev-a6-base-test.txt`（基线 4/4）、`/tmp/rev-a6-int-tc.txt`、`/tmp/rev-a6-int-test.txt`（integration 两阶段失败）、`/tmp/rev-a6-fixt/`（§5.3 复现夹具）、`/tmp/rev-a6-link/`（软链调用复现）。

## 7. 判定

**route = `pass`**（与第 1–5 轮一致）

- 只读 ✅（静态 0 命中 + 1031 文件指纹动态取证，`git status` 干净）
- 仅 node 内置 ✅（import 仅 `node:fs/promises` / `node:path` / `node:url`；`package.json` 零改动）
- 仅新增 `scripts/diag-a.mjs`、零既有文件改动、零测试耦合 ✅（`7165551..HEAD` 7 个纯新增文件，`tests/`、`src/` 零改动）
- 统计在其自述口径下正确 ✅（`find`/`grep` 独立复算 218/1431 逐字吻合；从干净检出可复现：218 个计数文件全部被 Git 跟踪、0 个未跟踪/被忽略测试文件、树内 0 软链）
- 可重复 ✅（3 次同摘要 `7dae6b3d…`、cwd 无关、两种软链调用同输出、exit 0、stderr 0 字节）
- 车道门禁未污染 ✅（`typecheck` / `lint` / `check:evidence` 全 0）
- `test` 的红已第三次归因且与车道无关 ✅（A/B 42/128 → 4/4，硬链接副本 0 个新失败文件；基线提交 `7165551` 同样 4/4 且报错逐字相同；失败文件集合与上轮逐行相同）

**阻塞项 0 条。**

**下游必须动手的三件事（都不是车道 a 的返工理由）**：

1. 给 `integration` 副本补硬链接依赖（§4 的 `cp -al`），否则 `full-tests` 四个阶段一个都到不了 → 回边会空转到 stalled。
2. 补齐后 `full-tests` 仍会红 4 个文件 —— 判为环境基线，**不要**让 `merge` 去改这 4 个用例对应的实现。
3. `merge` 写 README 时遵守 §5.1 的硬约束：不得把「218 = 本仓测试套件数」或 `scripts/diag-a.mjs:6-8` 那句括号注释原样抄入。

## 8. 车道外观察（不阻断，供 `merge` / 图操作者参考）

`review-c-report.md` 位于**仓库根目录**且已被 Git 跟踪，与 `reviews/review-c.md` **内容不一致**（本轮实测 `diff` 非空）。它是 review-c 第 4 轮的旧副本，review-c 的正式报告写在 `reviews/review-c.md`。合并进 `main` 之前请确认是否要让这份根目录副本一起进入；本轮它未被任何车道修改（`7165551..HEAD` 中它只是新增），所以不影响车道 a 的判定。
