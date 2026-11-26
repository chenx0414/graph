<!-- graph:allow-prose: machine acceptance record for the six-rail AX run; the table is the evidence, the sentences only say what was driven -->
# 侧栏六个模块：真窗口 AX 驱动（2026-11-26）

`agent-desktop` 的 accessibility 与 screen_recording 均为 `granted`，所以这一轮是**真窗口**点击，
不是 headless 渲染。窗口 `w-56440`（1598×928 @ 234,30），进程 pid 60240，
从 `/Applications/Graph.app` 运行（`dev.graph.console@0.2.0`，`codesign --verify --strict` 通过，
二进制 14:35:56；窗口 14:38:47 / daemon 60261 14:38:50，都晚于构建）。

每一步都是 `click` 侧栏按钮 → 再 snapshot，读该页**自己的**面板名，然后整屏截图并按窗口 bounds
裁成 1598×928。判定依据是快照里的 panel 名，不是截图印象。

| 侧栏按钮 | 点开后该页的面板（快照实测） | 截图 |
| --- | --- | --- |
| 轨迹 | 上下文统计窗口 · Token 统计窗口 · 耗时统计窗口 · 上下文趋势窗口 · 上下文事件窗口 · 命令执行窗口 · 文件活动窗口 · Token 组成窗口 · 请求浏览窗口 · Agent 网络窗口 · 请求详情窗口 | `01-trajectory.png` |
| 编队 | 编队总览窗口 · Agent 网络窗口 · 跨 Agent 协作窗口 · 事件检查窗口 · 共享产物窗口 | `02-fleet.png` |
| 供应商 | 返回加入配置 · 管理供应商 · 扩展自动更新 | `03-providers.png` |
| 资源 | 资源库（页签 资源库 + 资源分类） | `04-resources.png` |
| 装配 | 能力装配（页签 能力装配 + 打开装配文件） | `05-assemblies.png` |
| 设置 | 管理供应商 · 打开 扩展自动更新 · 恢复 各项目 · 归档 会话 | `06-settings.png` |

六个模块各自开出自己的页签，八条页签并存（白板/编队/供应商/资源库/能力装配/运行设置/轨迹量化/当前上下文），
说明点侧栏是切换面板而不是重画同一页。

两次点击的 `disposition.delivery` 都是 `delivered_unverified`（AXPress 成功，但工具侧不声明已核实），
所以上面的面板名来自点击之后的独立 snapshot —— 那才是判据。

复跑方式（不重装、不重启）：

```sh
agent-desktop snapshot --app Graph --include-bounds --skeleton   # 取窗口 bounds 与六个按钮
agent-desktop click '<ref of 轨迹>' && agent-desktop snapshot --app Graph -i
agent-desktop screenshot --screen 0 /tmp/rail.png && sips -c 928 1598 --cropOffset 30 234 /tmp/rail.png
```
