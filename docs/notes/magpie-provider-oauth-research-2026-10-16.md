# Magpie 多厂商配置、OAuth 与图标研究

研究日期：2026-10-16。范围是学习实现与提出 Graph 适配建议；未运行上游应用、未登录账户、未验证线上订阅可用性，未变更 Graph 运行配置。

## 结论

Magpie 值得借鉴的部分是**服务商预设元数据、可搜索的图标卡片、独立的订阅登录入口，以及明确处理刷新竞态的凭据生命周期**。Graph 已有 Pi 执行内核、厂商配置向导、模型探测与安全存储，应优先统一厂商目录和图标，再按提供商实现认证适配；不需要为了获得这些体验引入 Magpie 的完整本地代理和多账户自动切换。

以下上游链接全部固定于 Magpie commit `674b6ca2881f1289c4ccdec158762978a463320c`，由公开仓库浅克隆后 `git rev-parse HEAD` 确认。它是本次取得的源码快照，不声称对应某个发布版本。README 描述用途，下面的实现结论来自代码；未审计的提供商不推断为同一种 OAuth 流程。

## 1. 预设、实例、认证与协议分层

| 观察 | 源码证据 | 对 Graph 的含义 |
| --- | --- | --- |
| `PresetDef` 保存 ID、名称、图标、分类、各协议端点、密钥获取链接、地区/套餐、模型列表规则、请求头提示；`Region` 能改端点与目录 | [presets.go:10–95](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/presets.go#L10-L95) | 目录应驱动界面、默认值和帮助信息，避免界面手写第二套厂商名单 |
| `FromPreset` 从预设生成 `Provider` 实例，API key 由调用方补入；预设历史 ID 有别名迁移 | [presets.go:605–678](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/presets.go#L605-L678) | 厂商类型、用户配置实例和账户应有独立身份；改展示名不应破坏模型引用 |
| 实例同时允许 Chat、Responses、Anthropic、Gemini 等不同端点，`BaseAPI` 记录用户在编辑器选择的协议 | [provider.go:35–103](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/provider.go#L35-L103) | 图标和品牌不能代替协议能力判断；同品牌 API key 与订阅可能走不同协议 |
| `Provider.Key` 是真实 key，文件注释明确为 `providers.json`、0600 | [provider.go:1–8](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/provider.go#L1-L8)、[47–59](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/provider.go#L47-L59) | 0600 是文件权限，不是密钥加密；不要替换 Graph 的 `secretRef` 与桌面安全存储 |

Magpie 的服务商类别不只是模型厂商，还包括转售聚合、本机服务与远端 Magpie；这些是 Magpie 的产品范围，不应原封不动变成 Graph 的领域概念。Graph 适配可以只保留有实际用户需求的类别。

## 2. 添加体验与模型发现

添加面板按名称、ID、主机、说明搜索；订阅入口标为「sign in, no key」，API 厂商按类别显示图标卡片，搜索无结果时能直接新增自定义服务商。地区版本在同一行配对。见 [app.js:6990–7120](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/gui/assets/app.js#L6990-L7120)。自定义实例提供名称、协议、端点、key、header、图标等草稿字段；保存时提交配置对象。见 [app.js:8690–8704](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/gui/assets/app.js#L8690-L8704)、[9549](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/gui/assets/app.js#L9549)。

模型列表不是单纯把 models.dev 全部当成可调用模型：`Available()` 优先采用服务商实际列表，再装饰目录元数据；`lists()` 区分无列表预设；`fetch()` 为 `NoList` 提供预置模型路径；`fetchOne()` 读取自定义模型列表 URL 或协议端点。见 [models.go:29–119](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/models.go#L29-L119)、[159–165](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/models.go#L159-L165)、[304–375](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/models.go#L304-L375)、[619–631](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/models.go#L619-L631)。

**可复用原则**：实时探测决定可选 ID；models.dev 补充上下文、推理等信息；探测失败、列表为空、无列表接口应分别展示，并允许手填 ID。列表刷新成功并不证明推理、工具调用或 usage 可用，仍需真实模型调用验收。

Graph 当前已有两步配置与探测/目录合并：[provider-form.ts](../../src/web/provider-form.ts)、[providers.ts](../../src/server/providers.ts)；首次设置另有 [catalog/providers.ts](../../src/catalog/providers.ts) 与 [Setup.tsx](../../src/web/Setup.tsx)。因此这里的增量是统一来源和改善呈现，不是重新实现模型目录。

## 3. OAuth 不是一个通用登录按钮

### Codex / ChatGPT 订阅示例

`StartSignInWith` 为每次流程生成 verifier 和 state，`begin()` 使用 SHA-256 的 PKCE S256；Codex 分支以 `localhost:1455/auth/callback` 为 redirect URI，监听地址是 loopback `127.0.0.1:1455`。端口无法监听时仍能进入粘贴最终回调 URL 的降级路径。见 [signin.go:35–43](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/signin.go#L35-L43)、[238–248](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/signin.go#L238-L248)、[323–361](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/signin.go#L323-L361)。

粘贴回调会校验 loopback 主机、端口、路径及本次 state；正常成功回调要求 state 匹配、code 非空，并通过 `claim()` 防止浏览器与粘贴并发重复完成。见 [signin.go:565–651](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/signin.go#L565-L651)、[674–683](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/signin.go#L674-L683)、[751–805](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/signin.go#L751-L805)。精确边界：handler 的 `/cancel` 和 OAuth error 分支发生在成功路径 state 检查之前，因此这里不能概括为「所有回调分支均先校验 state」。

授权码交换带上 verifier 与 redirect，返回结果组装为 auth.json 形状，包括 access/refresh/id token 与账户标识。见 [signin.go:930–968](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/signin.go#L930-L968)。另有 `ChatGPTAPIID` 的 Sign in with ChatGPT 分支，会进行宿主身份注册，与 `codex` 分支不同；不能看到 ChatGPT 名称就把两条路径混为一谈。见 [signin.go:361–373](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/signin.go#L361-L373)。本研究没有完整审计该独立分支，也不据此断言 Graph 可以使用其客户端注册方式。

### Claude 与 Copilot 的差异

- Claude 分支直接运行官方 `claude auth login --claudeai`，由 CLI 承担登录；Magpie 捕获入口与结果，而非自己复制 Anthropic 的全部 OAuth 协议。见 [claude_signin.go:139–162](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/claude_signin.go#L139-L162)。因此 Graph 若借鉴，需要明确 CLI 依赖、安装发现、进程取消和隔离配置目录。
- Copilot 使用 GitHub device authorization：取得 device/user code，显示 verification URI，按 interval 轮询，处理 `authorization_pending`、`slow_down`、过期与拒绝，查询账户后保存。源码使用 Copilot 编辑器的 OAuth client ID。见 [copilot_signin.go:1–38](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/copilot_signin.go#L1-L38)、[61–175](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/copilot_signin.go#L61-L175)。这证明上游如何实现，不证明第三方客户端获得了可复用的接入授权，也不意味着任意 GitHub 登录 token 都能用于模型推理。

### 持久化、刷新与并发

保存账户含敏感 auth 数据；`logins.json` 写入前备份上一代，`writePrivate` 使用 0700 目录和 0600 原子写。此路径不等于系统钥匙串加密。见 [logins.go:236–263](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/logins.go#L236-L263)、[293–307](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/logins.go#L293-L307)。

Magpie 为整个账户文件读改写使用跨进程 `loginsMu`，为保存账户 token 更新另设跨进程 `savedTokenMu`。`renewSavedLogin` 在刷新锁内重读账户，Codex access token 剩余大于五分钟时复用，否则刷新并将轮转后的 token 写回。见 [logins.go:123–133](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/logins.go#L123-L133)、[logins_on.go:1–26](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/logins_on.go#L1-L26)、[249–309](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/logins_on.go#L249-L309)。这体现「一个 refresh token 的明确所有者」；不能只在浏览器状态里存 token，也不能让两个宿主各自刷新同一份副本。

`codexRefresh` 发出刷新后用 `WithoutCancel` 配合 30 秒上限等待结果，防止请求取消丢弃已经轮转的 refresh token；只在响应含新 refresh token 时覆盖旧值。刷新失败区分供应商拒绝与网络错误，保存账户可标记 lapsed。见 [account.go:1116–1170](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/account.go#L1116-L1170)、[logins_on.go:312](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/provider/logins_on.go#L312)。这些是值得学习的恢复细节；仍有网络超时后供应商已轮转等不确定窗口，代码不能证明任意故障都可无损恢复。

## 4. LobeHub 图标来源与许可证

图标来源确实可核实：上游 [reference.md:86](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/docs/reference.md#L86) 标注 `lobehub/icons`，GUI [app.js:8088–8108](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/gui/assets/app.js#L8088-L8108) 注释明确预设与额外厂商图标来自该集合，并维护 `MORE_ICONS`；[内置 SVG 示例](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/gui/assets/icons/minimax-color.svg) 也包含 `lobe-icons` 的 gradient ID。这里是随应用分发的本地 SVG 资产及映射，不要求 Graph 为展示图标运行 Magpie 网关。自定义服务商还能从图标选择器选内置图标或上传图片，见 [app.js:8110–8125](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/internal/gui/assets/app.js#L8110-L8125)。

Magpie 根 [LICENSE](https://github.com/yetone/magpie/blob/674b6ca2881f1289c4ccdec158762978a463320c/LICENSE) 为 MIT，版权 2026 yetone，复制实质代码须保留其版权和许可声明。LobeHub 的 [官方 LICENSE](https://github.com/lobehub/lobe-icons/blob/8a1b2821bb768c484fe8da20c5e1838b6bf551a9/LICENSE) 也为 MIT，版权 2023 LobeHub；该链接固定于研究日查询到的上游 HEAD `8a1b2821bb768c484fe8da20c5e1838b6bf551a9`。实际引入资产时应固定 lobe-icons 版本/commit，并保留对应 LICENSE 与来源清单。MIT 文本没有给予品牌商标使用的独立授权；图标用于识别服务商，不暗示平台背书。

## 5. Graph 适配顺序与交付边界

### P0：统一厂商元数据与图标

建立一个可由首次设置、设置页和服务端共享的厂商目录，收敛现有两套模板。每项包含稳定 ID、名称、图标、本地资源来源、官网、密钥帮助、地区/套餐默认值和支持的协议；认证方法单独描述，不能由品牌名或 `subscription` 标签推断 OAuth 能力。现有 `secretRef`、HTTP revision 校验与安全存储继续承担正式配置与凭据职责，详见 [模型与厂商配置](../agent/models-and-providers.md)、[desktop/lib.ts](../../desktop/lib.ts)。

验收：真实浏览器完成搜索厂商、预设回填、自定义服务商、模型探测与手填、保存后重载；验证不丢现有凭据引用。图标使用本地资源并在未知厂商回退，不能让图标下载失败阻断配置。

### P1：选择一条 OAuth 全生命周期，并核实 Responses

先核对 Graph 使用的 Pi 依赖实际提供哪些认证方法与 token 存储契约，再选一个有明确接入边界的提供商完成：登录开始、取消、超时、错误、回调归属、token 交换、安全持久化、重启恢复、单账户刷新互斥、轮转写回、失效重登、注销。认证状态只向 UI 暴露状态与账户摘要，不返回 token。不要在 renderer、Graph 配置文档或日志里新增明文 token。

订阅登录与 API key 的额度、API 路径、模型可见性不是同一契约。尤其 Graph 当前配置向导主要表达 `openai-completions` / `anthropic-messages`，需要独立核对 Responses 从目录、配置、Pi 调用到流式输出、工具调用和 usage 的完整路径；不能只增加一个 ChatGPT 卡片或把订阅 token 填入 Chat Completions 端点便宣称接入完成。当前边界见 [provider-form.ts](../../src/web/provider-form.ts) 及 [模型与厂商配置](../agent/models-and-providers.md)。

验收只新增真正 E2E：真实浏览器/公开应用入口贯穿自有宿主、安全持久化与重启流程；外部 OAuth/token/模型服务可替代，自有协作者不 mock。应覆盖 state 错配、重复回调、端口占用的清晰反馈、取消后的晚响应、并发刷新只消费一次 token、刷新拒绝与网络失败、重新登录与注销；至少一次完整模型推理/工具调用与 usage 归属。真实提供商的人工登录只能由用户授权后执行，本研究未执行。

### P2：按需求逐个扩展提供商

在首个闭环稳定后扩展 device flow、CLI 登录或 API key 厂商；每次都单独确认 client 身份、协议、模型列表与刷新机制，不把 Magpie 覆盖数量当成 Graph 支持承诺。地区/套餐体验可逐步借鉴；多账户轮换、本地协议翻译网关、修改其他 Agent 配置和自动读取其他应用凭据不在此次建议的实施范围内。

### 保持 Graph 的执行与预算契约

[ADR 0031](../adr/0031-pi-durable-agent-kernel.md) 要求 main 与节点统一使用 pi-durable 的单一执行路径；引入第二套执行/恢复内核会与该决策冲突。应把提供商配置与认证作为现有模型接入的适配层，不把 Magpie 变成另一条 Agent 内核。

[ADR 0017](../adr/0017-unlimited-unknown-usage.md) 要求有限预算只接受 authoritative/account_delta；即使订阅登录与推理成功，也不能把缺失 usage 折算成零或用估算冒充正式预算。若未来增加账户故障转移，仍须在原 Agent 预算作用域内记录实际 provider/model/账户与用量来源，不能静默改变这一契约。

## 尚未验证

本研究核对静态源码，没有构建/运行 Magpie，没有证明所有 README 宣称的平台在当日均可登录，没有审计所有插件、授权客户端合规性或所有 token 存储路径，也没有验证 Graph 现有 Pi 版本对各个 OAuth 提供商的端到端支持。因此本笔记交付的是有源码依据的参考和实施边界，不是已完成接入的验收报告。
