# Graph Agent 配方（recipes）

**什么时候读**：需要新建、改描述、删除子 Agent 配方（recipe），或核对某个配方的编译结果时。**只是选择**已有子 Agent 用 `list_agent_combinations` / `get_agent_combination` 就够了，不必读本文件。

配方的增删改**不在工具表里**（这种低频能力已按奥卡姆剃刀下沉为文档）：它是一份 JSON + 几个控制台 HTTP 路由。每条路由都需要会话 cookie（`GET /` 取）与**本地 `Origin`**，否则 403 `forbidden_origin`。

## 怎么读

```bash
curl -s -b /tmp/graph-cookie.txt http://127.0.0.1:<port>/api/catalog
```

- `agentCombinations`：配方清单（含 `status` / `issues` / `resolved`）。
- `agentCombinationFile`：落盘位置（形如 `~/.graph/agent-combinations.json`）。
- `capabilities`：可用资源 id——`resources[].resourceId` 只能引用**已存在**的能力。

## 怎么写

```bash
# 新建或整体替换；注意 body 是 { combination: {...} } 对象，不是 JSON 字符串
curl -s -b /tmp/graph-cookie.txt -H 'content-type: application/json' -H 'origin: http://127.0.0.1:<port>' \
  -X POST http://127.0.0.1:<port>/api/catalog/combinations \
  -d '{"combination":{"id":"my-reviewer","name":"我的审查者","description":"…","recommendedGrade":"medium","review":true,"tags":["review"],"resources":[{"resourceId":"<capability-id>","role":"identity","required":true}]}}'

# 只改描述（立刻重新编译）
curl -s -b /tmp/graph-cookie.txt -H 'content-type: application/json' -H 'origin: http://127.0.0.1:<port>' \
  -X POST http://127.0.0.1:<port>/api/catalog/combinations/my-reviewer/description -d '{"description":"新的描述"}'

# 重新编译（改过 resources 之后）
curl -s -b /tmp/graph-cookie.txt -H 'content-type: application/json' -H 'origin: http://127.0.0.1:<port>' \
  -X POST http://127.0.0.1:<port>/api/catalog/combinations/my-reviewer/compile -d '{}'

# 删除：**不要**带 content-type: application/json（无 body 会被 Fastify 拒绝）
curl -s -b /tmp/graph-cookie.txt -H 'origin: http://127.0.0.1:<port>' \
  -X DELETE http://127.0.0.1:<port>/api/catalog/combinations/my-reviewer
```

## 事实（校验与语义）

- 必填：`id`、`name`、`description`、`recommendedGrade`（非空字符串，如 `low` / `medium` / `high`）；`resources[].resourceId` 必须指向已存在的能力，可带 `version`。
- `POST /api/catalog/combinations` 返回 `{ combination, definition }`；`definition.definitionVersion`（形如 `my-reviewer@1`）才是交给 `propose_graph` 的版本号，**每次保存或编译都会自增**。
- 删除配方**不会**删除它引用的能力；保存配方也**不会**创建能力或授予权限。
- `status !== 'valid'`（`issues[]` 非空）的配方不能用于派发。
- 环境实测（2026-09-25）：create → description → compile → delete 四次调用全部 200；DELETE 若带 `content-type: application/json` 且无 body 会 400 `FST_ERR_CTP_EMPTY_JSON_BODY`。

## 不要宣称

- 不要说「保存后新能力就有了」——能力必须先存在于资源库。
- 不要用 `save_agent_combination` / `update_agent_combination_description` / `delete_agent_combination` 这类工具名——它们已按奥卡姆剃刀移除，改用上面的 HTTP 路由。
