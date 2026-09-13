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
