# review-a：scripts/diag-a.mjs

Verdict: pass（dimension `correctness`）

只评 impl-a 的产出。冻结交接是 `summaries/impl-a-diag-a-evidence@1`（digest `5703d2aafc2e61fdb7ca3b94b6f1407234d2cea637b4a9d834928c27e5823be4`，operation `cc9eb9d0-7c39-42bf-b1a9-23bc95180d7e`，activation `820cdce8-aa88-469d-8e17-531ee823f147`）。被评文件是当前工作副本里的 `scripts/diag-a.mjs`（sha256 `3903d76f458c4fa218f8799357d10d51e58cd264cb67583f802918bf0fb6f1ed`，6209 bytes）。

## 只读、只用 node 内置模块

- import 只有 `node:fs` 的 `readdirSync` / `readFileSync`、`node:path`、`node:url`。
- 源码里没有 `writeFile`、`appendFile`、`mkdir`、`rm`、`unlink`、`rename`、`createWriteStream`、`child_process`、`spawn`、`exec`、网络 API。
- 仓库根与 `/tmp` 各跑一次，退出码都是 0，stdout 字节相同。impl-a 提交 `d437df46ab6c108e36625c4c13f28f86d13067eb` 的 `git diff-tree` 只有 `A scripts/diag-a.mjs`，没有改 `package.json` 或锁文件。

## 只新增这一个文件

`git diff-tree --name-status -r d437df4` = `A scripts/diag-a.mjs`。当前工作副本 `git status --porcelain=v1 --untracked-files=all` 为空（评审证据文件除外，见下）。兄弟车道的 `scripts/diag-b.mjs`、`scripts/diag-c.mjs` 是别的提交带进来的，不属于本车道。

## 统计正确、可重复

- 口径与 `vitest.config.ts` 的 `include: ['tests/**/*.test.ts']` 一致。
- 独立 walk：216 个 `*.test.ts`。行首 `test`/`it` 声明（含 `.each`）1422。用与脚本相同的词法剥离再计，216 个文件里没有任何一个文件的计数发生变化，所以剥离没有漏计或误计。
- 三次运行（仓库根两次、`/tmp` 一次）stdout 字节相同：`[diag-a] 测试文件 216 个，用例 1422 项（tests/**/*.test.ts；每个 test/it 声明计 1 项，test.each 按声明计 1）`。
- `test.each` 按一条声明计 1，文件头写明了这条口径，与 `vitest list` 的运行时展开条数本来就不是同一个数。

## 非阻断观察

文件头写「退出码恒为 0（除非 tests/ 不存在）」，但 `main()` 不捕获 `readdirSync` 的 ENOENT，目录缺失时是未处理异常，不是脚本自己设的非 0。当前仓库 `tests/` 存在，不影响本次计数。不要求返工。

## 证据

`reviews/review-a-diag-a-evidence.txt`（sha256 `8cd56bde815ffa84bf2bfcd06c074e64cf0c47baa5694226b6fc417746852f15`）记录了三次运行的 stdout、脚本 digest 和提交边界。
