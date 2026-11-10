# ADR 0037：浏览器控制台退役，界面只由原生壳承担

日期：2026-11-10

## 状态

已接受，已实施。

## 背景

Graph 原本有两套界面：一套是跑在浏览器里的 React 控制台（`src/web`，由 Vite 打包成
`dist/web`，daemon 用 `--web-dir` 指向它并整目录对外服务），另一套是 Electron 壳里的同一个
页面。要甩掉 Electron、Chromium 与整条 TS/JS 前端工具链，界面必须先在 Go 里长齐。

原生壳（`app/`，Go + MyGo）已经按层接管：会话与转录、侧栏与多标签、设置、用量、产物、资源、
图页与节点聊天，以及打断、撤销排队、暂停、绑定项目、确认草案、会话级换模型、设备码登录。
功能对齐之后，浏览器控制台只剩一个代价：它让整个仓库停留在「必须有前端构建产物」的状态。

## 决策

1. 删除 `src/web`、`vite.config.ts`、`tsconfig.web.json` 与全部依赖它们的测试。界面只有一处：
   `app/` 里的原生窗口。
2. daemon 不再服务任何页面：删掉 `--web-dir`、`/assets/{path...}`、`/api/build` 与启动时的
   「必须有 `dist/web/index.html`」闸门。`GET /` 只保留一个用途——下发会话 cookie。
3. RSI 激活门禁不再有 `build:web` 这一步：改动 `src/web` 不再需要重建前端，因为它不再存在。
   改 `app/` 仍然触发 `app:build`：壳的代码要重新装包并由用户退出重开才生效。
4. 应用图标的素材从 `src/web/assets/graph-icon.png` 迁到 `build/graph-icon.png`，`app:icons`
   继续可用。

## 后果

- 新克隆不再需要任何前端产物就能启动 daemon：`dist/web` 曾经是启动硬依赖，而重建它的命令
  已随控制台一起消失。
- 浏览器驱动的验证层整体消失（`tests/m8`、`tests/e2e` 里的浏览器用例、`tests/console` 的
  单元用例）。留住的证据是 Go 测试、`tests/app`/`tests/m7` 的 in-process 用例，以及
  `check:harness`。界面行为的机器可验部分靠 `ui.Tester` 无头断言与窗口存活，其余只能由用户
  目视确认——这条边界写在 `docs/agent/capabilities.md`。
- `scripts/interface-e2e.ts`、`scripts/measure-fold-policy.mjs` 这类在 `dist/web` 上测量的
  工具随功能删除；`scripts/perf/**` 与 `playwright-launch-report.mjs` 是为浏览器测服务的，
  等 Chromium 依赖一起清掉时再删。
- 破坏性变更：仍在传 `--web-dir` 的外部脚本会被当作未知参数拒绝。

## 相关

- ADR 0034 把后端交给 Go；本决策把界面也只留给 Go。
- ADR 0028（应用从自己的 checkout 运行产品线）不变：变的只是 daemon 不再需要前端产物。
