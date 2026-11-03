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

### 模型分层与历史等级

当前目录按 `small / medium / frontier` 分层。配置条目和配方的 recommendedGrade 可直接使用这些名称；同一字段仍接受历史 low/high/highest，不重写已有配置或已发布配方。

- small 对应 low；medium 保持原含义；frontier 包含 highest 与 high。
- 选模先匹配显式模型 ID（仍受独立审查排除约束），再按配置偏好与配方等级选择。新 frontier 配方依次匹配 frontier、highest、high；small 依次匹配 small、low。旧 high 配方仍先匹配 high，不自动扩大为 highest；旧 highest 仍先匹配 highest。新同组名称仅作为已有精确等级之后的别名候选。
- `/api/settings`、`/api/config` 和 read_system_capabilities 的模型视图公开派生 tier。tier 是只读分组，不保存到配置；grade 保留实际选择。设置页可按三层筛选，配置与配方选择器将新分层和历史等级分开显示。显示顺序或分组不改变新对话的默认模型顺序。
- main 通过 list_agent_combinations 的 grade 筛选配方；frontier 能找到历史 high/highest 配方。配置厂商和模型仍通过本文 HTTP 流程，无新增常驻配置工具。

### `credentials.<id>`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `secretRef` | 是 | 环境变量名（`^[A-Za-z_][A-Za-z0-9_]*$`），**不是密钥本身** |
| `displayName` | 否 | 界面显示名 |
| `platform` | 否 | 该凭据是**哪个订阅平台**的账户（如 `opencode-go`）。填了它，用量页就把它当成该平台的**独立账户**，用自己的密钥单独查额度、单独出一张卡 |
| `sharedLimitGroupId` | 否 | 额度分组；两个凭据解析到**同一个密钥值**时必须同组，否则校验失败 |

### 同一平台的多个账户

一个平台可以配多个账户（各自一把密钥），做法就是**多个 credential**：

```json
{
  "credentials": {
    "opencode-go":      { "secretRef": "GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY", "displayName": "主账户" },
    "opencode-go-work": { "platform": "opencode-go", "secretRef": "GRAPH_OPENCODE_WORK_KEY", "displayName": "工作账户" }
  },
  "models": { "entries": [{ "credentialId": "opencode-go-work", "...": "其余字段同下" }] }
}
```

- `platform` 是**显式声明**：没有它，用量服务只能从「哪些模型用了这份凭据」反推平台，因此**没有绑定任何模型的账户不会出现在用量页**。
- 用量页**每个账户一张卡**：平台自己的凭据（环境变量 / 厂商配置 / 模型反推）是第一张（id 仍是平台 id），每个带 `platform` 的账户各占一张（id 为 `<平台>#<凭据 id>`），summary 也按账户计数。
- 调度**不做隐式切换**：模型用哪个账户，由 `models.entries[].credentialId` 显式决定；本轮不按剩余额度自动改派。
- **一个 `provider` 标签只能挂一个 `credentialId`**（保存时守卫：`provider "X" must use one credentialId across its models`）。要让第二个账户能跑模型，就给它的模型条目一个**独立的 provider 标签**（例如 `opencode-go-3`）——只要 `baseUrl` 仍是 `opencode.ai/zen/go`，网关所需的 `x-opencode-session` 头会自动带上，无需手写 `headers`。
- **平台凭据必须能解析出值**，否则会出两种错：平台自己的模型停留在「未启用」，而且平台那张卡会被**某个账户顶替**（解析顺序是 `env` → 配置里的凭据 → CLI 配置；`configCredential` 取第一个「能解析出值」的匹配条目）。真实案例：`credentials.opencode-go.secretRef` 指向的变量不在守护进程环境里时，一个新加的账户条目会占住平台卡，看起来像「账户吞了平台」。
- 同一把密钥写进两个 credential 仍然要 `sharedLimitGroupId`（那是「别名」语义，与上面的「多账户」是两件相反的事，别混用）。
- 设置页「① 配置厂商」里，用**同一平台再加一个账户**按钮：它给新账户生成新的凭据 id 与环境变量名（`…_2`），所以不会覆盖已工作的那把密钥。

### `models.entries[]`

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 本配置内的唯一标识（Graph 侧身份） |
| `provider` | 是 | 厂商/平台名（用于展示与分组） |
| `grade` | 是 | `small` / `medium` / `frontier`；历史 `low` / `high` / `highest` 仍可用 |
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

- **两条路都会热生效**：①`POST /api/config`（原子替换磁盘 + revision 前移，响应 `restartRequired: false`）；②**直接改文件**——守护进程在监听它，改动会被读入并生效，不必重启。
- **改文件时由「内容」决定是否变化，不由 `revision`**：手改一般不会去动那个数字，所以 `revision` 只是并发保存的乐观锁，不参与「有没有变化」的判断；守护进程自己保存后 watcher 会看到同一份内容并**忽略**（不会重复生效）。
- 手改的文档若解析或校验失败，**上一份配置继续生效**，并被记录原因（见下）。
- `applied: false` 的候选不会落盘，也不会改变生效版本。
- **`GET /api/config` 会汇报**：`watch`（`watching` / `events` / `applied` / `ignored` / `lastReason` / `fileRevision`）与 `pendingSecretRefs`（见下）。改完文件后，用这两个字段确认你的改动真的生效了，而不是假定。

---

## 服务商选择与浏览器授权

服务商目录、模型字段与密钥如何进入运行时见本文以下各节；**OpenRouter 浏览器授权与 Grok / xAI 设备码登录的完整行为**（流程、状态机、令牌刷新、断开语义）见 [provider-authorization.md](provider-authorization.md)。

## 已知厂商 preset（写实）

`id` / `label` / `baseUrl` / 凭据变量名 / 种类 / 模型列表探测，均为仓库内置声明：

| id | label | api | baseUrl | credentialRef（环境变量名） | 种类 | 探测模型列表 |
| --- | --- | --- | --- | --- | --- | --- |
| `opencode-go` | OpenCode Go | openai-completions | `https://opencode.ai/zen/go/v1` | `GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY` | 订阅 | 是 |
| `command-goat` | Command Goat | openai-completions | `https://api.commandcode.ai/provider/v1` | `GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY` | 订阅 | 是 |
| `grok` | Grok | openai-completions | `https://api.x.ai/v1` | `GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN` | 订阅 / xAI 设备码登录 | 是 |
| `chatgpt` | ChatGPT | openai-completions | `https://chatgpt.com/backend-api/codex` | `GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN` | 订阅 | 是 |
| `openai` | OpenAI | openai-completions | `https://api.openai.com/v1` | `OPENAI_API_KEY` | API KEY | 是 |
| `anthropic` | Anthropic | anthropic-messages | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | API KEY | 是 |
| `gemini` | Google Gemini | openai-completions | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` | API KEY | 是 |
| `openrouter` | OpenRouter | openai-completions | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | API KEY / 浏览器授权 | 是 |
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
- **写入即持久化（走反向通道，不需要用户操作）**：密钥立刻在守护进程生效，同时被登记为「等待落盘」；桌面 App 会轮询 `GET /api/app/secret-requests`（同样需要 app token），用与「保存密钥」相同的 `safeStorage` 写进钥匙串，然后回推 `persisted: true` 清掉等待标记。钥匙串是唯一的持久存储，而它只由桌面端持有 —— 所以是**桌面端来取**（守护进程从来不直接写密钥文件）。
- **你如何确认已持久化**：`GET /api/config` 的 `pendingSecretRefs` **不再包含**该 ref。若仍包含，说明桌面端还没取走（App 未运行，或钥匙串不可用），此时**不要**声称已保存。
- `GET /api/app/secret-requests` 只列出**由 Agent 推送、尚未落盘**的值；用户在 App 窗口保存的钥匙串密钥永远不会经这个接口回流（其值不出守护进程）。

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
4. `applied: true` **且** `/api/config/test` 通过，才算成功；手改文件则看 `watch.lastReason` 与 `watch.fileRevision`。
5. 写完密钥后确认 `pendingSecretRefs` 已清空，才说「已持久化」。
5. 删模型前确认没有未完成任务在用（否则 `config_in_use`）。

## 需要的模型或凭据不可用时

主 Agent 没有「申请模型授权」工具（已按奥卡姆剃刀移除），缺能力时按本节操作：

1. **先看缺什么**：`GET /api/config` 的 `credentials.<id>.configured`（谁没值）、`GET /api/usage`（额度是否用尽）、`GET /api/startup`（`modelCount` vs `enabledModelCount`，有差值就说明有模型未启用）。
2. **凭据缺失**：优先请使用者提供密钥。使用者给出密钥后走桌面端通道落盘：`POST /api/app/secret {ref, value}`（带 `x-graph-app-token`）——守护进程立即可用，桌面端几秒内写入钥匙串，并在下次启动时注入进程环境。
3. **模型条目缺失/不可用**：按上文「一次配置的完整动作」改文档并提交，或按「同一平台的多个账户」加账户；改完用 `POST /api/config/test {modelId}` 真发一次请求确认（返回 `ok:true` 才算通过）。
4. **绝不静默替换**成无关模型；先说明缺什么、影响哪个节点。

## 不要宣称

- 不要只看「文件改完了」就说生效：用 `GET /api/config` 的 `watch` 字段确认（`lastReason` 为 null 且 `fileRevision` 是你写的值）。
- 不要把 `applied: true` 当作模型可用（要跑 `/api/config/test`）。
- 不要在看到 `pendingSecretRefs` 仍含该 ref 时声称密钥已永久保存。
- 不要为 `command-goat` 之类仓库未声明文档的厂商编造凭据获取步骤。
