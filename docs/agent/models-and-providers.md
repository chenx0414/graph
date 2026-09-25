# Graph 模型与厂商配置

**何时读**：用户要求配置模型厂商、订阅凭据、新增或调整模型及其参数，或某个模型不可用需要排查时。
**性质**：本文是行为契约（字段、校验、守卫、生效语义均以当前代码为准）。实时状态必须用 `/api/settings`、`/api/config`、`/api/limits` 与 `read_system_capabilities` 确认，不要凭本文推测。

---

## 一次配置的完整动作

配置模型不是「改一个文件」，而是**改文档 + 提交 + 验证**三步。唯一受支持的热路径是 HTTP 接口。

### 1. 找到守护进程的 loopback 端口

端口是随机的（桌面 App 用 `--port 0` 让守护进程自选），**每次重启都可能不同（实测同一份配置在不同重载后为 65427 与 56914），不要缓存上一次的端口**。`lsof` / `netstat` 在受限环境里可能**没有任何输出**，用健康检查探测最可靠：`/api/health` 免鉴权，Graph 返回 `{"ok":true}`。

```bash
# 逐个探测本机监听端口，找返回 {"ok":true} 的那个
for p in $(seq 1024 65535); do
  [ "$(curl -s -m 1 http://127.0.0.1:$p/api/health)" = '{"ok":true}' ] && echo "Graph on $p" && break
done
```

### 2. 取会话 cookie（`GET /` 唯一发放点）

```bash
curl -s -c /tmp/graph-cookie.txt -o /dev/null http://127.0.0.1:<port>/
```

### 3. 读当前配置与 revision

```bash
curl -s -b /tmp/graph-cookie.txt http://127.0.0.1:<port>/api/config
```

返回 `{ revision, effectiveRevision, configured, config }`。`config` 就是磁盘上的配置文档（`version: 1`）。

### 4. 改文档并提交（**必须带本地 Origin**）

```bash
curl -s -b /tmp/graph-cookie.txt \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:<port>' \
  -X POST -d '{"expectedRevision":<revision>,"document":{...}}' \
  http://127.0.0.1:<port>/api/config
```

- `expectedRevision` 必须是刚读到的 revision（乐观锁）。
- 成功返回 `{ revision, effectiveRevision, applied: true, configured, modelCount, enabledModelCount, restartRequired: false }`；**候选被拒绝时不写盘**，返回 `applied: false` 与 `reason` —— 那是真实结论，不要当作失败乱重试，先按 `reason` 修文档。

### 5. 验证新模型真的可用

```bash
curl -s -b /tmp/graph-cookie.txt -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:<port>' -X POST \
  -d '{"modelId":"<新模型 id>"}' http://127.0.0.1:<port>/api/config/test
```

`/api/config/test` 对已配置模型发起一次真实调用。**不要**只看 `applied: true` 就宣布成功。

---

## 事实（字段、校验、守卫）

### 配置文件

- 位置：应用根目录下的 `graph.config.json`（桌面 App 为 `~/Library/Application Support/Graph/graph.config.json`）。
- 顶层：`version: 1`、`revision`（每次保存 +1）、`projects`、`models`、`credentials`、`limits`、`access`。
- **密钥永不出现在这个文件里**：只存 `secretRef`（一个环境变量名）。

### `credentials.<id>`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `secretRef` | 是 | 环境变量名（`^[A-Za-z_][A-Za-z0-9_]*$`），**不是密钥本身** |
| `displayName` | 否 | 界面显示名 |
| `sharedLimitGroupId` | 否 | 额度分组；两个凭据解析到**同一个密钥值**时必须同组，否则校验失败 |

### `models.entries[]`

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 本配置内的唯一标识（Graph 侧身份） |
| `provider` | 是 | 厂商/平台名（用于展示与分组） |
| `grade` | 是 | `low` / `medium` / `high` / `highest` |
| `api` | 是 | `openai-completions` 或 `anthropic-messages` |
| `baseUrl` | 是 | 端点基址 |
| `contextWindow` | 是 | 正整数 |
| `maxTokens` | 是 | 正整数 |
| `credentialId` | 是 | 必须指向已存在的 `credentials.<id>` |
| `input` | 否 | `["text"]` 或 `["text","image"]`；**必须含 `text`**，不得重复 |
| `reasoning` | 否 | 布尔，默认 `true` |
| `defaultThinkingLevel` | 否 | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `modelId` | 否 | 上游真实模型 id（与配置 id 不同时） |
| `cost` / `pricing` | 否 | 费用与价格表（影响预算与用量展示） |
| `headers` | 否 | 该模型额外请求头 |

`models.preferences`：按 grade 给出模型优先顺序（`Partial<Record<grade, string[]>>`）。
`limits`：`credentials.<id>` 逐凭据 token 上限、`sharedGroups`、`defaultBudgetTokens`（`null` = 不限）。

### 守卫（会拒绝你的保存）

| 现象 | 含义 |
| --- | --- |
| `forbidden_origin`（403） | **非 GET/HEAD** 的 `/api/*` 请求必须带本地 `Origin`（`127.0.0.1` / `localhost`）；这是 CSRF 守卫，不是权限没开 |
| `unauthorized`（401） | 缺 `graph_session` cookie（先 `GET /`） |
| `config_conflict` | `expectedRevision` 与当前不符；重新读 revision 再改 |
| `config_locked` | 另一个编辑器（App 窗口）正在保存；稍后重试 |
| `config_in_use` | 删除的模型仍被未完成任务使用；先等任务结束或换模型 |
| 凭据组错误 | 多个凭据解析到同一密钥值却分属不同 `sharedLimitGroupId` |

### 生效语义

- **`POST /api/config` 是热生效路径**：以磁盘原子替换 + revision 前移生效，响应里 `restartRequired: false`。
- **没有配置文件 watcher**：直接改 `graph.config.json` **不会**热生效，只有重启守护进程才会被读到（且绕过上面全部守卫与候选校验）。
- `applied: false` 的候选不会落盘，也不会改变生效版本。

---

## 已知厂商 preset（写实）

`id` / `label` / `baseUrl` / 凭据变量名 / 种类 / 模型列表探测，均为仓库内置声明：

| id | label | api | baseUrl | credentialRef（环境变量名） | 种类 | 探测模型列表 |
| --- | --- | --- | --- | --- | --- | --- |
| `opencode-go` | OpenCode Go | openai-completions | `https://opencode.ai/zen/go/v1` | `GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY` | 订阅 | 是 |
| `command-goat` | Command Goat | openai-completions | `https://api.commandcode.ai/provider/v1` | `GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY` | 订阅 | 是 |
| `grok` | Grok | openai-completions | `https://api.x.ai/v1` | `GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN` | 订阅 | 是 |
| `chatgpt` | ChatGPT | openai-completions | `https://chatgpt.com/backend-api/codex` | `GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN` | 订阅 | 是 |
| `deepseek` | DeepSeek | openai-completions | `https://api.deepseek.com/v1` | `GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY` | API KEY | 是 |
| `custom` | 自定义 | openai-completions | 自填 | `GRAPH_PROVIDER_API_KEY` | API KEY | 是 |

**凭据获取方式（写实，含未声明项）**

- `deepseek`：官方 API KEY，文档 `https://api-docs.deepseek.com/`。
- `opencode-go`：OpenCode Zen 订阅凭据，文档 `https://opencode.ai/docs/zen`；所有请求自动附带 `x-opencode-session: graph-console`。
- `chatgpt`：ChatGPT/Codex 订阅访问令牌。用量适配器从 **Codex CLI 的登录文件** `~/.codex/auth.json` 读取 `tokens.access_token`（可用 `GRAPH_CODEX_AUTH_PATH` 覆盖路径）。
- `grok`：xAI 访问令牌。用量适配器从 `~/.grok/auth.json` 读取（可用 `GRAPH_GROK_AUTH_PATH` 覆盖）。
- `command-goat`：commandcode.ai 订阅凭据；**仓库未声明官方文档链接**，不要编造获取步骤，需要时让用户提供或查询其服务台。
- `custom`：用户自填「厂商名 + Base URL + 兼容格式 + API KEY」；端点不支持列模型时手动添加模型 id。
- 环境变量别名（配置 `secretRef` 之外的兜底名，代码内已声明）：`OPENCODE_GO_API_KEY` / `OPENCODE_ZEN_API_KEY` / `OPENCODE_API_KEY`；OpenCode 的本地配置 `~/.config/opencode/opencode.json` 也会被识别。

**注意**：`chatgpt` 后端按 Responses 形状返回，而 preset 按 Chat Completions 契约注册与探测 —— 正式调用前用 `/api/config/test` 实测，不要假定一定可用。

---

## 密钥怎么进入运行时

- 运行时看到的密钥是**合并视图**：进程环境 + App/钥匙串推送 − 显式撤销（`<stateDir>/revoked-secrets.json` 跨重启保留）。
- App 桥接口（仅安装 App 桥的守护进程提供）：
  `POST /api/app/secret`，头必须带 `x-graph-app-token`（值从 `<stateDir>/app-token` 读取，权限 0600），体 `{ "ref": "<环境变量名>", "value": "<密钥>" }`；`value: null` 表示**撤销**该密钥。缺令牌返回 403。
  该接口**只改变当前守护进程的视图**：推送的值不会写进钥匙串，守护进程重启后失效。要持久化，必须由用户在 App 窗口保存（钥匙串由桌面端 `safeStorage` 管理；`secrets.json` 由桌面端读写，守护进程不碰）。
- 因此：**可以**用 App 桥临时注入密钥完成一次配置与验证；**不可以**声称"已永久保存"，除非用户已在 App 窗口保存。

---

## 经验（非契约，来自实践；与上文字段规则冲突时以上文为准）

- `grade` 是**用途档位**而不是能力排序：`highest` 留给需要长链推理的规划/审查，`high` 用于实现，`medium` 用于常规改动，`low` 用于机械批量活。
- `contextWindow` / `maxTokens` 必须与上游**真实能力**一致，宁小勿大：写大了不会让模型变强，只会让上下文预算判断失真。
- `defaultThinkingLevel` 只在模型确实支持时才写高；不确定就用 `reasoning: true` + 低档，交由调用方按任务覆盖。
- 订阅类凭据会更替/过期：出现 401/403 时先按「`/api/config` 里的 `configured` 字段 → 合并视图里是否真有该变量名 → 令牌是否过期」的顺序排查，不要先去动模型条目。
- 同一上游模型挂多个入口时，用不同 `id` + 相同 `modelId`，并给它们同一个 `sharedLimitGroupId`，预算才不会被重复计算。
- 新增模型时先只加一个、`/api/config/test` 通过再加第二个；一次改多个会让"是哪一个坏了"难以判断。

## 改配置时的自检清单

1. 用 `/api/config` 读到**最新** revision，不是记忆里的值。
2. `credentialId` 在 `credentials` 里存在；新凭据的 `secretRef` 名字与运行时合并视图里的变量名一致。
3. 写请求带本地 `Origin`；cookie 是刚 `GET /` 拿的。
4. `applied: true` **且** `/api/config/test` 通过，才算成功。
5. 删模型前确认没有未完成任务在用（否则 `config_in_use`）。

## 不要宣称

- 不要声称改过 `graph.config.json` 文件就等于配置已生效（没有 watcher）。
- 不要把 `applied: true` 当作模型可用。
- 不要声称已经永久保存了密钥（除非用户已在 App 窗口保存）。
- 不要为 `command-goat` 之类仓库未声明文档的厂商编造凭据获取步骤。
