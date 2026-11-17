# F-11 供应商页（Magpie 只读视图）

「供应商」页展示 Magpie 管的供应商与账号、以及每个供应商下可用模型；它**只读**，写操作在 Magpie 里。

- 入口：侧栏「供应商」（`railItems[3]`，kind=`providers`）
- 数据源：`GET /api/providers/magpie`、`GET /api/providers`、`POST /api/providers/disconnect`、`GET /api/providers/login/{id}`（登录流程）
- 现有自动化覆盖：`app/providers_page_test.go`

## Sub-features

- 列表：每个供应商一行，行内模型数与 `/api/providers/magpie` 一致。
- 面包屑/文案：`模型 / 供应商`、`供应商与账号都由 Magpie 管理 · 这里只读`。
- 搜索：`查找供应商` 输入框过滤行。
- Magpie 状态：`Magpie <状态>` 文本；Magpie 不可用时显示 `读不到供应商：<原因>` + `重试供应商` 按钮（错误态可点重试）。
- 断开：`POST /api/providers/disconnect` 后该行变为未连接（**只读验证不执行**，除非用替身实例）。

## How to get to it (user POV)

点侧栏第四个图标「供应商」→ 看到供应商列表与模型数 → 在搜索框输入过滤。

## Driving it with verify-graph

```sh
verification/verify-graph ui click --label "供应商" --json
verification/verify-graph api --run <run> --get /api/providers/magpie --save evidence/<run>/F-11/magpie.json
verification/verify-graph ui expect --text "供应商与账号都由 Magpie 管理" --json
verification/verify-graph ui type --label "查找供应商" --text "deepseek" --json
verification/verify-graph ui screenshot --out evidence/<run>/F-11/providers.png
```

判过：行数 = API 供应商数（或错误态文案存在）；搜索后可见行数 = 名称含关键字的 API 行数。

## Gotchas

- Magpie 是外部状态：隔离实例读不到时是**正确**的错误态，判据取「`读不到供应商` + `重试供应商` 存在」。
- 这一页会显示凭据引用名（不是密钥），证据里仍只存 sha256/数量。
- `断开` 会改真实连接状态：没有替身实例时**禁止**在用户实例上点。
