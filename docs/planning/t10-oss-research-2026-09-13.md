# T10 · 开源项目定向借鉴与 APP 化调研（2026-09-13）

本文件是 T10 的交付物：围绕 Graph 的具体体验缺口做小范围借鉴调研，并为“APP 版本”（降低操作门槛、提高可视化）给出有证据的选型建议。只提交调研与建议，本身不改代码、不替换核心依赖；实施见 [APP 版本方案](app-version-plan-2026-09-13.md)。

## 方法与事实边界

- 只使用一手来源：项目官方文档仓库的 Markdown 源、项目 README、GitHub API 元数据与 releases 数据。全部链接与提交在 2026-09-13 固定（见下表）。
- 判断仓库状态用 GitHub API 的 `license`、`pushed_at`、`archived`、`default_branch`；判断运行时事实用官方文档。
- 版本事实：Electron 最新稳定版 **44.3.0** 内置 **Node 24.20.0**（与 Graph 声明的 Node 完全一致）、Chromium 152（来源：<https://releases.electronjs.org/releases.json>）。
- 不做的判断：不评价未公开源码的同类产品；不把 “星标多” 当作技术结论。

## 参考仓库与固定提交

| 项目 | 一手来源 | 固定提交 | 许可证 | 状态（2026-09-13） |
| --- | --- | --- | --- | --- |
| Electron | <https://github.com/electron/electron> | `b260e07d9ce0` | MIT | 123k stars，活跃 |
| Electron Forge | <https://github.com/electron/forge> | `8a29c3fa5373` | MIT | 7.1k stars，活跃 |
| electron-builder | <https://github.com/electron-userland/electron-builder> | `b856d2b99595` | MIT | 14.6k stars，活跃 |
| Tauri | <https://github.com/tauri-apps/tauri> | `d0f38df06a2f` | Apache-2.0 | 111k stars，活跃 |
| React Flow / xyflow | <https://github.com/xyflow/xyflow> | `0a1f9575b256` | MIT | 38k stars，活跃 |
| elkjs | <https://github.com/kieler/elkjs> | `fe952eea3159` | EPL-2.0 OR GPL-3.0-or-later | 2.7k stars，活跃 |
| OpenHands（Agent Canvas） | <https://github.com/OpenHands/OpenHands> | `28464621d879` | MIT | 87k stars，活跃（由 All-Hands-AI/OpenHands 改名） |
| Open SWE | <https://github.com/langchain-ai/open-swe> | `6c925eeab74c` | MIT | 10.7k stars，活跃 |
| Vibe Kanban | <https://github.com/BloopAI/vibe-kanban> | `4deb7eca8f38` | Apache-2.0 | 28k stars；README 首屏公告 **sunsetting**，仅作参考 |
| Jan | <https://github.com/janhq/jan> | `6ccd6f4ad227` | 自定义（非 OSI 标准） | 44k stars，活跃；Tauri 技术栈 |
| Ollama | <https://github.com/ollama/ollama> | `53fed2611281` | MIT | 180k stars，活跃 |
| LangGraph | <https://github.com/langchain-ai/langgraph> | `e539ac122f41` | MIT | 41k stars，活跃 |
| Microsoft Agent Framework | <https://github.com/microsoft/agent-framework> | `3c670707766a` | MIT | 13k stars，活跃 |

## Graph 现状缺口（本仓库内证据）

1. **启动门槛**：需要手工 `build:web` + 终端命令 + 手写 `graph.config.json`；没有桌面入口、托盘或通知（`README.md`、`docs/usage.md`）。
2. **密钥门槛**：凭据只支持 `secretRef` 环境变量，用户要自己在 shell 里设置；没有系统钥匙串集成（`docs/usage.md` 配置表）。
3. **可视化基础已有、交互仍薄**：前端已依赖 `@xyflow/react 12.11.6` 与 `elkjs 0.12.0`（`package.json`），`src/web/GraphCanvas.tsx` 已画容器、后向循环边与选中态，但只有 `Background` 与 `Controls`，没有 MiniMap、节点详情抽屉、运行时间线或成本面板；问题需进任务详情手动处理（`src/web/App.tsx`）。
4. **交付闭环已落数据、缺聚合视图**：T06 已有交付面板与证据、操作记录分页，但没有把“谁在等、卡在哪一步、花了多少”汇总到一屏。
5. **运维**：单守护进程、owner 锁、loopback 边界已稳；缺应用级生命周期（托盘、退出有界停止）、通知与自动更新。

## 对照表：缺口 → 参考 → 适用设计 → 预计改动 → 不用原因

| # | Graph 具体问题 | 参考实现（链接 + 提交） | 可借鉴的设计 | 预计改动 | 不采用 / 延后原因 |
| --- | --- | --- | --- | --- | --- |
| 1 | 首次运行要构建 + 命令行 + 手写 JSON | Electron 进程模型与 `utilityProcess.fork`（[process-model.md](https://github.com/electron/electron/blob/b260e07d9ce0/docs/tutorial/process-model.md)、[utility-process.md](https://github.com/electron/electron/blob/b260e07d9ce0/docs/api/utility-process.md)）；Electron Forge/`@electron/notarize`（[code-signing.md](https://github.com/electron/electron/blob/b260e07d9ce0/docs/tutorial/code-signing.md)）；Jan 以桌面壳 + 本地后端分发（`6ccd6f4ad227`） | 由 APP 负责启动守护进程与打开窗口；同仓库 Node 版本对齐（Electron 44.3.0 = Node 24.20.0）；首次运行向导替代手写配置 | 新增 `desktop/`（主进程 + preload）；脚本 `app:dev` / `app:build`；打包配置 | 不选 Tauri：本仓库守护进程是 Node/TS，Tauri 需把 Node 作为 sidecar 二进制（[sidecar.mdx](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/sidecar.mdx)）并引入 Rust 工具链，复用率低；Jan 用 Tauri 是因为其后端是 Rust |
| 2 | 密钥要用户配环境变量 | Electron `safeStorage`（[safe-storage.md](https://github.com/electron/electron/blob/b260e07d9ce0/docs/api/safe-storage.md)）：macOS 存 Keychain；Tauri `store` 插件为对照（[store.mdx](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/store.mdx)） | 向导里输入密钥 → Keychain 加密落盘 → 启动守护进程时解密并注入环境变量；配置文件仍只保存 `secretRef`，密钥不进文件/日志/页面 | 仅 `desktop/` 与向导 UI | 注意文档明示的 Linux 回退：无 secret store 时 `basic_text` 等同明文（[safe-storage.md](https://github.com/electron/electron/blob/b260e07d9ce0/docs/api/safe-storage.md)），macOS 为首要平台 |
| 3 | 图能看、不好“读” | React Flow（已是依赖，MIT）官方组件；OpenHands Agent Canvas 把前端当作控制中心（[architecture.md](https://github.com/OpenHands/OpenHands/blob/28464621d879/docs/architecture.md)）；Microsoft Agent Framework 的可观测性与 DevUI（[README](https://github.com/microsoft/agent-framework/blob/3c670707766a/README.md)） | MiniMap + 节点详情抽屉（成本/耗时/状态/操作）；事件驱动的运行时间线；问题收件箱；成本按节点/凭据聚合 | `src/web/GraphCanvas.tsx`、`App.tsx`，复用现有 `/api/events`、`/api/limits` 与操作记录接口 | 不更换图库、不引入新布局引擎：`@xyflow/react` + `elkjs` 已在用 |
| 4 | 交付/审查闭环不聚合 | Open SWE：Web dashboard + 提交/PR 交付循环，FastAPI 后端（[README](https://github.com/langchain-ai/open-swe/blob/6c925eeab74c/README.md)）；LangGraph：持久执行与人工中断（[README](https://github.com/langchain-ai/langgraph/blob/e539ac122f41/README.md)）；Vibe Kanban：工作区/审查交互（sunsetting，仅参考） | 任务页聚合“节点完成 → 证据 → 审查 → 合并”状态与入口；暂停/提问可作为时间线里的中断点呈现 | `TaskPanel`/`GraphPanel` 扩展 + 少量只读接口 | 不引入 LangGraph/MAF 运行时：恢复与中断语义已由本仓库 store/事件与 R13、PA 轮验收覆盖，换框架成本远大于收益 |
| 5 | 分发与更新 | Electron Forge / electron-builder / `@electron/notarize`；Tauri updater（签名 + pubkey，[updater.mdx](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/updater.mdx)） | 先做本机 `.app`（dmg 可选）；签名/公证与自动更新作为独立里程碑 | `electron-builder` 配置 + 文档 | 目前没有 Apple Developer ID 与更新服务器；不阻塞本机 APP 先行 |

## 三个可独立实施的改进（最多三个）

### I1 · 桌面 APP 壳与首次运行向导（对应缺口 1、2、5）

- **内容**：Electron 壳启动并托管守护进程；首启向导完成“选项目 → 选模型模板 → 填密钥（Keychain）→ 保存”；托盘常驻、退出有界停止；任务完成/提问时发系统通知。
- **验收方式**：在无 `graph.config.json`、无 shell 环境变量的干净用户目录启动 APP，按向导完成配置并提交一个受控模型任务；通知可点击回到任务；退出后 `ps` 无守护进程；`graph.config.json` 与日志中搜不到密钥明文；原有 `node --run test` 全绿。

### I2 · 可视化增强（对应缺口 3）

- **内容**：`GraphCanvas` 加 MiniMap 与状态角标；节点点击出详情抽屉（成本、耗时、操作、实例）；任务页加运行时间线与成本汇总；问题收件箱聚合待回答项。
- **验收方式**：同一事件流重放时间线与实时一致；未知用量显示“未知”而非 0；100 节点图平移/缩放流畅（交互 fps 与首屏绘制有实测值）；既有 `tests/m8/*ui*` 断言适配后全绿。

### I3 · 交付与审查闭环视图（对应缺口 4）

- **内容**：把“节点完成 → 验收证据 → 审查状态 → 合并入口”聚合到一屏；暂停/提问在时间线上显式标记。
- **验收方式**：带集成分支与审查节点的任务能在一屏看到阶段与证据绑定有效性；无审查节点的任务不被误标为可合并；截图与只读接口测试入库。

## 结论

- **APP 化选型：Electron（44.3.0）**。决定性事实是版本对齐（Electron 44.3.0 内置 Node 24.20.0，与仓库声明一致），现有 TS 守护进程与 React 前端可原样复用；`utilityProcess.fork` 提供等价的 Node 子进程（官方文档明示 `child_process.fork` 等价），`safeStorage` 提供 Keychain。Tauri 的体积优势需要以 Rust 工具链 + Node sidecar 为代价，对本仓库不划算。
- **不迁移框架、不换图库、不引入 sunsetting 依赖**（Vibe Kanban 仅作交互参考；Jan 的许可证非 OSI 标准，不复制其代码）。
- 实施在分支 `feat/app-console` 推进，是否合并进 `main` 由用户决定；方案与里程碑见 [APP 版本方案](app-version-plan-2026-09-13.md)。
