# APP 版本交付报告

范围与里程碑见 [APP 版本方案](app-version-plan-2026-09-13.md)；T10 选型证据见 [T10 调研](t10-oss-research-2026-09-13.md)。分支 `feat/app-console`，合并进 `main` 由用户决定。

## A1 · 桌面壳骨架（2026-09-13）

**起始提交**：`adf6b19`（调研与方案）。
**完成提交**：本次提交。
**实际修改范围**：`desktop/lib.ts`（纯逻辑：路径解析、守护进程参数、banner 地址解析、模式判定、Keychain 密文读写）、`desktop/main.mjs`（Electron 主进程：单实例锁、`ELECTRON_RUN_AS_NODE` 子进程、窗口、有界退出）、`tests/app/desktop.test.ts`（9 项）、`package.json`（`main`、`app:dev`/`app:smoke`、electron devDependency）、`tsconfig.json`（include `desktop/**/*.ts`）、README 与使用文档的 APP 预览段。

**验收清单**

- [x] 打开真实控制台：`APP_SMOKE_OK http://127.0.0.1:56097`，窗口加载真实 React 页面（截图 `acceptance-evidence/app-a1-console.png`，标题 `Graph`，显示首次运行仅查看横幅）。
- [x] 关闭窗口不停止守护进程：关闭页面后 `/api/startup` 仍返回 401（进程存活、鉴权生效），证据 `acceptance-evidence/app-a1-lifecycle.output.txt`。
- [x] 窗口关闭后可再次打开：第二次启动同一 APP 触发单实例 `second-instance`，页面重新出现（`pages_after_second_launch 1`）。
- [x] 退出后无残留：SIGTERM 主进程后 `ps` 计数 `orphans=0`。
- [x] 无配置不崩溃：以仅查看模式启动并显示首次运行横幅；向导路由在 A2 交付。
- [x] 纯逻辑回归：`tests/app/desktop.test.ts` 9 项通过；全量套件与双 tsc 通过（见提交说明）。

**可复跑命令**

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
npx --yes electron@44.3.0 --version
GRAPH_APP_SMOKE=1 npx --yes electron@44.3.0 .        # 期望 APP_SMOKE_OK <loopback url> 且退出码 0
node -m vitest run tests/app/desktop.test.ts          # 9 项
```

**边界与后续**

- 本机以 `npx electron@44.3.0` 验证（仓库 `node_modules` 为 pnpm 布局，未改写）；`electron` 已写入 devDependencies，使用 pnpm 的环境会在下次安装后提供同版本二进制。
- 密钥仍沿用 `secretRef` 环境变量契约；Keychain 装填与向导在 A2；打包与签名在 A4。

## A2 · 首次运行向导与钥匙串（2026-09-13）

**起始提交**：`094d04e`（A1 桌面壳）。
**完成提交**：本次提交。
**实际修改范围**：`src/web/setup.ts`（表单模型、模板、校验、配置文档合并、字段映射）、`src/web/Setup.tsx`（`#/setup` 向导页）、`src/web/App.tsx`（路由、导航与首启横幅入口）、`desktop/preload.cjs`（contextBridge）、`desktop/main.mjs`（配置播种、IPC：目录选择/密钥保存/状态/重启、重启竞态修复、导航日志）、`desktop/lib.ts`（`ensureConfigFile`）、`tests/app/setup.test.ts`（8 项）与 `desktop.test.ts` 扩展（3 项）、README/使用文档。

**验收清单**

- [x] 首启可进入向导：首启横幅与导航都有 `#/setup` 入口；截图 `acceptance-evidence/app-a2-wizard.png`。
- [x] 向导保存走既有配置 API：`POST /api/config` 使用 `expectedRevision` 与字段校验；保存后 `revision` 从 0 变 1，文件内容为项目 `e2e-demo` + 模型 `local-model` + `credentials.local.secretRef`（证据 `acceptance-evidence/app-a2-e2e.output.txt`）。
- [x] 保存后自动重启并生效：守护进程从 `127.0.0.1:64147` 切到 `127.0.0.1:64158`，页面自动导航到新地址并显示“模型已配置但凭据未解析”的仅查看横幅，`/api/startup` 返回 `modelCount:1, effectiveRevision:1`。
- [x] 密钥边界：向导把密钥交给主进程经 `safeStorage` 写入钥匙串；密钥不进配置文件。E2E 未填写密钥（避免钥匙串弹窗），断言 `secrets.json` 不存在；编解码用假 codec 单测（含加密不可用与损坏文件降级）。
- [x] 已有配置不覆盖：向导检测非空配置后只提示去设置页，不渲染表单。
- [x] 退出无残留：`orphans=0`；纯逻辑与全量套件见提交说明。

**可复跑**

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
vite build
# 真实窗口 E2E（干净 userData + 临时项目）：见 acceptance-evidence/app-a2-e2e.output.txt 内命令
node_modules/.bin/vitest run tests/app    # 20 项
```

**边界与后续**

- 桌面壳先播种最小配置（`{"version":1,"projects":[]}`），使守护进程始终绑定配置路径，`/api/config` 才可用；浏览器直连无配置的守护进程时向导仍提示先建配置文件。
- 钥匙串写入路径未做 GUI 自动化（safeStorage 首次使用可能弹系统授权）；A4 打包后在真机手工验收一次密钥写入与任务派发。

## A3 · 可视化增强（2026-09-13）

**起始提交**：`b4aabc0`（A2 向导与钥匙串）。
**完成提交**：本次提交。
**实际修改范围**：`src/web/insights.ts`（时间线投影、用量汇总、状态色、问题计数）、`src/web/GraphCanvas.tsx`（MiniMap、状态色边框）、`src/web/App.tsx`（运行时间线、用量面板、问题收件箱路由与导航徽标、任务列表轮询、事件刷新合并）、`src/web/event-cursor.ts`（保留完整事件负载）、`src/core/task-runtime.ts`（任务列表带开放问题数）、桌面通知（`desktop/lib.ts` 决策函数 + `desktop/main.mjs` 轮询/系统通知/Dock 角标/点击跳任务）、`tests/app/insights.test.ts`（8）、`tests/app/insights-ui.test.ts`（3）、`tests/app/desktop.test.ts`（+2）、`tests/m8/ui-flow.test.ts`（游标负载断言）、证据探针 `acceptance-evidence/app-a3-flow.mts`。

**验收清单**

- [x] 事件重放与实时一致：时间线只由 `/api/tasks/:id/events` 与同一 `nextEventCursor` 去重后的 SSE 帧驱动，UI 测试在真实事件流后断言含“创建任务 / 调用完成 / 任务完成”；实时刷新走 150ms 合并，与图页一致。
- [x] 未知用量显示“未知”：`summarizeUsage` 单独计数未知节点；证据中检查节点显示“1 个节点用量未知”，单测覆盖 null/undefined 不折零（`已计量 20 tokens · 1 个节点 · 1 个节点用量未知`）。
- [x] 图增强：MiniMap 可见、成功节点边框实测 `rgb(22, 163, 74)`、100 节点首屏绘制 **32ms**（证据探针内拦截图接口合成 100 节点；UI 测试同样断言 < 3000ms）；截图 `app-a3-graph.png`。
- [x] 问题收件箱：导航显示 `问题 (1)` 徽标，`#/inbox` 聚合待处理问题可直接答复；UI 测试点击“答复”后收件箱清空且服务端问题关闭。
- [x] 桌面通知：主进程每 4s 轮询任务列表，新增开放问题或到达完成/失败发系统通知，点击聚焦并跳到任务；Dock 角标显示开放问题总数；决策函数单测覆盖首帧只预热、已回答不重复通知；APP 实跑 9s 无异常、退出无孤儿。
- [x] 既有 UI 断言适配：`tests/m8` 全部通过（游标测试改为断言完整负载保留）。
- [x] 纯逻辑与全量：51 文件 / 249 项、双 tsc、vite build 通过；证据 `acceptance-evidence/app-a3-flow.output.txt` 与三张截图。

**边界**

- 托盘常驻并入 A4（需要应用图标与打包资源）；当前关闭窗口仍保留 Dock 图标与菜单，通知与角标已在 A3 生效。
- 100 节点测量只覆盖前端渲染（图布局仍由服务端 ELK 计算）；真实大规模图的服务端布局耗时未在本次测量范围内。

## A4 · 打包（2026-09-13）

**起始提交**：`982e09f`（A3 可视化增强）。
**完成提交**：本次提交。
**实际修改范围**：`scripts/make-icons.mjs`（Playwright 渲染应用图标与托盘模板图，可复现）、`scripts/package-app.mjs`（staging + 扁平 npm 生产依赖 + electron-builder）、`build/icon.png` / `build/trayTemplate.png` / `build/trayTemplate@2x.png`、`desktop/lib.ts`（打包路径改按 app 目录解析、托盘菜单定义）、`desktop/main.mjs`（托盘创建与刷新、待处理问题计数）、`package.json`（版本 0.1.0、`app:icons`/`app:build`、electron-builder 26.15.3）、`.gitignore`（`.stage/`、`.tooling/`）、README 与使用文档。

**验收清单**

- [x] 本机产出可双击启动的 `.app`：`dist/app/mac-arm64/Graph.app`（489MB，未压缩；`Graph-0.1.0-arm64.dmg` 162MB），`Info.plist` 中 `CFBundleName=Graph`、`CFBundleIdentifier=dev.graph.console`、`CFBundleShortVersionString=0.1.0`。
- [x] 无 Node/终端环境可完成 A2 流程：以 `env -i HOME=… PATH=/usr/bin:/bin` 启动打包版，首启向导 → 保存 → 守护进程自动重启到新端口 → `revision 1`；全过程不依赖系统 Node、shell 环境变量或源码目录。
- [x] 托盘常驻：打包资源内 `build/trayTemplate.png(@2x)` 存在，`tray ready` 日志出现；菜单含“打开控制台 / 待处理问题 N / 退出 Graph”，Dock 角标与通知沿用 A3。
- [x] 打包不依赖 pnpm 符号链接：`.stage` 用 npm 安装扁平生产依赖，electron-builder 只看到普通目录；`npmRebuild=false`，签名显式关闭（`identity=null`）。
- [x] 卸载与数据位置写入文档：应用删除即卸载；数据在 `~/Library/Application Support/Graph`（配置、state、secrets 密文）。
- [x] 质量门：全量测试/双 tsc/build 通过（见提交说明）；打包版启动退出 `orphans=0`。

**证据**

- `acceptance-evidence/app-a4-package.output.txt`（构建摘要、产物信息、无 Node 启动检查、打包版向导 E2E、托盘日志、孤儿计数）。
- `acceptance-evidence/app-a4-window.png`（打包版真实窗口）。
- 复跑：`export PATH="$PWD/node_modules/.bin:$PATH"; node --run app:build`。

**已知边界（后续）**

- `.app` 体积 489MB：`@earendil-works/pi-ai` 带入了完整 AWS SDK；本机开发可接受，后续可按需裁剪或在 A5 前做依赖瘦身。
- 构建未签名/未公证：本机直接运行正常；对外分发需要 Apple Developer ID 与公证（`identity`、`@electron/notarize`），操作手册在 A5 之前以 wizard 形式提供。
- 目前只产出 mac arm64；Intel 与 Windows/Linux 目标未配置。

## A5 · 界面视觉与交互重塑（2026-09-13）

**起始提交**：`d34ad3d`（A4 打包）。
**完成提交**：本次提交。
**实际修改范围**：新增 `src/web/styles.css`（设计 token、外壳布局、卡片/按钮/输入/标签/统计/时间线/收件箱/图样式、动效、响应式与 `prefers-reduced-motion`）与 `src/web/ui.tsx`（`Icon`、`Button`、`Card`、`Pill`、`StatusDot`、`Stat`、`Field`、`Empty`、`Spinner`、`Toaster`、`useTheme`）；重写 `App.tsx`/`Setup.tsx`/`Settings.tsx`/`GraphCanvas.tsx` 的呈现层；`src/web/index.html` 首屏主题、`main.tsx` 引入样式与桌面标记；`desktop/main.mjs` 窗口背景色与 `hiddenInset` 标题栏；`tests/app/insights-ui.test.ts` 断言适配。

**验收清单**

- [x] 设计系统与组件库：token（浅/深色）、统一圆角/阴影/间距；按钮 4 变体、输入校验态、状态标签、统计卡、空状态、加载、Toast；页面全部改用组件而非内联样式。
- [x] 导航与外壳：左侧栏（图标、活跃态、问题徽标、模式状态点、主题切换）、顶栏（标题、模式与项目/模型摘要）、首启/仅查看横幅；响应式在窄屏折叠为顶部导航。
- [x] 主题：默认跟随系统，可手动切换并记忆（localStorage），首屏脚本避免闪烁；Electron 窗口背景色与隐藏标题栏（含拖拽区与红绿灯留白）。
- [x] 动效：页面入场与列表 stagger、时间线条目滑入、按钮 hover/active、活跃节点脉冲、Toast 弹出；`prefers-reduced-motion` 时全部降级。
- [x] 可视化增强：图节点改为状态色卡片（状态点 + 原始 `id status` 文本保留），MiniMap 与控件皮肤化，图例改为色块 chips。
- [x] 兼容既有验收：全部 `data-testid` 与断言文案保留；T08 集成测试的问答循环改为确定性逐条处理（原实现存在列表收缩竞态，界面加速后暴露）；51 文件 / 250 项测试连续通过，双 tsc 与构建通过。
- [x] 证据：`acceptance-evidence/app-ui-{overview,overview-dark,task,graph,inbox,settings,setup}.png`、桌面窗口 `app-ui-desktop.png`、探针输出 `app-ui-restyle.output.txt`（含时间线条目数、状态文案、图节点数、收件箱文本、revision、向导按钮文案）；打包版重建后 `reparse` 警告为 0、启动退出无残留。

**边界**

- 只做前端呈现层与桌面窗口外观；未引入任何新前端依赖（动效为 CSS 实现）。
- 打包体积、签名与公证仍按 A4/A6 记录；`/Applications/Graph.app` 中若有用户先前安装的旧实例，不会被本次构建改动。

## 配置扩展 · 模型请求头与 OpenCode GO（2026-09-13）

**修改范围**：`ModelEntry.headers`（`src/catalog/models.ts`）、配置解析校验（`src/server/config.ts`）、pi-ai 与连通性测试转发（`src/runtime/pi-adapter.ts`、`src/server/start.ts`）、设置页请求头展示与钥匙串保存入口（`src/web/Settings.tsx`）、provider 头捕获（`tests/fixtures/openai-server.ts`）、回归 `tests/m8/provider-headers.test.ts`。

**验收**

- [x] 配置支持每模型 `headers`（最多 20 个，名称与取值校验），随真实派发与 `/api/config/test` 一起发送；回归测试用真实 daemon + 受控 provider 断言 `x-opencode-session` 到达且 Authorization 正确。
- [x] OpenCode GO 接入：仓库 `graph.config.json`（本地、gitignore）加入 `deepseek-v4-flash`（provider `opencode-go`，baseUrl `https://opencode.ai/zen/go/v1`，`headers.x-opencode-session=graph-console`，credentialRef `OPENCODE_GO_API_KEY`）；桌面 APP 配置同步加入该模型并 revision +1。
- [x] 真实验证（证据 `acceptance-evidence/opencode-go-verification.output.txt`）：直连 `POST /chat/completions` 200、“ok”、3.9s；Graph `/api/config/test` 返回 `ok:true`、HTTP 200、1.26s；真实派发任务让 agent 创建 `hello.txt`，12–17s 内节点 `succeeded`、写入内容 `hello`、消耗 6219–8358 tokens，无待处理问题。
- [x] 全量 52 文件 / 254 项测试、双 tsc 与构建通过；设置页新增“保存到钥匙串”按钮（桌面壳内），CLI 仍以环境变量提供密钥。

## 修复 · 仅查看模式任务停摆与调度恢复（2026-09-13）

**问题**：在仅查看模式下提交的任务一直停在“讨论中”、任务图为空。原因有三层：桌面壳 `resolveDaemonMode` 要求**全部**凭据可解析，一条凭据缺失就整体降级；daemon 的 `enabled` 同样要求 `missing.size === 0`，与文档“至少一个模型”不符；且仅查看模式下 `begin` 不创建 master 节点，切换到执行模式后没有任何可派发节点，`active_task` 也为空。

**修复**：`resolveDaemonMode` 与 daemon 的 `enabled` 改为“至少一个模型的凭据可解析即调度”，缺失凭据的模型保持禁用并在派发时明确拒绝；CLI 执行模式仅在**无任何**可用凭据时报错；启动时若存在“讨论中且无 master”的任务则补建 master、写 `task.master_recovered` 事件并按顺序激活第一条，使其在执行模式下自动继续；`enabledModelCount` 报告真实可用模型数；首启横幅在桌面壳内提示可用设置页保存密钥。回归：`provider-headers.test.ts` 新增部分凭据与恢复调度两用例，`desktop.test.ts` 更新模式判定；全量 52 文件 / 256 项通过。

**补充（真实数据验证）**：旧项目 `demo` 的任务 `efc6e457` 保持历史不恢复；仍在配置中的任务 `b4d80558` 在真实 APP（执行模式、钥匙串密钥、无环境变量）启动后自动补建 master 并在约 200 秒内产出**提案 v1**（消耗 137,698 tokens、费用 0.03069），任务页时间线显示“恢复任务调度 → 准备调用 master → 发送调用 → 生成提案 → 调用完成”。截图：`acceptance-evidence/app-real-recovered-task.png`。
