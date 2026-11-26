<!-- graph:allow-prose: acceptance record for this round's rail check; the numbers are the evidence, the sentences say what was driven -->
# 侧栏六个模块（2026-11-26 真机）

运行：`verify-graph verify --run rail6 --journey F-02-nav` → `ok: true`，46/46 步。
实例：`/Applications/Graph.app`（dev.graph.console@0.2.0，`codesign --verify --strict` 通过），
窗口 60240 与 daemon 60261 均于 14:38 启动，晚于 14:35:50 的构建——跑的就是本次安装的代码。
lane：headless（产品自己的 `shellState.view`）；本机 accessibility 为 denied，AX 窗口 lane 不可用，
这正是 nightly 先跑 `doctor` 的原因。

| 侧栏标签 | 点开后出现的页签 | 步 |
| --- | --- | --- |
| 轨迹 | 标签页 轨迹量化 | 10–11 |
| 供应商 | 标签页 供应商 | 14–15 |
| 资源 | 标签页 资源库 | 16–17 |
| 装配 | 标签页 能力装配 | 18–19 |
| 设置 | 标签页 运行设置 | 20–21 |
| 编队 | 编队总览窗口 | 22–23 |

截图：`nav-trajectory.png`、`nav-fleet.png`（同目录）。
六个标签同时在渲染面上出现过（`texts` 含 轨迹/编队/供应商/资源/装配/设置）。
