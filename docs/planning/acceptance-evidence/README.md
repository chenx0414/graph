# M2–M7 验收证据

最新复验：[6004a2a 返工独立复验](../rework-acceptance-2026-09-12.md)。本轮新增诊断从 Graph 根目录运行：

```sh
./node_modules/.bin/node docs/planning/acceptance-evidence/reconcile-usage-rework.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/local-network-rework.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/web-export-error-rework.mjs /Users/macmini/workspace/graph-m7-acceptance-8/project
```

这些程序只使用临时状态及合成服务，退出 0 表示观察完成。网络边界诊断需要 macOS 与非 loopback 的 Ethernet/Wi-Fi IPv4 接口，只向本机接口发送模拟请求；浏览器诊断需要项目 Playwright Chromium。程序清理自身创建的临时数据及进程。对应 `.output.txt` 为实际观察；`real-run-rework-audit.json` 是真实任务记录的最小提取，不包含登录凭据或收藏正文；`a13-rework-38-tests.output.txt` 和 `a13-rework-browser.output.txt` 为交付的独立测试与合成浏览器记录。

对应 [独立验收报告](../acceptance-m2-m7.md) 与 [复验跟进](../acceptance-followup.md)。被验收版本 `d0193bb`；第三轮修复见 [验收跟进复验](../acceptance-followup.md#第三位-agent-的复验结果2026-09-12)。本目录的程序保留公开入口观察值，修复进展以 Vitest 回归为准。

从 Graph 根目录运行，使用已安装的项目 Node 24.20.0：

```sh
./node_modules/.bin/node docs/planning/acceptance-evidence/runtime.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/core.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/unknown-usage-recheck.mts
./node_modules/.bin/vite build
./node_modules/.bin/node docs/planning/acceptance-evidence/ui.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/media.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/symlink-boundary.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/followup-message.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/command-git-boundary.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/command-input-revision.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/capabilities.mts
```

这些是验收诊断程序，打印实际观察值，退出码 0 只表示诊断运行完成。以报告中的预期行为判断通过与否；它们没有加入现有 Vitest 套件，不能把运行数量加入通过测试数。

- `runtime.mts`：生产 adapter 对接本地 provider，检验主管工具、讨论期唤醒与多请求用量阻断。
- `core.mts`：六种独立场景，真实临时 Git 和 Task Runtime，包括审查门、验收降低、审查模型排除、目标工作副本、人工检查及评委。
- `unknown-usage-recheck.mts`：慢工人完成集成后，用量未知实例是否被再次派发。
- `ui.mts`：Playwright 打开实际 Web，检查图状态与额度答复。先构建 Web。
- `media.mts`：运行 M7 交付代码，只将外部采集 CLI 换成慢速本地进程；验证未登录拒绝、异步采集进度和笔记正文阅读。
- `symlink-boundary.mts`：工作区写入工具遇到符号链接目录时是否拒绝并保持外部文件不变。
- `followup-message.mts`：`begin → runReady → say → runReady` 后，补充需求是否到达生产主管 provider。
- `command-git-boundary.mts`：`graph.command`/`run_command` 执行 `node` 脚本改写工作副本 `.git/HEAD` 时是否被受限边界拒绝并保持元数据不变。
- `command-input-revision.mts`：主管把已确认的失败检查命令改为 `node --version` 的修订是否被拒绝，以及原检查与证据是否保持。
- `capabilities.mts`：按定义版本加载的受限 worker 扩展、远程 MCP（授予域名）与受控网络检索是否真实可调用并可计量，以及未授予域名是否在请求前被拒。

全部程序创建并清理临时数据，没有真实供应商请求。浏览器场景需要已安装的 Playwright Chromium。`.output.txt` 是最近一次实际输出；临时 UUID、路径和 commit SHA 随运行变化。

## 2026-09-12 首版报告复验

对应 [首版独立验收](../final-acceptance-2026-09-12.md)，Graph 被验收提交 `2841c4d`，真实交付提交 `725cb1be`。新增证据：

```sh
./node_modules/.bin/node docs/planning/acceptance-evidence/provider-transport-retry.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/remote-mcp-boundary.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/a13-delivery-errors.mjs /Users/macmini/workspace/graph-m7-acceptance-7/project
```

- `provider-transport-retry.mts`：本地服务收到完整模型 POST 后断线，观察是否重发、是否绕过暂停，以及未知用量是否被保留。
- `remote-mcp-boundary.mts`：生产 Runtime 对接本地模拟 MCP；观察无外部操作授权时工具是否执行，以及握手期间暂停后是否继续发送工具请求。所谓删除效果只是内存计数器。
- `a13-delivery-errors.mjs`：从参数指定的交付仓库加载采集模块，以合成输入复现 API 非零错误码与采集异常的失败显示；断言被验收版本的缺陷行为，修复后应按新的预期复验。
- `a13-delivery-tests.output.txt`：从精确交付提交导出 `src`、`test`、`package.json` 到临时目录后，独立运行四个 `bilibili-web-*.test.js` 的 22 项测试结果。

这些诊断只使用合成数据及本地服务，不读取真实收藏、登录配置或 profile；没有增加正式测试套件的测试计数。

## 2026-09-12 返工复验（最终）

对应 [首版独立验收](../final-acceptance-2026-09-12.md) 的返工条件。Graph 侧修复提交 `8c17e26`（传输重试/远程 MCP 授权/逐请求暂停/浏览器检查边界）、`edbf124`（宿主核对未知用量）、`9efd856`（harness 续跑）；真实 Web 返工在隔离副本 `graph-m7-acceptance-8` 完成，交付提交 `b1754fac`。

```sh
./node_modules/.bin/node docs/planning/acceptance-evidence/provider-transport-retry.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/remote-mcp-boundary.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/remote-mcp-granted.mts
./node_modules/.bin/node docs/planning/acceptance-evidence/a13-delivery-fixed.mjs /Users/macmini/workspace/graph-m7-acceptance-8/project
```

- `provider-transport-retry.mts`：返工后只发送 1 次请求，暂停后不再重发，调用保持 `unknown usage`、未记账不归零。
- `remote-mcp-boundary.mts`：无操作授权时 `effects=0` 并产生 `permission` 问题；原脚本的暂停场景会先被授权拒绝，不再发送 `tools/call`。
- `remote-mcp-granted.mts`：同一探针的授权变体；授权匹配时 `tools/call` 正常执行，握手期间暂停则后续 `notifications/initialized` 与 `tools/call` 均不发送（`effects=0`）。
- `a13-delivery-fixed.mjs`：对交付仓库断言抛错与 `code=-352` 都进入 `failures`/`errors`/`incomplete`、进度事件与日志，退出 0；原 `a13-delivery-errors.mjs` 保留为返工输入。
- 相关自动回归：`tests/m0/pi-calls.test.ts`、`tests/m3/mcp-boundary.test.ts`、`tests/m4/command-check.test.ts`、`tests/m1/execution.test.ts`；交付仓库测试 38/38（含真实无头 Chromium E2E）。

## 2026-09-12 第二轮返工复验（S2/S3/R6 已修复，R7 待交付）

对应 [第二轮复验](../rework-acceptance-2026-09-12.md)。Graph 修复了核对结算与本地监听边界，两个探针输出已更新为修复后的实际行为：

- `reconcile-usage-rework.mts`：`completed-output` 后继拿到 `{work:{answer:42}}` 且 `outputVersion=1`；`waiting-result` 保留 open 的 waiting 问题；`known-usage` 在核对后累计 19,999,950 已知用量，下一次预留被 `budget` 问题阻止，不再实际发送。
- `local-network-rework.mts`：`localNetwork:true` 时 `0.0.0.0` 监听被宿主的 listen/bind 守卫以 EPERM 拒绝；`127.0.0.1` 监听与真实无头浏览器检查仍通过。
- 真实任务投影：`graph-m7-acceptance-8/usage-repair.json` 补记 `work-errors` 已知 5,661,736 tokens 与输出，未知调用保留、费用仍 unknown；完成态任务不重开，超预留缺口在修复记录中说明。
- R7 待交付修复：`web-export-error-rework.mjs` 当前仍指向交付版本的缺陷行为（HTTP 500 显示成功）；修复后应在真实页面显示失败原因并允许重试。
