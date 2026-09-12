# M2–M7 验收证据

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
