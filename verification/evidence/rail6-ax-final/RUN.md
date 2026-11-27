<!-- graph:allow-prose: machine acceptance record for the six-rail AX run; the table is the evidence, the sentences only say what was driven -->
# 侧栏六个模块：真窗口 AX 驱动（2026-11-27，稳定签名包）

`desktop permissions` 从 Graph 宿主实测：`accessibility: granted`、`screen_recording: granted`。
所以这一轮是**真窗口**点击，不是 headless 渲染。窗口 `w-56790`（1598×928 @ 234,30），
进程 pid 77039，运行 `/Applications/Graph.app`（`Authority=Graph Self-Signed`，
`Identifier=dev.graph.console`，`codesign --verify --strict --deep` 通过，二进制 11:41）。

每一步都是 `click` 侧栏按钮 → 再 snapshot，读该页**自己的**面板名，然后整屏截图并按窗口
bounds 裁成 1598×928。判定依据是快照里的 panel 名，不是截图印象。

| 侧栏按钮 | 点开后该页的面板（快照实测） | 截图 |
| --- | --- | --- |
| 轨迹 | 上下文统计窗口 · Token 统计窗口 · 当前上下文窗口 · 耗时统计窗口 · 上下文趋势窗口 · 上下文事件窗口 · 命令执行窗口 · 文件活动窗口 · Token 组成窗口 · 请求浏览窗口 · Agent 网络窗口 · 请求详情窗口（12 个） | `01-trajectory.png` |
| 编队 | 编队总览窗口 · Agent 网络窗口 · 跨 Agent 协作窗口 · 事件检查窗口 · 共享产物窗口（5 个） | `02-fleet.png` |
| 供应商 | 查找供应商（textfield）· 刷新供应商 · 编辑 command-goat 订阅 · 编辑 opencode-go-小宝宝 · 编辑 grok 订阅 · 添加供应商 · 打开 Magpie 配置 · 用 … 的模型（9 个） | `03-providers.png` |
| 资源 | 打开资源库文件夹 · 刷新资源库 · 查找资源（textfield）· 分类 全部/技能/指令/MCP 服务器/Pi 扩展 · 112 个 `资源 …` 行 | `04-resources.png` |
| 装配 | 打开装配文件 · 刷新 · 装配 Alice_reviewer · 装配 Vera_synthesizer · 装配 Bob_coder · 装配 Atlas_main | `05-assemblies.png` |
| 设置 | 管理供应商 · 打开 扩展自动更新 · 恢复 03-xiaohongshu-obsidian-clipper / 00-项目模板 / 14-性格探索屋 / 13-Graph / durable-matt-acceptance-20261013 / 99-测试沙盒 · 归档 18-xhs-to-md · 归档 19-xhs-mini-tools | `06-settings.png` |

八个页签在整个过程里始终并存（白板/编队/供应商/资源库/能力装配/运行设置/轨迹量化/当前上下文），
说明点侧栏是**切换面板**而不是重画同一页。

三次点击的 `disposition.delivery` 都是 `delivered_unverified`（AXPress 成功，但工具侧不声明已核实），
所以上面的面板名来自点击之后的独立 snapshot —— 那才是判据。

`--wait-for` 实测到的面板出现耗时：编队 `group:编队总览窗口` 194ms、资源 `textfield:查找资源` 268ms、
设置 `button:扩展自动更新` 292ms。轨迹与装配用全程 `-i` 快照读取，未用等待。

复跑方式（不重装、不重启）：

```sh
agent-desktop permissions
agent-desktop snapshot --app Graph --skeleton                    # 取六个侧栏按钮与窗口 bounds
agent-desktop click '<ref of 轨迹>' && agent-desktop snapshot --app Graph --skeleton
agent-desktop screenshot --screen 0 /tmp/rail.png && sips -c 928 1598 --cropOffset 30 234 /tmp/rail.png
```
