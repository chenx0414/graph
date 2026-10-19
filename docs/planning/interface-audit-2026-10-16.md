# Graph 界面诊断与改造 · 2026-10-16

## 范围与依据

按用户提供的 [jakubkrehel/skills](https://github.com/jakubkrehel/skills/tree/4c66b1fa86e9ab70187b43d7da9b6fdb29f2ef63) 中 `better-interface` 及六个 owning skills 执行：accessibility、layout、writing、typography、colors、ui。技能临时读取于 `/tmp/graph-interface-skills-20261016`，未自动安装到全局或项目，也未引入新的运行依赖。X 链接返回 403，未将不可访问的帖子作为证据。

技术栈为现有 React 19、React Flow、原生 CSS 与语义 token；保留浅色主题、系统字体、会话优先入口及任务图的正式投递模型。依据 `CODING_STANDARDS.md`、`CONTEXT.md`、产品范围、实现架构、实施计划、ADR 0009/0010/0030。测试遵守项目 test-audit：只新增/修改真实浏览器 E2E。

本轮检查首页、公共导航、创建项目、任务图的节点/连线入口、资源库、问题收件箱、工具统计、模型与常规设置。渲染检查重点是默认、空、首次配置和窄屏；实际图执行、投递详情、产物、节点会话由真实运行的 `ui-flow` 验收。不是对每个资源编辑器、每一种外部厂商错误、每一条大型历史记录的穷举审计。

| 维度 | 检查依据 | 结果 |
| --- | --- | --- |
| 无障碍 | 项目模态框、输入标签、导航、节点与连线、公共焦点与通知 | 修复焦点、键盘激活、标签与通知问题；未执行真实读屏器验收 |
| 布局 | 浏览器 320 / 768 / 1024 / 1440px、实际滚动树、多个页面 | 修复窄屏主操作不可达、导航与提示换行问题 |
| 文案 | 入口、空状态、首次配置、错误恢复、外观设置 | 明确下一步与真实功能状态 |
| 排版 | 实际布局、字体、标题、换行、移动输入、动态数字 | 保留系统字体，统一层次、换行与等宽数字 |
| 配色 | CSS token、浏览器 computed style、WCAG 2 对比度计算 | 修复辅助文字与成功色；保留状态含义 |
| 细节 | 焦点、选中、按钮、模态框、滚动、已有 reduced-motion 规则 | 统一交互反馈与表面；减少输入框大面积阴影 |

## 合并发现与处理

严重程度表示改造前的用户影响，同一根因只列一次。

| 严重程度 | 维度 | 位置 | Before | After | 原因与证据 |
| --- | --- | --- | --- | --- | --- |
| HIGH | Layout | `src/web/styles.css:3405`；`src/web/interface.css` | 320px 的旧侧栏约占 300px，首页内容在隐藏溢出的父容器内超高，发送按钮不可访问 | 移动导航收起为两行；展开列表限制高度；首页在固定可用高度内滚动 | 改前真实截图中底部发送动作消失；改后 E2E 在四个宽度将发送按钮滚入视口 |
| HIGH | Layout | `src/web/App.tsx:333` | banner 中说明文字和链接分别为 flex item，窄屏出现竖排断句 | 独立说明组，CTA 不收缩并可换行 | 320px 改前/后截图支持 |
| HIGH | Accessibility | `src/web/CreateProjectDialog.tsx:24` | 普通 div 模态层，没有 dialog 语义、背景隔离、Escape 与焦点恢复 | 原生 `dialog.showModal()`、名称、打开聚焦、关闭返回触发器 | 真实浏览器覆盖 Tab、Escape、取消和创建，背景控件不会获得焦点；浏览器自身 chrome 仍可被聚焦 |
| HIGH | Accessibility | `src/web/CreateProjectDialog.tsx:99` | 项目名主要依赖 placeholder，浏览器路径未与可见标签关联 | 可见 label、id、name 与 required；提交时原生校验 | E2E 通过可访问名称填写两个字段并创建真实项目 |
| HIGH | Accessibility | `src/web/GraphCanvas.tsx:407` | React Flow 节点键盘选择不调用应用的详情打开动作 | Enter / Space 与点击共用应用动作；节点有名称、状态及打开说明，增加图上焦点反馈 | 用项目 Node 24 执行改前 E2E，节点获得焦点后 Enter 无法打开 `node-overview`；修复后完整流程通过 |
| HIGH | Colors | `src/web/styles.css:21` | `--faint: #8b8f96` 在侧栏 `#f9f9fa` 上为 **3.09:1** | `#646971` 在当前实际侧栏 `#f7f7f8` 上为 **5.16:1**；成功色改为较深的绿色 | 辅助文字属于正常字号文本，需 4.5:1；不是单纯审美偏好 |
| HIGH | Writing | `src/web/Settings.tsx:366` | 系统/深色按钮仅改变局部选中状态，实际界面一直浅色 | 用只读说明准确表达当前支持的外观 | 原先 UI 暗示已切换成功；替换真实设置 E2E 中对应的虚假交互期待 |
| MEDIUM | Layout / Writing | `src/web/App.tsx:260`、`:704` | 主要入口只有图标，空白首页无可直接尝试的目标 | 导航文字、固定新对话入口、三个只填草稿的任务示例和三步流程 | 让初次使用者看出入口含义；已有草稿不会被覆盖，点击示例不会创建对话或发送任务 |
| MEDIUM | Accessibility / Writing | `src/web/shared.tsx:17`；`src/web/ui.tsx:154` | 错误一律称“加载失败”；危险样式的重试；错误 toast 3.6 秒消失 | “操作未完成”、恢复说明、普通重试按钮；错误 toast 保留至关闭，通知区稳定存在 | 失败不应冒充销毁动作；错误保留阅读时间，并可手动关闭 |
| MEDIUM | Accessibility | `src/web/TabBar.tsx:46` | `role=tab` 没有完整 tablist/方向键模式；非活动关闭按钮只在 hover 可见 | 保留原生按钮导航，使用 aria-current；键盘 focus-within / 触摸显示关闭按钮 | 使用原生语义修复，不增加第二套标签页状态机 |
| LOW | Typography / UI | `src/web/interface.css` | 首页层次弱，输入表面阴影重，换行及动态数字不一致 | 标题、引导、卡片层次；更轻阴影；数字 tabular-nums；移动输入 16px | 沿用原字体与中性配色，不替换图布局或执行状态 |

## 验证记录

- `node --run typecheck`：首轮通过；最终包含在完整检查内。
- `node --run build:web`：通过。已有 large chunk 与 `node:fs` browser externalization 提示仍存在，本轮不以 UI 改造名义替换打包架构。
- `node_modules/.bin/node node_modules/vitest/vitest.mjs run tests/m8/ui-flow.test.ts tests/m8/settings-ui.test.ts`：**2 文件、13 测试通过**。覆盖真实模型传输夹具、持久 graph、节点/连线、产物、配置与设置。
- `node_modules/.bin/node scripts/interface-e2e.ts`：独立 CLI 守护进程、真实配置落盘与 Chromium，覆盖首页任务示例不发送、不覆盖草稿、项目创建与刷新保留、模态框键盘/焦点、4 个宽度以及 inbox/catalog/tools/models/settings 页面。
- 普通截图写入系统临时目录；未更新 `docs/planning/acceptance-evidence/`。
- 手工计算检查实际颜色：辅助文字 5.16:1（资源库选中底色上 4.71:1）；普通说明 `#5d6066` 对白色 6.31:1；说明文字对 warning 背景在白色上 alpha 合成后 5.43:1；`#08783f` 对 `#e1efe8` 为 4.70:1；完全访问标签 4.52:1；信息蓝对当前浅蓝底色 5.67:1；焦点蓝对白色 5.17:1。没有把半透明背景当成不透明 RGB 计算。

首轮完整检查发现通知层遮挡聊天发送区，以及原有 E2E 期待“仅 hover 才显示添加入口”与本轮可发现性调整冲突。没有放宽发送断言：通知改到上方，空容器点击穿透，通知本身仍可关闭；真实侧栏 E2E 改为验证入口常显且可聚焦。

修复后重跑 `app-shell-ux`、`composer`、`composer-lifecycle`、`conversation-ui`、`conversation-boundaries-ui`、`skill-slash-ui`：**6 文件、63 测试通过**。第二轮完整检查为 **263 文件通过、1 文件失败；1474 测试通过、1 失败**。剩余失败发生在真实编辑器 E2E 的“全选后退格”：在整套并行负载下，键盘事件交付与浏览器选区更新之间没有等待，结果只删除一个字符。独立同用例通过。按 e2e-race-conditions 技能补充等待实际 `window.getSelection()` 为 `hello`，仍严格要求删除为空、撤销恢复原值；不增加固定 sleep，也不改写生产编辑器。完整检查结果见本轮交付补记。

## 未验证范围与结论边界

未以 VoiceOver / NVDA 实际朗读，未在真实 iOS 输入键盘、RTL、全部自定义资源编辑器、200% 原生浏览器缩放、所有外部厂商异常下逐一测试。320px reflow 是独立验证，不能替代原生缩放证明。保留现有全局 reduced-motion 规则；没有宣称逐个动画慢放检查已完成。

没有安装/重启默认 Electron 应用或操作用户正在运行的会话。桌面目录选择桥接与默认安装包的真实窗口需要独立验证；本轮证明的是当前源码、构建与真实本机 HTTP/浏览器应用路径。

对上述已检查并修复的范围为 **Approve**；这不是对未检查界面或完整 WCAG 符合性的认证。深色主题真实实现仍未提供，界面已明确说明。

## 交付补记

最终 `node --run check` **退出 0**：类型检查、promise lint、**264 文件 / 1475 测试全部通过**、suite baseline 匹配、验收证据未变。完整负载中的 `composer` 11 项（包含全选、删除、撤销/重做）通过，未以单独重跑代替完整验证。

最终独立 `node_modules/.bin/node scripts/interface-e2e.ts` 通过。截图目录：`/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-interface-e2e-Ouj8dZ`。改前截图位于 `/tmp/graph-uiux-20261016/before-home.png` 与 `before-mobile.png`；完整门禁日志位于 `/tmp/graph-uiux-20261016/full-check-release.log`。这些均为普通验证临时文件。

源码与 `dist/web` 已更新；本轮未提交、推送、安装默认桌面包或重启现有桌面会话。

## 桌面安装补记

按用户后续要求，已构建并替换 `/Applications/Graph.app`，`app:build` 与包内校验通过；包内 `App.tsx` 与当前源码摘要一致。安装文件同时位于 `dist/app/Graph-0.1.0-arm64.dmg`。

原 `~/.graph/app-root` 指向旧工作副本，已备份并改为本轮通过检查的 `/Users/macmini/workspace/13-Graph`，使默认启动实际加载新界面。旧 `.app`、启动来源、配置、凭据和 SQLite 快照保留在 `/Users/macmini/Library/Application Support/Graph-update-backups/20261016-uiux`。

实际安装的 Electron 窗口经 CDP 检查：desktop 标记为 true，加载新版导航与界面样式，恢复原会话地址，健康检查 200。配置与保存的凭据摘要未变；120 个会话、47676 条消息、124 个任务的持久记录数量均保留。截图位于 `/tmp/graph-uiux-20261016/installed-desktop.png`。检查结束后已正常退出验证进程，再以无调试参数的普通方式重新打开安装应用。
