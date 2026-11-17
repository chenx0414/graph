# Graph Feature Map

这是 Graph 用户可见功能的验证地图。**任何一个功能「现在到底是不是真的能用」，从这里开始找，不要临时写脚本。**

- 唯一入口：`verification/verify-graph <command>`（见 [`../../SKILL.md`](../SKILL.md)）
- 机器可读索引：本目录 [`index.json`](index.json)（每条 feature 的场景、命令、证据路径、覆盖的面板与 API、覆盖车道）
- 证据根：`verification/evidence/<run>/<feature>/`（`cleanup` **不删**）
- 运行态根：`verification/.run/<run>/`（`cleanup` 删）

## 证明标准（缺一件就不算 pass）

每条 feature 的「能用」由三件套共同判定，写进 `evidence/<run>/<feature>/assertions.json`：

| 件 | 是什么 | 为什么不能省 |
| --- | --- | --- |
| **界面断言** | 真窗口的 agent-desktop AX 快照，或 headless 车道的渲染树；元素 `role + name` 精确匹配 | 只打 API 证明不了「用户看得到/点得到」 |
| **状态回读** | 同一时刻 `GET /api/...` 的字段、`seed.json` 的对话/token，或 `state/whiteboard.json` 等文件 | 只截图证明不了「数据真的变了」 |
| **PNG 截图** | 真窗口/托盘区域 `screencapture -x -R`，或 headless 渲染帧 | 人复核的最终依据 |

只有两件 ⇒ 记 `evidence_partial`，**不得判 pass**。证据里不写 token、cookie、消息正文（正文只存 sha256 与长度）。

## 四条车道

| 车道 | 什么时候用 | 命令 |
| --- | --- | --- |
| headless | 默认；真实 `app/` 视图代码 + 交互状态机，无需窗口权限 | `verify --journey <id>` |
| window | 要证明「用户真的点得到」；同一 journey 在真窗口里按 AX `role+name` 驱动 | `verify --journey <id> --lane window` |
| execute | journey 需要真实 dispatch（目前只有 F-04）：本地替身模型跑完一轮，不耗真实额度 | 由 journey 的 `seed` 自动选择 |
| surface | 窗口看不到的 shell surface（目前只有 F-15 托盘）：只读并打开未命名托盘根 | 由 journey 的 `surface` 自动选择 |

`verify --all` 会按每个 journey 声明的实例/车道分组：view 实例跑普通页面，execute 实例跑 F-04，surface 在预览到 `menu-bar-extras` 的 journey 上自动启用。

## 全部 feature

| ID | 功能 | 页面 / 入口 | 默认 journey | 覆盖 |
| --- | --- | --- | --- | --- |
| [F-01](F-01-launch-and-readiness.md) | 启动与就绪 | CLI：`launch` / `doctor` / `status` / `cleanup` | CLI 自检 | daemon + API |
| [F-02](F-02-module-navigation.md) | 模块导航（侧栏 7 项） | 轨迹 / 洞察 / 编队 / 供应商 / 资源 / 装配 / 设置 | `F-02-nav` | headless + window |
| [F-03](F-03-conversations-list.md) | 会话列表与切换 | 左栏 main agent 卡片 + 会话行 | `F-03-conversations` | headless + window |
| [F-04](F-04-conversation-rendering.md) | 对话流渲染 | 中栏消息流（真实一轮对话） | `F-04-conversation` | execute + window |
| [F-05](F-05-composer.md) | 输入区（composer） | `消息` / `附件` / `模型` / `暂停` | `F-05-composer` | headless + window |
| [F-06](F-06-context-window.md) | 上下文窗口三页签 | `上下文` / `System Prompt` / `工具声明` | `F-06` | headless + window |
| [F-07](F-07-board-layout.md) | 白板布局与面板管理 | 页签栏、`在新标签页打开` / `移除` | `F-07` | headless + window |
| [F-08](F-08-trajectory-page.md) | 轨迹页（12 个量化面板） | 侧栏「轨迹」 | `F-08` | headless + window |
| [F-09](F-09-insights-page.md) | 洞察页 | 侧栏「洞察」 | `F-09` | headless + window |
| [F-10](F-10-fleet-page.md) | 编队页 | 侧栏「编队」 | `F-10` | headless + window |
| [F-11](F-11-providers-page.md) | 供应商页（Magpie 只读） | 侧栏「供应商」 | `F-11` | headless + window |
| [F-12](F-12-resources-page.md) | 资源（能力）页 | 侧栏「资源」 | `F-12` | headless + window |
| [F-13](F-13-assemblies-page.md) | 装配页 | 侧栏「装配」 | `F-13` | headless + window |
| [F-14](F-14-settings-page.md) | 设置页（配置读写） | 侧栏「设置」 | `F-14` | headless + window |
| [F-15](F-15-tray-and-notifications.md) | 托盘与系统通知 | 菜单栏 Graph 图标 | `F-15-tray` | surface |
| [F-16](F-16-empty-and-error-states.md) | 空态与错误态 | 任意页面（空数据） | `F-16-empty-and-error` | headless + window |

另有 8 条 shell/rail 级 journey：`shell-workspace` 与 `rail-insights|fleet|providers|capabilities|assemblies|settings|trajectory`，
逐页验证「点侧栏 → 页签与面板真的换了 → daemon 数据可读」。它们与上表共用同一套证据格式。

面板种类全表（`app/board_layout.go:boardPanelTitle`，37 个 kind）里**尚未单独立 feature** 的，见 `index.json` 的 `uncoveredPanels`：它们是「已被某个页面覆盖、但还没有自己的断言」的增量清单，不是「不用验」。每条 feature 文件里也明确写了哪些子功能还没进 journey、为什么。

## 怎么用（三种典型请求）

**1. 「这个功能还能用吗？」**

```sh
cd verification
./verify-graph doctor                                  # 先看这台机器值不值得驱动
./verify-graph verify --journey F-09                   # 只跑这一条
./verify-graph verify --journey F-09 --lane window     # 同一路径，真窗口里点一遍
./verify-graph evidence verify --run <run>             # 复核证据没有被改过
```

**2. 「我把整页都过一遍」**

```sh
cd verification
./verify-graph verify --all                    # 默认：headless + execute(F-04) + surface(F-15)
./verify-graph verify --all --lane window      # 全部换真窗口驱动
```

**3. 「我要自己点一步」**

```sh
cd verification
./verify-graph launch --run manual
./verify-graph ui click --run manual --name 洞察 --expect 洞察概览
./verify-graph ui expect --run manual --name 洞察概览 --role group
./verify-graph ui screenshot --run manual --out evidence/manual/insights.png
./verify-graph cleanup --run manual
```

失败时看信封的 `data.failures[]`：每条都有 `journey`、`feature`、`failedSteps[]`（index/verb/expected/actual）、`failedChecks[]`、`evidence` 与可执行的 `nextCommand`；`error.hint` 也给出复跑命令。

## 写新 feature 的规则

1. 文件命名 `F-<两位序号>-<kebab-slug>.md`，登记到 `index.json`（`features[]` 与 `uncoveredPanels` 同步更新）。
2. 四个 H2 固定：`Sub-features`、`How to get to it (user POV)`、`Driving it with verify-graph`、`Gotchas`（顺序不变，缺一节 map 就不完整）。
3. 「判过」必须写成可执行断言（元素 `role+name`、API 字段、文件摘要），不写「看起来正常」；**没进 journey 的子功能要明说未覆盖及原因**。
4. `Gotchas` 只写**真踩过的**：默认超时、`find --text` 命中正文、隔离实例没有数据、写操作会落到用户数据、托盘同名实例等。
5. 先有会失败的一次运行，再写「怎么让它过」——没跑过的 feature 文件是草稿，不是覆盖。
