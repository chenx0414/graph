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
