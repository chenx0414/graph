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
```

这些是验收诊断程序，打印实际观察值，退出码 0 只表示诊断运行完成。以报告中的预期行为判断通过与否；它们没有加入现有 Vitest 套件，不能把运行数量加入通过测试数。

- `runtime.mts`：生产 adapter 对接本地 provider，检验主管工具、讨论期唤醒与多请求用量阻断。
- `core.mts`：六种独立场景，真实临时 Git 和 Task Runtime，包括审查门、验收降低、审查模型排除、目标工作副本、人工检查及评委。
- `unknown-usage-recheck.mts`：慢工人完成集成后，用量未知实例是否被再次派发。
- `ui.mts`：Playwright 打开实际 Web，检查图状态与额度答复。先构建 Web。
- `media.mts`：运行 M7 交付代码，只将外部采集 CLI 换成慢速本地进程；验证未登录拒绝、异步采集进度和笔记正文阅读。
- `symlink-boundary.mts`：工作区写入工具遇到符号链接目录时是否拒绝并保持外部文件不变。
- `followup-message.mts`：`begin → runReady → say → runReady` 后，补充需求是否到达生产主管 provider。

全部程序创建并清理临时数据，没有真实供应商请求。浏览器场景需要已安装的 Playwright Chromium。`.output.txt` 是最近一次实际输出；临时 UUID、路径和 commit SHA 随运行变化。
