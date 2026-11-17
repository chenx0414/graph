# F-12 资源（能力）页

「资源」页列出 Agent 可用的技能/指令/MCP/Pi 扩展，标出版本与缺失项，并能刷新目录。

- 入口：侧栏「资源」（`railItems[4]`，kind=`capabilities`）
- 数据源：`GET /api/catalog`、`POST /api/catalog/refresh`、`GET /api/catalog/pi-packages`、`GET /api/catalog/pi-extension-updates`、`GET /api/extensions/status`
- 现有自动化覆盖：`app/resources*_test.go`（存在同名测试文件时）

## Sub-features

- 面包屑与分类：`使用 / 资源库`、`分类 <名>` 按钮。
- 资源行：`资源 <name>`，显示 `v<version>` 或 `缺 <依赖>`。
- 缺失态：`缺 a、b` 文案（`resources_page.go:198`）——这行不完整依赖的唯一可见证据。
- 刷新目录：`POST /api/catalog/refresh` 后列表重新加载。
- 扩展开关：`展开 AGENT 中已有的全部资源`。

## How to get to it (user POV)

点侧栏第五个图标「资源」→ 看到分类与资源行 → 点分类过滤 → 顶部刷新重读目录。

## Driving it with verify-graph

```sh
verification/verify-graph ui click --label "资源" --json
verification/verify-graph api --run <run> --get /api/catalog --save evidence/<run>/F-12/catalog.json
verification/verify-graph ui expect --name "资源库" --json
verification/verify-graph ui screenshot --out evidence/<run>/F-12/resources.png
```

判过：`资源 <name>` 行集合 = `/api/catalog` 里 resources 的 name 集合（允许分类折叠时按分类逐个数）。

## Gotchas

- catalog 里可能有上百条：先把 AX 行数与该分类 API 数比，再抽查 3 条名字逐字相等，不要全量硬比（慢且脆）。
- 版本号来自磁盘上的 manifest：同一二进制在不同 `GRAPH_HOME` 下结果不同，隔离实例必须用自己 `.run/<run>/graph-home`。
- 缺失项文案含中文顿号 `、`：比较时归一化标点再比。
