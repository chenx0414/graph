# ADR 0041：工具链只留一门语言，边界写在这里

日期：2026-11-11

## 状态

已接受，已实施。

## 背景

Go 化分两段走完：先是界面（`app/`，Go + MyGo）接替 Electron 外壳，再是后端只有 Go 一门实现语言。
到此为止，剩下的 TypeScript/JavaScript 全在**工具链**上——构建、门禁、harness、安装与签名。
它们不是产品，却决定了每次提交要跑什么、装出来的 App 长什么样。查一轮门禁要跨 Go 与 Node
两套生态，改一条检查要在两种语言里找入口。

## 决策

**仓库里不再有自有的 TypeScript 或 JavaScript。** Go 覆盖：

| 原来的位置 | 现在 |
| --- | --- |
| `scripts/check-*.mjs`（注释预算、表归属、源文件体量、证据未变） | `backend/internal/gate` + `graphcheck {comments,tokens,ownership,evidence}` |
| `scripts/app-*.mjs`、`package-app.mjs`、签名脚本 | `backend/internal/appinstall` + `graphbuild {backend,app,install,sign}` |
| `scripts/skills-lint.mjs`、`session-summary.mjs`、`pig-kernel-update.mjs` | `graphcheck {skills,summary,pig}` |
| `scripts/harness-behavior-*.mjs`、`harness-eval-*.mjs`、`harness-real-eval.mjs`、`harness-cost.mjs`、`go-daemon.mjs` | `backend/internal/harness` + `graphcheck {harness,eval}` |
| 整套 vitest 与 `tests/**` | `go test`（`backend/`、`app/` 两个 module） |

`src/catalog`、`src/server`、`src/core`、`scripts/lib`、`examples/*.ts` 直接删除：删掉 vitest 之后
已零 importer，职责在 Go 里已有实现，或者一句话就能取代。

**两处例外，都是别人的代码或执行面，不是我们的工具**：

- `src/runtime/`（`extension-worker.mjs`、`module-worker.mjs`、`host-command-worker.mjs`、
  `check-resolver.cjs`）：PiG 内核在 Node 里跑用户扩展与模块的地方，Go 侧只负责起进程与读结果。
- `.agents/skills/**`：第三方技能脚本，随版本锁定，不由我们改写。

`package.json` 留成三条转发脚本：`check` → `python3 scripts/check-queue.py`、`check:full` →
`graphcheck all`、`app:build` → `graphbuild app`。原因是宿主的 RSI 流程把这两步写成
`node --run <script>`（校验命令与激活前的 App 重建），脚本名是宿主的约定，不是我们的工具。
它不再有任何依赖，`node_modules` 不存在。实测过：删掉 `app:build` 那条之后，激活卡在
「门禁过了、App 重建 404」，而修宿主的调用点要先重载——先有鸡还是先有蛋。

## 后果

- 一条命令判一切：`python3 scripts/check-queue.py`（快层）、`go -C backend run ./cmd/graphcheck all`（全量）。
- harness 的冻结用例重新冻结成 **Go 任务**（`parser`、`cli`、`persistence`），验收是真实的
  `go test ./...`。用例的形状跟着产品语言走：替身模型改的是 Go 文件，改完必须真的编译、真的过测试。
- 门禁只判「活儿还能不能干完」。判「提示还管不管用」要真模型，那是 `graphcheck eval`：同一个驱动，
  换成配置里的模型。旧实现跨运行记判决账本、扫陈旧目录那层没有搬过来，每次运行直接打印该用例的
  报告（`taskSuccess`、工具序列、verify 结论），需要比较时把两次的报告放在一起看。
- 少一套生态：不再需要 `pnpm install`，工作树不需要拷 `node_modules`，CI 少一步。
- 代价：以后写工具只写 Go；需要快速脚本时也得是 Go（或者 `python3 scripts/` 下那两支）。
