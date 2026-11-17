# F-14 设置页（运行设置 / 配置读写）

「设置」页是唯一能看见并修改 `graph.config.json`（项目、模型、限额、启动信息）的界面。

- 入口：侧栏「设置」（`railItems[6]`，kind=`settings`）
- 数据源：`GET /api/settings`、`GET /api/startup`、`GET /api/config`、`POST /api/config`、`POST /api/config/test`、`GET /api/limits`
- 现有自动化覆盖：`app/settings*_test.go`（`settings.go` 相关）

## Sub-features

- 启动信息：模式（view/execute）、模型数、源码 root/commit/dirty（`/api/startup`）。
- 配置读写：`GET /api/config` → 改一项 → `POST /api/config` → 回读一致、`revision` 递增。
- 限额：`/api/limits` 的并发/执行上限显示。
- 扩展开关：`打开 扩展自动更新`。
- 凭据说明文案：`凭据在「供应商」页管理 · 与 magpie 同一套`。

## How to get to it (user POV)

点侧栏第七个图标「设置」→ 改一项配置 → 保存 → 关窗重开仍是新值。

## Driving it with verify-graph

```sh
verification/verify-graph ui click --label "设置" --json
verification/verify-graph api --run <run> --get /api/config --save evidence/<run>/F-14/config.before.json
verification/verify-graph api --run <run> --post /api/config --body evidence/<run>/F-14/config.patch.json --save evidence/<run>/F-14/config.after.json
verification/verify-graph ui expect --text "凭据在「供应商」页管理" --json
verification/verify-graph ui screenshot --out evidence/<run>/F-14/settings.png
```

判过：POST 后 `GET /api/config` 的 `revision` 严格递增且目标字段变成新值；界面显示的值与回读一致（双证据）。

## Gotchas

- `POST /api/config` 会真的写 `<config>`：只在隔离实例的 `.run/<run>/graph.config.json` 上做；用户 config 绝不写。
- 保存后 daemon 会「应用配置」并可能重启子能力（日志出现 `Configuration file applied`）：断言前先轮询 `/api/startup.effectiveRevision`，不要 sleep。
- `/api/settings` 返回 60KB+ 的大 JSON：证据里只存 sha256 与抽取字段，不整份入库。
