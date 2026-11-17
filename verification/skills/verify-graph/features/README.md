# Graph Feature Map

这是 Graph 用户可见功能的验证地图。**任何一个功能「现在到底是不是真的能用」，从这里开始找，不要临时写脚本。**

- 唯一入口：`verification/verify-graph <command>`（见 [`../../SKILL.md`](../SKILL.md)）
- 机器可读索引：本目录 [`index.json`](index.json)（每条 feature 的页面、入口、命令、证据路径、覆盖的面板与 API）
- 证据根：`verification/evidence/<run>/<feature>/`（`cleanup` **不删**）
- 运行态根：`verification/.run/<run>/`（`cleanup` 删）

## 证明标准（缺一件就不算 pass）

每条 feature 的「能用」由三件套共同判定，写进 `evidence/<run>/<feature>/assertions.json`：

| 件 | 是什么 | 为什么不能省 |
| --- | --- | --- |
| **界面断言（AX）** | agent-desktop 快照里，该功能应出现的元素 `role + name` 精确匹配 | 只打 API 证明不了「用户点得到」 |
| **状态回读（API / 文件）** | 同一时刻 `GET /api/...` 的字段或 `state/whiteboard.json` 等文件 | 只截图证明不了「数据真的变了」 |
| **PNG 截图** | `/usr/sbin/screencapture -x`（或 `-R` 限定本窗口） | 人复核的最终依据 |

只有两件 ⇒ 记 `evidence_partial`，**不得判 pass**。证据里不写 token、cookie、消息正文（正文只存 sha256 与长度）。

## 全部 feature

| ID | 功能 | 页面 / 入口 | 驱动 | 优先级 |
| --- | --- | --- | --- | --- |
| [F-01](F-01-launch-and-readiness.md) | 启动与就绪 | CLI：`launch` / `doctor` / `status` / `cleanup` | daemon + API | P1 |
| [F-02](F-02-module-navigation.md) | 模块导航（侧栏 7 项） | 轨迹 / 洞察 / 编队 / 供应商 / 资源 / 装配 / 设置 | window | P1 |
| [F-03](F-03-conversations-list.md) | 会话列表与切换 | 左栏 main agent 卡片 + 会话行 | window + API | P1 |
| [F-04](F-04-conversation-rendering.md) | 对话流渲染与消息操作 | 中栏消息流、复制/赞/踩/朗读/更多 | window + API | P1 |
| [F-05](F-05-composer.md) | 输入区（composer） | `消息` / `附件` / `模型` / `暂停` | window | P1 |
| [F-06](F-06-context-window.md) | 上下文窗口三页签 | `上下文` / `System Prompt` / `工具声明` | window + API | P1 |
| [F-07](F-07-board-layout.md) | 白板布局与面板管理 | 页签栏、拖拽分区、`在新标签页打开` / `移除` | window + state | P1 |
| [F-08](F-08-trajectory-page.md) | 轨迹页（12 个量化面板） | 侧栏「轨迹」 | window + API | P1 |
| [F-09](F-09-insights-page.md) | 洞察页 | 侧栏「洞察」 | window + API | P1 |
| [F-10](F-10-fleet-page.md) | 编队页 | 侧栏「编队」 | window + API | P1 |
| [F-11](F-11-providers-page.md) | 供应商页（Magpie 只读） | 侧栏「供应商」 | window + API | P1 |
| [F-12](F-12-resources-page.md) | 资源（能力）页 | 侧栏「资源」 | window + API | P1 |
| [F-13](F-13-assemblies-page.md) | 装配页 | 侧栏「装配」 | window + API | P1 |
| [F-14](F-14-settings-page.md) | 设置页（配置读写） | 侧栏「设置」 | window + API | P1 |
| [F-15](F-15-tray-and-notifications.md) | 托盘与系统通知 | 菜单栏 Graph 图标 | window | P2 |
| [F-16](F-16-empty-and-error-states.md) | 空态与错误态 | 任意页面（停 daemon / 去 cookie / 空数据） | daemon + API + window | P1 |

面板种类全表（`app/board_layout.go:boardPanelTitle`，37 个 kind）里**尚未单独立 feature** 的，见 `index.json` 的 `uncoveredPanels`：它们是「已被某个页面覆盖、但还没有自己的断言」的增量清单，不是「不用验」。

## 怎么用（三种典型请求）

**1. 「这个功能还能用吗？」**

```sh
verification/verify-graph doctor                     # 先看实例值不值得驱动
verification/verify-graph verify F-02                # 只跑这一条 feature 的断言
verification/verify-graph evidence show <run> --feature F-02   # 看它凭什么这么判
```

**2. 「我把整页都过一遍」**

```sh
verification/verify-graph verify --all --profile smoke   # P1 feature 全跑，输出 counts/failed[]
```

**3. 「我要自己点一步」**

```sh
verification/verify-graph ui click --role button --label "洞察"
verification/verify-graph ui expect --name "洞察概览" --role group
verification/verify-graph ui screenshot --out evidence/<run>/manual/insights.png
```

失败时信封里的 `error.hint` 是可执行下一步（例：`launch with: verify-graph launch --ui`、`raise --timeout to 20000 and retry: agent-desktop list-windows timed out`），不是一句「失败了」。

## 写新 feature 的规则

1. 文件命名 `F-<两位序号>-<kebab-slug>.md`，登记到 `index.json`（`features[]` 与 `uncoveredPanels` 同步更新）。
2. 四个 H2 固定：`Sub-features`、`How to get to it (user POV)`、`Driving it with verify-graph`、`Gotchas`（顺序不变，缺一节 map 就不完整）。
3. 「判过」必须写成可执行断言（元素 `role+name`、API 字段、文件摘要），不写「看起来正常」。
4. `Gotchas` 只写**真踩过的**：默认超时会 `TIMEOUT`、`find --text` 命中正文、隔离实例没有数据、写操作会落到用户数据等。
5. 先有会失败的一次运行，再写「怎么让它过」——没跑过的 feature 文件是草稿，不是覆盖。
