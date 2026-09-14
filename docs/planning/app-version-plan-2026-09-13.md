# Graph APP 版本方案（2026-09-13）

目标：为 Graph 提供桌面 APP 版本，把“构建前端 → 终端启动 → 手写配置 → 设置环境变量”压缩成“打开 APP → 向导配置 → 提交任务”，同时把运行观测（图、时间线、成本、问题、交付）集中到一屏。选型证据见 [T10 调研](t10-oss-research-2026-09-13.md)。

分支：`feat/app-console`。**是否合并进 `main` 由用户决定，本分支不自行合并。**

## 用户旅程

1. 首次打开：APP 在本机启动守护进程（仅回环），检测无配置 → 显示首次运行向导。
2. 向导三步：选择项目目录（原生对话框）→ 选择模型模板（本地 OpenAI 兼容 / 自定义 OpenAI 兼容）→ 填密钥（写入系统钥匙串）→ 保存配置。
3. APP 自动以执行模式重启守护进程并打开控制台；之后可从托盘常驻，任务完成/提问时收到系统通知，点击回到任务。
4. 关闭窗口不停止守护进程；退出 APP 触发有界停止（5 秒），在途调用不被记作成功。

## 架构

```text
Graph.app
├── main process (Electron, Node 24.20.0)
│   ├── 读取/生成配置：userData/graph.config.json（仅 secretRef，不含密钥）
│   ├── safeStorage：密钥加密存 userData/secrets.json，启动时解密注入子进程 env
│   ├── utilityProcess.fork(src/server/cli.ts)
│   │     └── 现有守护进程：owner 锁、loopback HTTP/SSE、执行/仅查看模式
│   ├── BrowserWindow → http://127.0.0.1:<port>（现有 React 前端）
│   ├── 托盘 / 通知 / 退出编排
│   └── preload（contextBridge）：pickDirectory、secrets.save/status、app.info
└── resources: src/（Node 类型剥离直跑）、dist/web/（vite 构建）
```

技术决策与理由：

- **Electron 44.3.0**：内置 Node 24.20.0，与仓库 `node -v` 完全一致；`utilityProcess.fork` 官方等价 `child_process.fork`，可直接 fork 现有 `src/server/cli.ts`（Node 24 默认类型剥离，无需为守护进程另建构建产物）。
- **复用现有 Web 控制台**：不重写 UI；BrowserWindow 加载守护进程地址，SSE 与游标续传逻辑不变。
- **密钥边界不变**：配置文件仍只写 `secretRef`；APP 只负责把解密后的值放进子进程环境变量。密钥不写配置文件、不进日志、不进页面；`secrets.json` 只存 `safeStorage.encryptString` 的密文。
- **状态目录**：默认 `app.getPath('userData')/state`，可通过环境变量覆盖；与 CLI 版各自独立，避免 owner 锁互抢。
- **打包**：`electron-builder`（MIT）产出本机 `.app`/`.dmg`；签名与公证（`@electron/notarize`）需要 Apple Developer ID，作为独立里程碑，不阻塞本机开发。
- **自动更新**：后置；需要更新服务器与签名，不在首批范围。

## 里程碑与验收

### A1 · 桌面壳骨架

- `desktop/main.ts`（ESM）、preload、`package.json` 脚本 `app:dev`；用 `utilityProcess.fork` 启动守护进程，解析就绪输出，窗口加载控制台；退出时 SIGTERM + 有界等待。
- 验收：`app:dev` 打开真实控制台；窗口关闭不杀守护进程；退出后 `ps` 无残留；无配置时进入向导路由而不是报错。

### A2 · 首次运行向导 + 钥匙串

- 新增 `#/setup` 向导（浏览器里也可用，只是密钥改用环境变量提示）；preload 提供目录选择与密钥保存；保存走现有 `POST /api/config`（revision、字段错误、共享组冲突校验全部复用）。
- 首启后自动以执行模式重启守护进程。
- 验收：干净数据目录按向导完成配置 → 执行模式就绪；`graph.config.json`、日志、页面中搜不到密钥明文；revision 冲突与字段错误在向导内可恢复。

### A3 · 可视化增强（已交付）

- `GraphCanvas`：MiniMap、状态色边框、节点详情抽屉（原有）。
- 任务页：运行时间线（事件流聚合）、用量与预算汇总（未知用量单列）、问题收件箱（`#/inbox`，导航徽标，可直接回答）。
- 桌面通知：新增待处理问题、任务完成/失败时发系统通知，点击跳任务；Dock 角标显示开放问题总数。
- 验收：事件重放与实时一致；未知用量显示“未知”；100 节点图交互实测；现有 `tests/m8` UI 断言适配后全绿，新增 `tests/app/*` 单测（纯逻辑）。

### A4 · 打包与文档（已交付）

- `electron-builder` 配置、应用图标与托盘常驻、`app:build`；`docs/usage.md` 增补 APP 安装、卸载与排障；`README.md` 增补 APP 入口。
- 验收：本机产出可双击启动的 `.app`；无 Node/终端环境也能完成 A2 验收流程；卸载说明与数据目录位置准确。

### A5 · 界面视觉与交互重塑（已交付）

- 设计系统与组件库（`styles.css` + `ui.tsx`）、侧边栏外壳、明暗主题、状态标签/统计卡/时间线/空状态/Toast、CSS 动效与 reduced-motion 降级；保留全部既有 `data-testid` 与文案。
- 证据：`app-reports.md` A5 节与 `acceptance-evidence/app-ui-*` 截图。

### A6 · 签名、公证与自动更新（可选，独立确认）

- 需要 Apple Developer ID 与更新服务器；先产出配置与操作手册（`wizard` 技能），拿到证书后再执行。

## 测试与安全边界

- 纯逻辑（配置生成、密钥装填、端口/就绪解析、通知去重）用 vitest，不依赖 GUI；GUI 冒烟测试在有显示环境下手动/脚本执行，连续集成默认跳过。
- 不新增付费供应商调用；测试用本地受控模型与合成凭据。
- 守护进程的 loopback、owner 锁、sandbox-exec、密钥不落盘等既有边界全部保留；APP 不得放宽它们。
- 所有命令带超时；退出路径必须清理子进程。

## 证据与合并

- 每步在 `docs/planning/app-reports.md` 记录：起始提交、完成提交、验收清单状态、可复跑命令与输出路径。
- 分支 `feat/app-console` 只推进实现与证据；合并到 `main` 前由用户确认，未确认不合并。
