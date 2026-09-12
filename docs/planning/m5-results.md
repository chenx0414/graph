# M5 本机 Web 与运行观测

日期：2026-09-12。对应 [实施计划 G14–G15](../implementation-plan.md#m5-本机-web-与运行观测)。基于 M4 的提交 `2da2765`。本轮把 Task Runtime 接到本机 HTTP/SSE 与 React 界面：设置、对话、确认、队列、问题、自动布局任务图、人才库和节点详情。

## 可运行结果

```sh
pnpm test:m5
pnpm build:web
pnpm check
```

最终复验中 `pnpm check` 通过：TypeScript 检查及 22 个文件、101 项测试，其中 M0 27 项、M1 22 项、M2 27 项、M3 8 项、M4 9 项、M5 8 项。`git diff --check` 无格式错误。HTTP 测试使用 Fastify inject；界面测试用 Playwright Chromium 打开真实本机页面。不读取项目 `.env`，不调用收费模型。

## 入口

- `createApp(runtime, { origin, webDir })`：本机 HTTP。只暴露用户命令；无主管提案路由。
- `openGraphServer({ autoDrive, webDir, ... })`：监听 `127.0.0.1`，可选后台 `drive` 循环。
- Cookie `graph_session` + 本机 Origin 检查。跨源与无会话请求不能走用户答复通道。
- `GET /api/tasks/:id/events?after=` 按游标续接；`GET /api/tasks/:id/events/stream` 为 SSE。
- `GET /api/tasks/:id/graph` 返回节点、容器、回边、图修订和 elkjs 布局。
- `GET /api/tasks/:id/operations?limit=` 分页读取操作日志。

## G14

| 出口 | 证据 |
| --- | --- |
| 设置、对话、确认、队列 | `tests/m5/http.test.ts` 经 HTTP begin/say/accept/list；`tests/m5/ui.test.ts` 页面有设置与队列 |
| 暂停显示 pausing/paused | HTTP 在途操作时 `status` 为 `pausing`，结束后为 `paused` |
| 答复一题不清除其他阻塞 | 两个 `waiting` 问题，答复一个后仍有未关闭问题 |
| 关闭浏览器后台继续，游标重开 | 先读事件再 accept/drive，再用 `after` 续接看到 `task.accepted` 且任务完成 |
| 主管不能伪造用户答复 | 无 `/api/supervisor`；跨源与无 Cookie 被拒绝 |

## G15

| 出口 | 证据 |
| --- | --- |
| 全部模板及回边可呈现 | `layoutGraph` 覆盖八种模板，回边进入 layout edges |
| 子图与自动布局 | 路由模板的容器出现在 graph payload 与布局坐标 |
| 不提供手工改图 | 界面 `data-editable="false"`，React Flow `nodesDraggable/nodesConnectable=false` |
| 节点详情、token/费用 | 点击节点显示详情；view/graph 含 `cost` |
| 未知费用显示未知 | `view.cost.unknown` 时界面文案为「未知」（用量来自 M3 invocation） |
| 人才库 | `/api/catalog` 与目录页列出已发布定义 |
| 查看大日志不阻塞调度 | 操作日志 SQL `LIMIT`；读路径不持有写事务 |

## 本轮边界

未做收费模型请求。本机 Web 绑定 `127.0.0.1`/`localhost`，不是可部署的多用户服务。后台 `autoDrive` 为短轮询 `host.drive()`。elkjs 在服务端布局，浏览器只渲染。对话页展示用户消息与提案摘要；主管完整会话正文仍在实例记录中按需展开。Playwright 需要本机 Chromium。机制故障注入仍是 M6。
