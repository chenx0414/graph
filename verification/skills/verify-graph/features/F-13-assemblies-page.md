# F-13 装配页（能力组合编译）

把资源装配成 Agent 角色并编译成 definition：这是「一个新 Agent 类型从哪来」的唯一界面。

- 入口：侧栏「装配」（`railItems[5]`，kind=`assemblies`）
- 数据源：`GET /api/catalog`、`POST /api/catalog/combinations`、`POST /api/catalog/combinations/{id}/compile`、`POST /api/catalog/combinations/{id}/description`、`DELETE /api/catalog/combinations/{id}`
- 现有自动化覆盖：`app/assemblies*_test.go`

## Sub-features

- 列表：`装配 <name>` 行；空态 `还没有装配。`
- 新建：选择资源 → 保存组合（`POST /combinations`）→ 列表出现新行。
- 编译：`compile` 成功返回 definition → 行上显示可被节点引用。
- 描述：保存描述后回读一致。
- 删除：`DELETE` 后行消失（带确认）。

## How to get to it (user POV)

点侧栏第六个图标「装配」→ 看到已有装配列表 → 选资源点保存 → 点编译拿到 definition。

## Driving it with verify-graph

```sh
verification/verify-graph ui click --label "装配" --json
verification/verify-graph api --run <run> --get /api/catalog --save evidence/<run>/F-13/catalog.json
verification/verify-graph ui expect --text "把资源库里的技能、指令、MCP 与 Pi 扩展装配成 Agent 角色" --json
verification/verify-graph ui screenshot --out evidence/<run>/F-13/assemblies.png
```

判过：`装配 <name>` 行数 = `/api/catalog` 里 combinations 数；空态时 `还没有装配。` 存在。新建/编译属写操作，只在隔离实例上跑，且断言 `GET /api/catalog` 回读出现新 id。

## Gotchas

- 写操作会落到 `<graph-home>` 的 catalog：用户实例上**不要**点新建/删除。
- 编译失败信息是给 Agent 看的（缺资源/版本冲突）：失败时断言「错误文案非空且指出缺什么」，不要只判 ok=false。
- 两处 `共享产物`/`能力装配` 标题可能同时存在于页签与面板：定位用 `group` 名而不是文本包含。
