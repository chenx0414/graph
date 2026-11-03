# Graph 服务商授权（OpenRouter / xAI）

**何时读**：用户要求给某个厂商接通「账号登录 / 浏览器授权」，或排查授权流程、令牌刷新、断开凭据时。
**性质**：本文是行为契约（流程、状态机、持久化与断开语义均以当前代码为准）。厂商目录、模型字段与密钥如何进入运行时见 [models-and-providers.md](models-and-providers.md)。

---

## 服务商选择与浏览器授权

首次设置和模型设置使用 `backend/internal/graph/catalog_providers.go` 的同一服务商目录；支持名称/端点搜索、API key/订阅凭据筛选、本地 LobeHub 品牌图标和自定义兼容服务。新增 OpenAI、Anthropic、Google Gemini、OpenRouter 到模型设置入口；原有账户 ID、`secretRef` 与保存路径不迁移。

**OpenRouter 浏览器授权**由 Go 宿主实现 PKCE 授权：选择 OpenRouter → 授权登录 → 打开浏览器授权 → 等待桌面安全存储确认 → 保存配置、选择模型并验证。依据 [OpenRouter 官方 PKCE 文档](https://openrouter.ai/docs/guides/overview/auth/oauth)，该流程交换的是用户控制的 API key，直接用于现有 Chat Completions 路径，不存在 access/refresh token 定时刷新。认证与模型可调用性仍分别验证。

- 认证由宿主运行；PKCE verifier、授权码和 key 不进入 renderer。Go 在 loopback 临时端口上监听每次随机 callback 路径，只接受该流程的回调，重复回调不重复交换。Graph 只向页面返回安全状态和 OpenRouter 授权地址。
- `POST /api/providers/login {providerId:"openrouter", credentialRef}` 启动流程；`GET /api/providers/login/:id` 返回 `starting / waiting / saving / complete / cancelled / failed`；`POST /api/providers/login/:id/cancel` 取消。它们使用现有本机会话 cookie 与写请求 Origin 守卫，不能绕过鉴权。
- 同一凭据进行中的登录复用同一流程，五分钟未完成则取消；宿主关闭会清理回调服务。认证拒绝或交换失败保留已有凭据，不返回上游敏感错误原文。未实现远程浏览器手动粘贴回调，浏览器需与宿主在同一机器。
- 较早的桌面持久化确认不得覆盖最新凭据或恢复已撤销凭据；收到过期确认时保留当前状态，并重新排队同步最新值。
- `saving` 包括等待桌面 App 拉取密钥并通过 safeStorage 保存；只有待持久化请求消失才返回 `complete`。桌面 App 未运行或安全存储不可用时不能宣称永久保存，也不要用明文文件代替。
- `POST /api/providers/disconnect {credentialRef}` 先终止同凭据登录再撤销本机密钥；断开期间拒绝新的登录，防止迟到回调恢复密钥。撤销进入现有跨重启的 revoked-secrets 机制，桌面端随后移除加密保存值。**这是本机断开**，服务商端密钥须由用户在 OpenRouter 账户管理中撤销。共享同一个 `secretRef` 的配置会一同受影响。
- 其他订阅卡片仍使用访问令牌，不表示已支持 OAuth。ChatGPT/Codex 的 Responses 接入与可刷新 token 生命周期尚未实现。

**Grok / xAI 设备码登录**同样由 Go 宿主实现，协议依据 xAI 的 OpenID Connect 发现文档（`https://auth.x.ai/.well-known/openid-configuration`，`device_authorization_endpoint` + `token_endpoint`），采用 OAuth 2.0 Device Authorization Grant；客户端是无密钥的公开客户端，scope 为 `openid profile email offline_access grok-cli:access api:access`。

- 选择 Grok → 「生成 xAI 登录码」→ 页面显示一次性代码与授权地址（`verification_uri_complete` 已带码）→ 用户在浏览器确认 → 宿主每 5 秒轮询一次 token 端点（`authorization_pending` 继续、`slow_down` 加长间隔、`access_denied`/`expired_token` 直接失败）→ 通过后写访问令牌并进入 `saving`，等桌面安全存储确认后才是 `complete`。
- 设备码、访问令牌与刷新令牌都不进入 renderer；页面只得到用户码、授权地址和生命周期状态。发现文档里的端点必须仍在 `x.ai` 授权主机上，否则拒绝启动。
- 访问令牌默认 1 小时有效：宿主另存一个 `<credentialRef>_REFRESH` 伴随条目（JSON：刷新令牌、token 端点、访问令牌到期时间），在到期前 5 分钟自动刷新并重写两者；换令牌失败重试三次后停止，不会假装已刷新。守护进程重启时从该伴随条目恢复刷新循环，不需要用户重新登录。
- `POST /api/providers/disconnect` 会同时撤销访问令牌与伴随刷新条目，避免断开后又被重启刷新拉回来。本机断开不等于在 xAI 账户里撤销授权。
- 这条链路只解决登录与令牌生命周期；模型是否可用仍以「保存并验证」的真实探测为准。
