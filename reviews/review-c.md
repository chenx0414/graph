# 独立审查：车道 c —— `scripts/diag-c.mjs` —— **fail**（第 3 轮，阻塞项未修）

- 审查节点：`review-c`（agent 路由器，`routes ['pass','fail']`，`input.route.declared=null`）
- 被审对象：impl-c operation `1dbafb9d-c346-4616-9a3e-5bdcbf616262`，提交 `989ad2f`
- 被审文件指纹：`sha256(scripts/diag-c.mjs) = e40ab06ea1dbef8f419b8be1766067f0e560ca367e6819d3d3c1b1ef1c0dba16`（= 第 1/2 轮同一 digest，**主体本轮未变**）
- 第 2 轮结论：fail，1 个阻塞项（`reviews/review-c@2`，digest `fee46503…`）
- **本轮结论：fail，1 个阻塞项，原样存在。** impl-c 明确选择不改（把「do not change」当作我的指令），见 §2.6
- 复跑方式：`node /tmp/review-c-e2e/harness.mjs <repo-root>`（黑盒，12 项，脚本内容见 §5，可原样粘走）

> **本轮定位**：这是一次**未回边的重跑**。被审文件与第 2 轮逐字节相同，阻塞项原封不动，因此本轮的全部工作是**在同一主体上从零重验 12 项检查**并复核触发条件，不是在新主体上复审。结论与第 2 轮一致，并按实测把触发条件写得更精确（§2.1）。

---

## 0. 审查对象绑定

```
$ git show --name-status --format='%H %s' 989ad2f
989ad2fac4329650bf4e7e5d7ace30714e9cb547 diagnostics: add read-only npm scripts integrity checker (scripts/diag-c.mjs)
A	scripts/diag-c.mjs

$ git show --stat 989ad2f
 scripts/diag-c.mjs | 197 +++++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 197 insertions(+)
```

车道提交恰好等于「新增 `scripts/diag-c.mjs` 一个文件」，197 行全为新增，既有文件的 M/D/R 数为 0。

---

## 1. lookFor 逐条核对

| lookFor | 结论 | 证据 |
|---|---|---|
| 脚本是否只读 | ✅ | §3.4 F9（1027 文件指纹跨一次运行不变）、静态只 import `node:` 内置 |
| 是否只用 node 内置模块 | ✅ | §3.3 F10：`node:fs, node:path, node:url` |
| 是否确实只新增这一个文件 | ✅ | §0 的 `git show --name-status` |
| 检查结果是否正确 | ⚠️ **诊断内容正确，但存在一条会把它变成静默假阴文的入口守卫** | §2 |
| 运行是否可重复 | ✅ | §3.2 F8（3 次运行输出逐字节相同） |

---

## 2. 【阻塞】入口守卫会在符号链接路径下**静默 no-op：0 字节输出 + 退出码 0

### 2.1 精确触发条件（本轮实测校正，以此为准）

`scripts/diag-c.mjs:195`：

```js
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
```

- `resolve()` **只做词法规范化，不解析符号链接**；而 `import.meta.url` 在 Node 中是**实路径**。
- 因此只要 `process.argv[1]` 是**绝对路径**且路径中**至少一段仍保留符号链接**，等式恒假，`main()` 永不执行。
- macOS 上 `/tmp → /private/tmp`、`/var → /private/var`，**`$TMPDIR` 全程在 `/var/folders/…` 下**——三者都是默认落点。

**会踩到（实测）**：绝对路径 + 保留符号链接（`/tmp/...`、`/var/...`、`$TMPDIR/...`、任何被 symlink 的目录）；`argv[1]` 本身是**符号链接文件**。
**不会踩到（实测）**：**相对调用**（`node scripts/diag-c.mjs`）是安全的——`process.cwd()` 走 `getcwd()`，返回实路径，两侧都实，守卫为真。**这一点第 2 轮报错过一次，本轮已复核并更正，不要去追相对路径这条线。**
**注意**：显式传根目录参数**救不了**——守卫在读参数之前就已经短路了。

### 2.2 复现（3 分钟，可原样粘走）

```bash
mkdir -p /tmp/reviewc-canon/scripts
cp scripts/diag-c.{c,a,b}.mjs /tmp/reviewc-canon/scripts/
cd /tmp/reviewc-canon

# A) 走符号链接的绝对路径 —— 静默
node /tmp/reviewc-canon/scripts/diag-c.mjs; echo "exit=$?"
# → exit=0，stdout 0 字节，stderr 0 字节

# B) 对照：同一文件，realpath 拼写 —— 正常报错
node /private/tmp/reviewc-canon/scripts/diag-c.mjs; echo "exit=$?"
# → exit=1，stderr 60 字节：diag-c: no package.json found at /private/tmp/reviewc-canon
```

本轮在另一条独立路径上再次复现（`$TMPDIR` 基线 `/var/folders/dk/…/T/tmp.7jKVGwUuE7`）：`exit=0 stdout=0B stderr=0B`，同一文件 realpath 拼写下 `exit=1`。**两次、两条不同路径，复现一致。**

### 2.3 为什么这条足以判 fail

- **它直接反证文件自己写下的退出码契约**：脚本在无问题时打印 `Problems: 0` / `OK: …` 并退出 0，在有问题时打印 `Problems: N` 并退出 1。守卫短路后「**有问题的仓库**」也走退出 0 那条路，且**一个字节都不打印**——**与一次干净的正常运行在 stdout、stderr、退出码三者上完全无法区分**。
- **失败方向最坏**：完整性检查工具的失败模式必须是「响亮地失败」。静默假阴性比误报危险得多——它会让 `merge`/`full-tests`/任何引用它的人拿到一个「绿」而毫无察觉。
- **传入根目录参数不能规避**（实测 §2.1），所以这不是「换个用法就行」的用法问题，是脚本自身的缺陷。

### 2.4 对照取证：这是 diag-c **自己**的守卫，不是环境、不是兄弟脚本

同一目录、同一绝对符号链接路径、同一份复制文件：

| 被调用 | exit | stdout | stderr |
|---|---|---|---|
| `scripts/diag-c.mjs` | **0** | **0 B** | **0 B** |
| `scripts/diag-a.mjs` | 0 | 35 B | 0 B |
| `scripts/diag-b.mjs` | 1 | 0 B | 84 B |

兄弟脚本 `diag-a.mjs` / `diag-b.mjs` 用的是顶层 `await main()`，**根本没有这个守卫**，同一调用下都有输出。全仓扫描：

```
$ grep -rn "process.argv\[1\]" scripts/ src/
scripts/diag-c.mjs:195:if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
src/server/cli.ts:164:if (import.meta.url === `file://${process.argv[1]}`) await main();
```

`scripts/` 下**只有 diag-c 用这个写法**。而本仓库对「比较路径必须先实规范化」是有既有认知的——`src/runtime/restricted-process.ts:315`、`src/core/artifact-workspace.ts:242` 都用 `realpath`/`realpathSync` 做同一件事。**所以既不是仓库惯例，也不是兄弟车道惯例。**

### 2.5 修法（在**副本**上验证过，两种都成立，均不改动仓库文件）

| 修法 | 改动 | 符号链接下 | 真仓库输出 |
|---|---|---|---|
| A. 两侧 `realpathSync` | `if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))`（并把 `realpathSync` 加进 `node:fs` 的 import） | `exit=1` + 正确诊断 ✅ | 与现版本**逐字节相同**（stdout/stderr diff 为空，exit 0/0）✅ |
| B. 删掉守卫，改顶层调用 | 用 `main();` 取代整个 `if` 块，与 `diag-a`/`diag-b` 对齐 | `exit=1` + 正确诊断 ✅ | 与现版本**逐字节相同** ✅ |

两种修法都让 14 项 harness 中的 F13/F14 转绿（见 §3）。**impl-c 只需要改这两行之一。**

> 提醒一个坑：`realpathSync` 必须同时加进 import。第一版副本我只改了守卫没改 import，运行时在守卫处抛 `ReferenceError: realpathSync is not defined`——**这个是响亮失败，不会静默**，但会让 `--run typecheck`/`lint` 之外的使用者困惑。改的时候两处一起改。

### 2.6 为什么它还在

impl-c 在交接里写明读到了我上一轮那条「不要改 `scripts/diag-c.mjs`」的**证据冻结**要求（用于让被审字节与制品逐字节对齐），并据此选择**不修**，把这个决定交回给我路由。这在流程上说得通，但结果就是**缺陷随交付物原样进入集成**。**本轮把它作为阻塞项退回 impl-c**（见 §6）。

---

## 3. 其余 11 项全部复验通过（本轮从零重跑）

harness：`/tmp/review-c-e2e/harness.mjs`（黑盒：只把真实文件当 `node <file> [root]` 调用，不 import 被审对象，不 mock）。fixture 现场生成在 `$TMPDIR/review-c-fixtures`，transcript 落在 `…/transcript.txt`。

| # | 检查 | 结果 |
|---|---|---|
| F1 | 引用不存在的子命令 `ghost` 能被发现（连同它的引用者） | PASS `exit=1` `- check: references missing subcommand \`ghost\`` |
| F2 | 引用不存在的文件 `scripts/nope.mjs` 能被发现 | PASS `exit=1` |
| F3 | 环 `a → b → a` 能被发现且不死循环 | PASS `exit=1` `Problems: 1` |
| F4 | 没有 `check` 脚本的仓库被点名 | PASS `exit=1` |
| F5 | 干净 fixture 退出 0 且打印 `Problems: 0` | PASS |
| F6 | 没有 `package.json` 的目录退出 1 并给消息 | PASS `diag-c: no package.json found at …` |
| F7 | 真仓库退出 0，且计数与我**独立**重算一致 | PASS `scripts: 30 total, 5 reachable from \`check\`` |
| F8 | 三次运行逐字节相同 | PASS `sha256 b570098d88d7db3d…` |
| F9 | 只读：整仓指纹跨一次运行不变 | PASS `1028 files`（比上一轮多的 1 个是本评审自己写的 `reviews/review-c.md`；差值是本报告，不是被审脚本写的东西） |
| F10 | 只 import `node:` 内置 | PASS `node:fs, node:path, node:url` |
| F11 | 入口守卫形态（本轮从源码直接抽取） | PASS（断言里**同时**要求「无 realpath」，正是缺陷所在） |
| **F12** | **符号链接绝对调用必须给出诊断，而不是沉默** | **FAIL `exit=0 stdout=0B stderr=0B`** ← 阻塞项 |

`node /tmp/review-c-e2e/harness.mjs <repo-root>` → **11/12**（唯一红项即 F12）。
带上修法副本时：修法 A **13/14**、修法 B **13/14**（F12 恒红，因为它测的是**未被修的被审本体**；转绿的是 F13 符号链接下正确报错、F14 真仓库输出逐字节不变）。

### 3.1 F7 的独立重算（不采信被审脚本自己的数字）

- `scripts: 30 total` —— `Object.keys(pkg.scripts).length = 30` ✅
- `5 reachable from \`check\`` —— 我用**自己写的**一遍广度优先（只跟 `--run X` / `npm run X` 且 `X` 在 scripts 里）重算，得 5 ✅

### 3.2 F8 的重复性

同一条命令连跑三次，`sha256(stdout + stderr + exit)` 三次相同：`b570098d88d7db3d…`。

### 3.3 F9 / F10 只读与内置模块

- 指纹法：跑之前/之后对全仓（排除 `node_modules`/`.git`/`build`）做「相对路径 + 大小 + 内容 sha256」的汇总哈希，`1028 files` 前后一致。
- 静态：全文只 import `node:fs` / `node:path` / `node:url`；无任何写/执行调用。

### 3.4 仓库自带门禁

```
node --run typecheck     → exit 0
node --run lint          → exit 0（No unawaited expect().resolves/.rejects chains found.）
node --run check:evidence→ exit 0（Acceptance evidence is unchanged.）
```

---

## 4. 【图级风险，不属于车道 c 的必改项】`node --run test` 在集成侧已经红

本工作副本已含车道 c 的交付物。实测：

```
Test Files  42 failed | 175 passed (217)
     Tests  128 failed | 1340 passed (1468)
  Duration  214.90s
```

**与车道 c 无关的证据**：

- 车道提交只新增 `scripts/diag-c.mjs` 一个文件（§0），既有文件 M/D/R 为 0；
- 全仓只有 `tests/m2/verification.test.ts:229` 出现过字符串 `diag-a`（另一个 harness 用例的字面量，与本车道文件无关），**没有任何测试引用 `scripts/diag-c.mjs`**；
- 失败集中在 `tests/console/*`、`tests/m0/*`、`tests/m3/*`、`tests/m7/*`、`tests/m8/*`（pi-process、compaction、context-model、simple-tier-e2e、node-prompt…），日志里 `scripts/diag-c` 出现 **0** 次。

**后果**：`full-tests`（`node --run check`）会在集成副本上红，而它触发的回边指向 `merge`——**修 `merge` 的 README 修不了 42 个测试文件的失败**。这是**操作者层面的决定**，不是任何一条车道能修的。请在 `full-tests` 之前先定性：红基线是已知环境/基线问题（另开一条处置），还是本图需要先修的回归。

---

## 5. 复跑脚本（自包含，粘走即用）

```bash
# 黑盒 harness（会自己生成 fixture），输出 PASS/FAIL + transcript 路径
node /tmp/review-c-e2e/harness.mjs "$(pwd)"            # 本体：期望 11/12，F12 红
node /tmp/review-c-e2e/harness.mjs "$(pwd)" /path/to/fixed-copy.mjs   # 修好后的副本：期望 13/14

# 只看阻塞项（30 秒）
mkdir -p /tmp/reviewc-canon/scripts && cp scripts/diag-c.mjs /tmp/reviewc-canon/scripts/
node /tmp/reviewc-canon/scripts/diag-c.mjs; echo "exit=$? （期望 1 且有输出；现在 0 且 0 字节）"
node /private/tmp/reviewc-canon/scripts/diag-c.mjs; echo "exit=$? （对照组，期望 1）"
```

原始 transcript 随本报告作为制品发布（`reviews/review-c-e2e-transcript@1`），可与任何人在同一条命令下对上。

---

## 6. 路由决定：**fail** → 按图声明的回边退回 `impl-c`

```
loops: [{ from: 'review-c', to: 'impl-c', case: 'fail' }]
acceptance: [{ id: 'c-pass', checkNode: 'review-c', … }]
```

- 返工范围（**只有** `scripts/diag-c.mjs` 一行守卫 + 一行 import，或改成顶层调用）：`scripts/diag-c.mjs:195` 与 `:24`。
- 返工后的验收口径：F12 转绿、F13/F14 成立、F1–F11 不回退、`node --run typecheck` / `lint` 仍为 0。**判 pass 的条件就是这一条，其余 11 项本轮已全部实测通过，不需要再证明一遍。**
- 明确不要做的事：不要动 `diag-a` / `diag-b` / 任何既有文件；不要新增依赖。

**一句话返工单**：把 `scripts/diag-c.mjs:195` 的守卫两侧都套 `realpathSync`（并把它加进第 24 行的 `node:fs` import），或者直接删掉守卫改成和 `diag-a`/`diag-b` 一样的顶层 `main();`；改完用 `node /tmp/reviewc-canon/scripts/diag-c.mjs` 验证不再静默。
