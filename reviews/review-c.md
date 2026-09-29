# 独立审查：车道 c —— `scripts/diag-c.mjs` —— **pass**（第 4 轮，阻塞项已修）

- 审查节点：`review-c`（agent 路由器，`routes ['pass','fail']`，`input.route.declared=null`）
- 被审对象：impl-c operation `bef076e1-2388-4f75-9ed9-d7ce995474c1`（输出 v2），提交 `eedc7a6`
- 被审文件指纹：`sha256(scripts/diag-c.mjs) = a69d212ed54bc1a6e843d759d39192bfe052b267d86ec810402fa6260f4fcc1e`
  = 制品 `summaries/impl-c-diag-c-evidence@2`（id `3dda2e28-907e-47d9-9dc8-2ff144cb9e12`）的 digest，两者逐字节对齐
- 第 3 轮结论：fail，阻塞项 `silent-no-op-under-symlinked-argv1`（`reviews/review-c@5`，digest `aeb0d0ac…`）
- **本轮结论：pass。** 阻塞项已修并用**独立**黑盒 harness 实测先红后绿；16/16 通过；真实仓库输出与被审版本逐字节相同。
- 复跑方式：`node /tmp/review-c-e2e/harness-v2.mjs <repo-root> [subject-copy]`（harness 源文随本报告作为制品发布）

---

## 0. 审查对象绑定

```
$ git show --name-status --format='%H %s' eedc7a6
eedc7a6d98a93e4f513e2a9788b615ee960755c4 diagnostics: make diag-c run when argv[1] keeps a symlink
M	scripts/diag-c.mjs

$ git diff --stat eedc7a6^ eedc7a6 -- scripts/diag-c.mjs
 scripts/diag-c.mjs | 12 ++++++++++--
 1 file changed, 10 insertions(+), 2 deletions(-)
```

车道提交**只改一个既有文件**，无新增/删除/其他文件改动。与第 3 轮被审版本的全部差异就是两处（导入行 + 守卫，外加一段解释注释）：

```
-import { existsSync, readFileSync, statSync } from 'node:fs';
+import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
-if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
+/** …两侧都 realpath 的原因… */
+if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
```

impl-c 采用的是我第 3 轮给的**修法 A**，且**导入与守卫在同一个提交里一起改**（我上轮警告的 `ReferenceError` 坑已避开）。impl-c 交接里的数字（10 insertions / 2 deletions、单文件、digest `e40ab06e` → `a69d212e`）逐条对上。

---

## 1. lookFor 逐条核对

| lookFor | 结论 | 证据 |
|---|---|---|
| 脚本是否只读 | ✅ | §3 F9（1028 文件指纹跨一次运行不变），静态只 import `node:` 内置 |
| 是否只用 node 内置模块 | ✅ | §3 F10：`node:fs, node:path, node:url` |
| 是否只动本车道那一个文件 | ✅ | §0 的 `--name-status` / `--stat` |
| 检查结果是否正确 | ✅ | §2 的先红后绿：缺陷版 7/16，修复版 16/16；真实仓库输出逐字节不变（§4） |
| 运行是否可重复 | ✅ | §3 F8（3 次运行 sha256 相同 `87319e29153655fc…`） |

---

## 2. 阻塞项处置：`silent-no-op-under-symlinked-argv1` —— 已修，先红后绿

**我不采信 impl-c 自己的 harness。** 用我自己的黑盒 harness 跑两个被审对象，只改第 2 个参数（被审文件副本）：

| 被审对象 | 摘要 | harness 退出码 | 结果 |
|---|---|---|---|
| 修复前 `e40ab06e…`（`git show eedc7a6^:scripts/diag-c.mjs`） | **7/16** | 1 | F1–F7、F12、F13 红 |
| 修复后 `a69d212e…`（本工作副本） | **16/16** | 0 | 全绿 |

```
$ node /tmp/review-c-e2e/harness-v2.mjs "$PWD" /tmp/review-c-e2e/diag-c-prefix.mjs   # 修复前
FAIL  F12 symlinked-directory argv[1] diagnoses the repo (not silent exit 0) :: exit=0 stdout=0B stderr=0B
FAIL  F13 symlinked-file argv[1] diagnoses the repo (not silent exit 0) :: exit=0 stdout=0B stderr=0B
FAIL  F1  … exit=0      ← 见下方「比上轮更严重的一面」
…
7/16 checks passed

$ node /tmp/review-c-e2e/harness-v2.mjs "$PWD"                                  # 修复后
PASS  F12 symlinked-directory argv[1] diagnoses the repo (not silent exit 0) :: exit=1 stdout=0B stderr=123B
PASS  F13 symlinked-file argv[1] diagnoses the repo (not silent exit 0) :: exit=1 stdout=0B stderr=123B
…
16/16 checks passed
```

### 2.1 比上轮更精确的一面：受害面不止「符号链接拼写」

harness 的 fixture 沙箱建在 `os.tmpdir()`（macOS 上 `/var/folders/…`，`/var → /private/var` 本身就是符号链接）。把修复前的被审文件放进这个沙箱后，**所有**用例（F1–F7）一起变红：不是只有符号链接那条路径静默，而是**只要 `argv[1]` 保留任意一段符号链接，整个诊断就是一个 0 字节 + exit 0 的空转**。第 3 轮我只证明了单条命令，本轮把它变成了「整个工具静默」。

顺带一个对照事实：同一份修复前文件、同一台机器，只是把路径写成真路径拼写（`/private/tmp/…`），输出 409 字节、exit 0 —— 也就是说**故障完全由 `argv[1]` 的拼写决定，与被检查的仓库无关**。修复后两种拼写结果逐字节相同（§3 F14，409B vs 409B）。

### 2.2 检查设计上的自查（透明起见）

- 第 3 轮的 F11 是**钉缺陷**的断言（要求守卫里「不得出现 realpath」）。它对修复后的正确实现**必然变红**，所以本轮把它改成**行为中性的对称性断言**：两侧要么都 realpath、要么都不。真正的判别力由 F12/F13 承担（上表已证明它们对修复前为红）。
- 本轮 F14 在修复前的被审文件上**也是绿的**（`linked 0/0` vs `canonical 0/0` 逐字节相等——两个都空）。这条我如实记为**非判别性**，不要把它算作证据；判别的是 F12/F13。

---

## 3. 16 项检查（黑盒：`node <被审文件> [root]`；不 import 被审对象、不 mock）

| # | 检查 | 修复后结果 |
|---|---|---|
| F1 | 引用不存在的子命令 `ghost` 能被发现（连同引用者） | PASS `exit=1` |
| F2 | 引用不存在的文件 `scripts/nope.mjs` 能被发现 | PASS `exit=1` |
| F3 | 环 `a → b → a` 能被发现且不死循环 | PASS `exit=1` |
| F4 | 没有 `check` 脚本的仓库被点名 | PASS `exit=1` |
| F5 | 干净 fixture 退出 0 且打印 `Problems: 0` | PASS `exit=0` |
| F6 | 没有 `package.json` 的目录退出 1 并给消息 | PASS `diag-c: no package.json found at …` |
| F7 | 真仓库退出 0，计数与我**独立**重算一致 | PASS `scripts: 30 total, 5 reachable from \`check\`` |
| F8 | 三次运行逐字节相同 | PASS `87319e29153655fc…` |
| F9 | 只读：整仓指纹跨一次运行不变 | PASS `1028 files` |
| F10 | 只 import `node:` 内置 | PASS `node:fs, node:path, node:url` |
| F11 | 守卫两侧规范化**对称** | PASS `argv1_realpath=true metaurl_realpath=true` |
| **F12** | **符号链接目录拼写的绝对调用必须给出诊断** | PASS `exit=1 stderr=123B` |
| **F13** | **`argv[1]` 本身就是符号链接时必须给出诊断** | PASS `exit=1 stderr=123B` |
| F14 | 符号链接拼写与规范拼写逐字节一致 | PASS `409B = 409B`（**非判别**，见 §2.2） |
| F15 | 相对调用仍只执行一次（守卫没有变过敏） | PASS `Problems: 0` 出现 1 次 |
| F16 | 仍可作为模块 import 而不执行 `main()` | PASS `exports=diagnose,findCycles,reachableScripts,referencedFiles,referencedScripts` |

- F12/F13 用的符号链接是 harness **自己创建**的（`symlinkSync` 到真实目录），不依赖本机 `/tmp`、`/var`、`$TMPDIR` 恰好是符号链接。
- F7 的 `reachable=5` 是我自己写的第二遍广度优先算出来的，不采信脚本自己的数字。

---

## 4. 修复不改变任何既有行为（真仓库 A/B）

```
$ node /private/tmp/review-c-e2e/diag-c-prefix.mjs "$PWD" > real2-prefix.out   # 修复前，真路径拼写
$ node "$PWD/scripts/diag-c.mjs"                          > real2-fixed.out     # 修复后
$ shasum -a 256 real2-*.out real2-*.err
16d0dae38b19ef02f0874b079df11389fa3bb60a80d627de7a5980a9e555556f  real2-fixed.out   (409 B)
16d0dae38b19ef02f0874b079df11389fa3bb60a80d627de7a5980a9e555556f  real2-prefix.out  (409 B)
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  real2-*.err      (0 B，两份相同)
$ diff real2-prefix.out real2-fixed.out   # 无差异
```

stdout 409 字节逐字节相同，stderr 0 字节，exit 0/0。**修复是纯入口守卫的等价加固，没有顺带改动任何检查逻辑或输出格式。**

## 5. 仓库自带门禁（本工作副本实测）

```
node --run typecheck      → exit 0
node --run lint           → exit 0（No unawaited expect().resolves/.rejects chains found.）
node --run check:evidence → exit 0（Acceptance evidence is unchanged.）
node --run test           → Test Files 42 failed | 175 passed (217)
                            Tests      128 failed | 1340 passed (1468)
                            Duration   208.92s
```

与第 3 轮在同一工作副本上的数字**完全相同**；把两轮的失败文件清单排序后 `diff` 为**空**（42 个文件，逐个相同）；两份日志里 `diag-c` 出现 **0 次**。

---

## 6. 【非阻塞观察】修法 A 引入了一条新的导入面脆弱性

实测（harness 的 INFO 探针）：

```
$ node -e "process.argv[1]='/nonexistent/stale.mjs'; try{ await import('<repo>/scripts/diag-c.mjs'); print('import ok') }catch(e){ print('THREW '+e.code) }"
THREW ENOENT                     # 修复前同一探针：import ok
```

`scripts/diag-c.mjs:201` 的 `realpathSync(resolve(process.argv[1]))` 在 `argv[1]` 指向**不存在的路径**时抛 `ENOENT`，而这一句在模块**求值期**执行。于是「模块可被安全 import」这条属性——正是我上轮推荐修法 A（而不是删掉守卫的修法 B）的理由——在 `process.argv[1]` 是陈旧路径的宿主进程里不再成立。

- **为什么判非阻塞**：全仓 `grep -rn "diag-c" package.json src tests docs scripts` 只命中该文件自身——没有任何 npm script、测试或模块 import 它，今天不可达；`node <脚本>` 正常调用时 `argv[1]` 必然存在。
- **若要收口**（一行，可选）：`realpathSync(resolve(process.argv[1]), { throwIfNoEntry: false })`，或把守卫体包进 `try/catch`；`argv[1]` 不可解析时守卫为假、`main()` 不执行，正是想要的行为。
- 归属文件：`scripts/diag-c.mjs:201`。**不在本轮验收口径内**，不建议为此再开一轮返工。

---

## 7. 【图级风险，非车道 c】`node --run check` 仍因既有原因红

`full-tests` 会在集成副本上红（§5 的 42 个失败文件：`tests/console/*`、`tests/m0/*`、`tests/m3/*`、`tests/m7/*`、`tests/m8/*`）。**与车道 c 无关**：本车道只改 `scripts/diag-c.mjs` 一个文件，既有文件 M/D/R 为 0；全仓无任何测试或脚本引用它；失败文件集合与第 3 轮逐个相同，日志中 0 次提及。

**后果不变**：图声明的回边是 `review-c --fail--> impl-c`（只重跑车道 c），而 `full-tests` 的红不是任何一条车道能修的。请操作者在跑 `full-tests` / `merge` 之前先定性：红基线是已知环境/基线问题（另开处置），还是本图需要先修的回归。**这条不需要 review-c 再动一次。**

---

## 8. 路由决定：**pass**

- 上一轮的阻塞项已修，且经**独立**先红后绿验证（修复前 7/16，修复后 16/16，§2）。
- 无回归：真仓库输出逐字节不变、门禁 typecheck/lint/check:evidence 全 0、全量测试失败集合与上轮逐个相同（§4、§5）。
- 遗留仅 §6 一条非阻塞加固建议，不构成验收缺口。

**验收口径结论**：`c-pass` 判据（`scripts/diag-c.mjs` 只读、仅 node 内置、单文件、结果正确、可重复）全部满足，本轮独立实测通过。
