# Graph 完全访问模式研究

研究日期：2026-09-19

基线：`da6a52fdb45dc65115b88ad2c945ecf433344e93`

状态：研究结论，未修改产品源码或测试。

## 问题

为 Graph 设计一个明确、可审计、可回退的“完全访问模式”，覆盖用户提出的三点：

1. 所有权限自动审批通过。
2. 所有 Agent 获得所有访问路径。
3. 所有能力不设限。

本文先盘点当前所有权限、审批、路径和能力边界，再区分哪些边界应由完全访问模式放开，哪些属于预算、暂停、计量、凭据、正式状态、恢复和任务确认等独立控制面。最后给出配置 schema、运行时 overlay、UI、迁移、危险点和测试出口。

## 结论摘要

1. **可以实现，但不应把它实现成一个 `bypass = true` 开关。** 当前系统至少有六类不同边界：问题归属、任务 grant、系统变更审批、命令白名单、Agent 路径边界、OS/MCP/extension 沙箱。完全访问模式应通过一个版本化 `AccessPolicy` 在派发时转换为多个运行时 overlay，而不是分别散落 `if (fullAccess)`。
2. **“所有权限自动审批”应只自动处理真正的运行授权，不应自动完成预算、人工验收、任务范围确认和未知结果恢复。** `permission` 和 `system_change` 可以按完全访问策略自动生成“原始问题 + 自动答案 + 审计事件”；`budget`、`human_check`、`model_access`、恢复不明和失败重试仍按原规则处理。
3. **“所有路径”不能直接等同于把 `readPaths`/`writePaths` 改成 `/` 并删除现有 canonical path 校验。** 当前 `bounded-path.ts`、`restricted-process.ts` 和 Git metadata 扫描共同承担 symlink、hardlink、TOCTOU、`.git` 和 canonical grant 防护。完全访问可以允许任意 canonical target，但仍应保留路径解析、审计和结果核查。
4. **同一 OS 用户下无法同时做到“任意路径绝对可读写”和“宿主凭据严格隔离”。** `$HOME/.ssh`、`.aws`、`.netrc`、`.git-credentials`、`.env`、Keychain 导出文件、Graph state 和配置文件都属于路径。若 Agent 真能读取所有路径，它就可能读取这些秘密。真正同时满足两者的方案需要独立执行身份、容器或 VM，再把宿主凭据放在该身份不可访问的凭证代理中。
5. **正式状态、审计、暂停、预算、调用计量、并发名额、供应商协议限制和任务图确认不应随访问模式关闭。** 这些不是“权限提示”，而是保证 Graph 可恢复、可解释、可回退和可计费的控制面。
6. MCP 不要求本地。MCP 官方标准 transport 是 stdio 与 Streamable HTTP；Graph 当前已经同时实现本地 stdio 和远程 HTTP。所谓“原生 MCP”在使用 Streamable HTTP 时可以直接接远程 `url`，不需要本地 `command`。
7. 建议默认 `standard`，完全访问模式必须显式开启、显示高风险界面、输入 typed phrase，并以配置 revision 和 policy digest 进入每次 operation 的审计记录。运行中的 operation 保留旧 policy，新 operation 才采用新 policy。

## 1. 当前边界盘点

### 1.1 问题归属与审批路由

当前问题分 `user` 与 `main` 两个 owner。只有 `permission`、`budget`、`reservation_exceeded`、`human_check`、`system_change` 以及明确的 `waiting/model_access` 直接归用户；其余执行问题先给 Main Agent。

- `src/core/question-routing.ts:7-28` 定义 owner 类型和直接归用户的 kind。
- `src/core/question-routing.ts:45-96` 写入持久问题，唤醒 Main Agent 或打开 user wait，并发出 `question.opened` 审计事件。
- `src/core/task-runtime.ts:543-565` 和 `src/core/task-runtime.ts:816-833` 只向用户视图暴露 user-owned 问题；main-owned 问题进入内部问题计数。
- `src/core/conversation.ts:335-351` 在主管对话摘要中汇总内部问题，并区分用户问题。
- `src/web/App.tsx:94`、`src/web/Conversation.tsx:662` 和 `src/web/Questions.tsx:7-16` 只渲染用户问题。

完全访问模式若要自动审批，不能直接把问题 owner 改成 `main`。这只会让 Main Agent 获得问题，不会生成“用户已授权”的正式答案，也无法让需要 grant 的旧路径继续工作。正确实现点应是在问题创建事务后增加 `autoDecision`，复用正常回答和审计路径。

### 1.2 任务 grants

当前有两层 grant：

1. 项目基础 grants，位于 `projects.grants`。
2. 任务运行时批准后写入的 `task_grants`。

派发前会合并两者，并与 adapter 声明的 required grant 比较。

- `src/server/config.ts:204-216` 解析项目级 `grants`。
- `src/core/store.ts:81-82` 创建 `task_grants(task_id, grant)` 表。
- `src/core/execution.ts:325-330` 合并项目与任务 grants；缺少 required grant 时产生 `permission` 问题并阻塞节点。
- `src/core/operation-lifecycle.ts:507-511` 只接受与问题中完全匹配的 grant，并持久写入 `task_grants`。
- `src/core/types.ts:195` 和 `src/core/types.ts:210` 分别定义 operation grants 和 grant answer。

能力绑定已经不再要求普通的逐 MCP 工具 grant：[ADR 0021](../adr/0021-capability-binding-default-authorization.md)。运行时加载 MCP 后发现工具时，会把绑定能力已发现的工具自动加入本次授权集合，见 `src/runtime/capabilities.ts:1194-1208`。因此“完全访问模式”不应改写或删除历史 `task_grants`，而应在 operation 上增加一个 `authorizationMode: "full"`，记录“本次绕过了 required grant 检查”。这样历史记录仍能解释哪些权限曾经由用户明确授予。

### 1.3 system_change 两阶段审批

当前系统变更已经分成 proposal 与 apply 两个阶段。

- `src/runtime/agent-tools.ts:248-291` 向 Main Agent 暴露 `propose_system_change` 和 `apply_system_change`。
- `src/runtime/pi-adapter.ts:365-390` 创建 `system_change` 问题；它的 `operationId` 明确为 `null`，避免模型回合结算时自动关闭问题。
- `src/core/operation-lifecycle.ts:512-519` 只接受 `approved` 或 `rejected` 作为用户答案。
- `src/runtime/pi-adapter.ts:392-438` 在 apply 时校验 proposal、task、node、resolved 状态和用户答案；只允许首版支持的 capability bundle。
- `src/catalog/capability-library.ts:90-112` 限制 bundle 文件数量、总大小、路径穿越和字面量 credential header。
- `src/catalog/capability-library.ts:259-301` 先写 staging、重新扫描、验证成功后才原子 rename。

完全访问模式可以让 proposal 自动得到 `approved`，但仍应保留第二个 `apply_system_change` 回合和 staging validation。自动批准不等于自动信任安装成功。尤其在写操作实际发生后，不能把问题直接标为 resolved 而不验证产物。

### 1.4 workspace command 白名单

普通 Agent 不能运行任意 shell。当前命令边界是：

- `src/runtime/workspace-command.ts:8-12` 只允许 `git status/diff/log/show`，并把 Git 解析到具体 CLT binary。
- `src/runtime/workspace-command.ts:45-60` 把 `node` 映射到 Graph 自己的 Node runtime，并注入 resolver shim。
- `src/runtime/workspace-command.ts:62-75` 只允许 `node` 和只读 `git`；`node -e`、`--eval`、`--print` 等 inline evaluation 被拒绝。
- `src/runtime/workspace-command.ts:83-109` 命令仍在 restricted executor 中运行，只授予 workspace、scratch 和必要 runtime read paths。
- `src/runtime/pi-adapter.ts:712`、`src/runtime/pi-adapter.ts:733` 在 prompt 中明确告知模型该限制。

完全访问模式若要“所有能力不设限”，应将命令策略拆成 `allowlisted` 与 `host` 两种模式。`host` 模式仍应以 executable + argv 直接执行，不应把一条用户字符串交给 shell 解释。当前 launcher 已通过 `quote()` 逐个引用 command 和 args，见 `src/runtime/restricted-process.ts:455-458`。

### 1.5 Agent 工具路径边界

Agent 的 `read`、`write_file`、`list_dir` 都在宿主侧校验路径。

- `src/runtime/agent-tools.ts:67-103` 以 workspace 和 `readRoots` 作为 mount；绝对路径不在 mount 内时报 `Path is outside the workspace`。
- `src/runtime/agent-tools.ts:83-91` 的写工具只接受相对 workspace 路径，目前没有 `writeRoots` 概念。
- `src/runtime/bounded-path.ts:17-45` 逐组件解析路径，拒绝 `..`、symlink、hardlink overwrite 和 `.git`。
- `src/runtime/bounded-path.ts:48-70` 使用 `O_NOFOLLOW`，并在 open 后重新比较 dev/ino，降低 TOCTOU。
- `src/runtime/pi-adapter.ts:241-296` 讨论态只开放只读工具；Main Agent 额外获得 capability root 和 running Graph application/source root 的只读访问。
- `src/runtime/graph-root.ts:4-7` 从模块位置推导运行中的 source checkout 或 packaged APP 的 `Contents/Resources/app`。
- `src/server/start.ts:335-338` 在系统自模型中报告 `application.root` 和 `source|packaged`。

一个重要实现细节是：若完全访问直接把 root 设为 `/`，当前 `requested.startsWith(`${candidate}${sep}`)` 这类 containment 判断必须改成 root-aware helper，否则候选根 `/` 会生成前缀 `//`，无法匹配 `/Users/...`。因此“全路径”不是简单改一个常量。

### 1.6 restricted-process 的 OS 边界

所有本地命令、MCP、extension 和 Pi worker 最终都经过 restricted process。

- `src/runtime/restricted-process.ts:200-231` 定义 read/write paths、Git metadata 例外、network、local binding、Unix socket 和 environment。
- `src/runtime/restricted-process.ts:242-248` 要求 grant path 已经是 canonical path。
- `src/runtime/restricted-process.ts:250-262` 生成 filesystem profile；写入 grant 内的 `.git` 仍被显式 deny。
- `src/runtime/restricted-process.ts:265-291` 扫描写 grant 下已存在的 `.git`，超过 50,000 个目录项时拒绝继续。
- `src/runtime/restricted-process.ts:369-382` 规范化 grants，并形成 network 与 local binding policy。
- `src/runtime/restricted-process.ts:392-401` 构造 read/write profile；默认读取系统和 runtime，写入只允许显式路径。
- `src/runtime/restricted-process.ts:407-453` 为 unrestricted network、local binding 和 Unix socket 生成 Seatbelt 例外。
- `src/runtime/restricted-process.ts:459-461` 只有 unrestricted network 使用静态 direct-network profile；普通 allowlist 仍通过串行化 SRT proxy。
- `src/runtime/restricted-process.ts:644-645` restricted process 的 spawn 本身也经过 broker dispatch。
- `tests/m0/restricted-process.test.ts:34-80`、`:135-170`、`:171-225`、`:400-460` 当前验证了 host state、credential、symlink、subprocess、network 和 grant swap 等边界。

完全访问不能简单删除这些代码。至少应保留：

- canonical grant 解析；
- process-group 清理、timeout 和 cancellation；
- Git metadata 的 policy decision；
- policy digest 和审计。

### 1.7 MCP network、provisioning 与远程 transport

#### MCP 是否必须本地

不是。MCP 官方规范定义两种标准 transport：stdio 和 Streamable HTTP；stdio 由客户端启动子进程，Streamable HTTP 使用单一 HTTP endpoint，并可通过 JSON 或 SSE 返回，见 [MCP Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。

Graph 当前已经同时支持：

- 本地 stdio：`src/runtime/mcp-client.ts:86-139`，每次 exchange 启动一个受限 MCP 进程。
- 远程 Streamable HTTP：`src/runtime/mcp-client.ts:156-195`，拒绝 redirect，支持 `application/json` 和 `text/event-stream`。
- 远程 endpoint 解析：`src/runtime/capabilities.ts:524-538`。
- 本地命令解析：`src/runtime/capabilities.ts:744-792`，当前允许 `node`、`npx`、`uvx` 或绝对路径。
- 工具发现与调用：`src/runtime/mcp-client.ts:203-224`。

因此“原生 MCP”若指远程 Streamable HTTP，当前 manifest 使用 `url` 即可，不要求本地 command。

#### networkDomains、networkAccess 和 provisioning

- `src/catalog/file-capabilities.ts:91-135` 校验 `networkDomains`、`networkAccess: "unrestricted"` 以及两者互斥。
- `src/runtime/capabilities.ts:95-105` 内置 uv 和 npm 的 provisioning domains。
- `src/runtime/capabilities.ts:460-522` 推导 uv/npm provisioning plan、缓存根和 offline runtime env。
- `src/runtime/capabilities.ts:680-715` 首次启动时执行 provisioning，成功后写 `.ready`。
- `src/runtime/capabilities.ts:1142-1208` 区分本地和远程 MCP 的 network policy；本地 unrestricted network 使用静态 profile，普通域名继续使用 SRT proxy。
- `src/runtime/capabilities.ts:1194-1208` 把绑定能力已发现的 MCP tools 自动加入本次授权。

完全访问模式应增加 `capabilityNetwork: "unrestricted"` overlay。它可以覆盖普通 `networkDomains` 和 extension runtime network declaration，但仍应保留 MCP 的 JSON-RPC 生命周期、response size bound、redirect refusal、send gate 和调用计费。

### 1.8 Pi extension runtime declaration

Pi extension 是任意代码，当前以“声明最小运行时依赖”的方式运行。

- `src/catalog/file-capabilities.ts:37-47` 定义 `commands`、`env`、read/write paths、network、local binding 和 Unix socket。
- `src/catalog/file-capabilities.ts:150-188` 只允许 Pi extension 声明 `runtime`。
- `src/runtime/capabilities.ts:185-333` 解析 runtime declaration、展开 placeholder、解析 host command，并形成 read/write/network/socket policy。
- `src/runtime/capabilities.ts:1079-1112` 把 extension runtime 加入 capability operation。
- `src/runtime/pi-process.ts:104-109` 与 `src/runtime/pi-process.ts:184-202` 将 extension read/write roots、network、local binding 和 Unix sockets 传给 OS sandbox。
- [ADR 0022](../adr/0022-pi-extension-runtime-declarations.md) 明确一个 extension 的声明不能扩大其他 Agent、能力或后台权限。

完全访问模式可以给 Pi extension 传入一个 full-host overlay。要注意的是，SRT 的 `allowAppleEvents` 会允许 sandbox 内命令启动 sandbox 外的应用，因此它移除的是代码执行隔离，不只是网络隔离；sandbox-runtime README 的 Security Limitations 明确记录了这个风险。当前 Graph 没有暴露 `allowAppleEvents`，若要真正“所有能力”，必须把它设计成独立开关而不是默认随全路径开启。

### 1.9 凭据与模型访问

宿主保留 provider credentials，Agent 子进程只拿到 model metadata 和代理 tool schema。

- `src/server/config.ts:7-33` 配置文件只保存 `secretRef`，不保存 key。
- `src/server/config.ts:174-202` 校验 credential、shared group、并发上限和 default budget。
- `src/server/config.ts:290-295` 在宿主解析 env secret。
- `src/server/live-config.ts:58-68` 合并 pushed secret、env 和 revoke 状态。
- `src/server/live-config.ts:90-141` 生成 canonical credential identities，并禁止 alias 绕过同一 key 的共享限制。
- `src/runtime/pi-adapter.ts:138-218` 在每次实际发送前解析 live binding 和 credential slot。
- `src/runtime/controlled-openai.ts:269-306` 在实际 provider fetch 边界注入 key，设置 `maxRetries: 0` 与 `redirect: "error"`。
- `tests/m8/credentials.test.ts:58-85` 验证不同 endpoint 不串 key；`:88-107` 验证缺失 credential 不发请求。

完全访问模式不能把宿主 key 注入 Pi/MCP/extension process。它最多能允许 Agent 请求“配置一个 credential”或“使用已绑定 credential 发请求”，不能让子进程获得 key 值。若 Agent 同时拥有任意文件读权限，宿主 key 文件、CLI 登录态和 Graph secret 文件仍可能暴露，这是下一节的关键冲突。

## 2. 不得随 access mode 一起关闭的独立控制面

### 2.1 预算、token 与价格

当前默认 `defaultBudgetTokens = null` 表示不限累计 token，见 `src/server/config.ts:189-201` 与 `src/core/task-runtime.ts:198-218`。但这不等于应该取消预算控制：

- `src/core/budget-ledger.ts:102-129` 仍维护实例、scope、reserved、used 和 unlimited。
- `src/core/budget-ledger.ts:145-162` 在预算耗尽时 fail closed。
- `src/core/execution.ts:333-342` 在派发前根据 adapter reservation 产生 budget 问题。
- `src/runtime/task-gate.ts:35-44` 每次 provider send 前重新检查预算。

完全访问模式可以明确规定“新建 instance 默认 unlimited”，但必须通过单独的预算策略执行。不能把已有有限额度自动改成 unlimited，也不能因 Agent 自动批准权限而自动追加 token。价格未知仍显示 unknown，不能折成零。

### 2.2 暂停与 send gate

暂停是用户停止新副作用的控制面，不是权限提示。

- `src/core/task-runtime.ts:431-440` 设置 paused 状态和时长账本。
- `src/core/execution.ts:264-266`、`src/core/execution.ts:618-621` 在派发前后检查 pause。
- `src/runtime/task-gate.ts:35-44` 在每次 provider send 前检查 `paused`、unknown usage 和预算。
- `src/runtime/mcp-client.ts:57-84` 让本地和远程 MCP exchange 都经过同一个 gate。

完全访问模式不能关闭 pause，否则用户失去唯一可即时停止新调用的正式控制。

### 2.3 调用计量、费用和并发名额

- `src/runtime/task-gate.ts:45-56` 每次 dispatch 前写入唯一 invocation。
- `src/runtime/task-gate.ts:57-101` 结算 usage 和 cost。
- `src/runtime/model-scheduler.ts:50-106` 按 credential 和 shared group 限制在途模型请求。
- `src/runtime/execution-slots.ts:8-18` 定义 10 个 Agent 与 4 个程序执行名额。

完全访问模式不增加供应商账户配额，也不取消 Graph 的本地资源上限。网络 unrestricted 只表示目标可达，不表示可以无限并发或免费调用。

### 2.4 凭据隔离、路径与同一 OS 用户的冲突

有两个层面：

1. **宿主凭证注入隔离**：key 只在 provider 代理层存在，不给 Pi/MCP/extension。这个应永久保留。
2. **主机文件隔离**：如果 Agent 拥有任意 read path，它可能读取 `$HOME/.ssh`、`$HOME/.aws`、`~/.netrc`、`~/.git-credentials`、环境文件、CLI cookie 和 Graph state。即使 Graph 不把 key 注入子进程，Agent 仍可能通过文件取得其他凭据。

Git 官方文档说明 `credential.helper=store` 会把凭据保存在磁盘文件中，见 [gitcredentials](https://git-scm.com/docs/gitcredentials#Documentation/gitcredentials.txt-store)。sandbox-runtime README 也把 `~/.ssh` 和 shell config 列为典型必须保护的文件。

因此需要明确产品选择：

- **方案 A，推荐：full host access，但保留 mandatory credential/Graph state deny roots。** 这最接近“所有工作路径”，并维持凭据和正式状态隔离，但不是字面上的绝对所有路径。
- **方案 B，绝对 all paths。** Agent 可以读取宿主一切可读文件。此时不能再承诺宿主凭据隔离和正式库完整性。
- **方案 C，绝对 all paths + 凭据隔离。** Agent 必须在独立 OS user、容器或 VM 中运行；宿主凭据通过代理注入。当前 sandbox-exec 同用户模型不能完整解决这一点。

### 2.5 正式状态、审计与恢复一致性

- `src/core/operation-lifecycle.ts:216-260` 在实际副作用前写 operation intent。
- `src/core/operation-lifecycle.ts:180-213` 重启时把已 dispatched 但无 live worker 的操作标成 unknown，要求 reconciliation。
- `src/core/operation-lifecycle.ts:300-323` 在 dispatch 边界写正式状态并拒绝 stale generation。
- `src/core/store.ts:34` 使用 SQLite WAL 与 FULL。

完全访问模式不能自动把 recovery、adapter error 或 unknown outcome 标成 resolved。它可以让 Main Agent 自动获得调查权限，但不能跳过 reconcile、证据和状态迁移。否则“全自主”会变成“静默猜测外部副作用是否发生”。

### 2.6 任务图确认

确认不是权限审批，而是用户对交付范围、验收方式、目标分支和任务身份的正式承诺。

- `src/core/task-runtime.ts:989-1031` 校验当前 proposal、requirement version、目标分支，并在确认后创建正式 task、graph revision 和 acceptance。
- [ADR 0005](../adr/0005-new-function-new-task.md) 要求新功能建立新任务。

完全访问模式可以自动批准运行权限，但不应自动确认任务图。若产品确实需要无人值守启动，应单独增加 `autoConfirmDraft`，并显示它会产生正式 Git 任务和验收范围，而不是把它藏在“权限自动批准”里。

### 2.7 模型与供应商协议限制

- `src/server/config.ts:130-156` 只接受已实现的 OpenAI chat-completions 和 Anthropic messages transport。
- `src/runtime/controlled-openai.ts:277-299` 拒绝未验证 transport，并把 `maxTokens` 限制在模型声明内。
- `src/runtime/model-scheduler.ts` 仍按 credential 排队。

完全访问不能绕过 context window、max output、rate limit、429、供应商 TOS 和真实账户余额。它也不能让缺失 credential 的模型凭空可用。

### 2.8 人工检查与其他 user-owned 决策

`human_check`、预算追加、模型订阅配置和明确需要用户决定的业务选择都不是“运行权限”。完全访问模式不应自动完成这些事项。建议只将 `permission` 和 `system_change` 纳入 `autoApprovalKinds`，其他 kind 保持原 owner。

## 3. 建议的配置设计

### 3.1 Schema

在 `graph.config.json` 的 version 1 文档中增加可选 `access`。旧文件缺失时按 `standard` 处理。

```ts
type AccessMode = 'standard' | 'full';

interface FullAccessPolicy {
  mode: AccessMode;
  autoApprove: {
    permission: boolean;
    systemChange: boolean;
  };
  filesystem: {
    read: 'workspace-and-bound' | 'host';
    write: 'workspace-and-bound' | 'host';
    gitMetadata: 'protected' | 'writable';
    credentialStores: 'protected' | 'readable';
  };
  network: 'declared' | 'unrestricted';
  commands: 'allowlisted' | 'host';
  piExtensions: {
    runtime: 'declared' | 'host';
    localBinding: boolean;
    unixSockets: 'declared' | 'all';
    appleEvents: boolean;
  };
  confirmation: {
    typedPhrase: string;
    enabledAt: number;
    enabledBy: 'user';
  };
}
```

建议默认值：

```json
{
  "access": {
    "mode": "standard",
    "autoApprove": {
      "permission": false,
      "systemChange": false
    },
    "filesystem": {
      "read": "workspace-and-bound",
      "write": "workspace-and-bound",
      "gitMetadata": "protected",
      "credentialStores": "protected"
    },
    "network": "declared",
    "commands": "allowlisted",
    "piExtensions": {
      "runtime": "declared",
      "localBinding": false,
      "unixSockets": "declared",
      "appleEvents": false
    }
  }
}
```

`mode: "full"` 可以一次性生成 full overlay，但底层仍保存细分字段，便于 UI 解释和回退。若用户选择方案 B，需要把 `credentialStores` 和 `gitMetadata` 也改成危险值，并输入更强的 typed phrase。

### 3.2 作用域

建议使用三层，不直接由任务图节点自行声明：

1. **全局默认**：`graph.config.json.access`，新 conversation 和 task 的默认 policy。
2. **会话覆盖**：conversation 可保存 `accessOverride: "standard" | "full" | "inherit"`。
3. **任务冻结**：创建正式 task 时复制 conversation 的有效 policy 和 digest；图修订不能自行提升 access mode。

建议只允许“全局开启 full”后，会话和任务选择 `inherit` 或 `standard`。会话不能凭配置把全局 standard 提升为 full。这样不会因为历史 conversation row 被修改而突然获得宿主权限。

每次 operation 在 `Operation` 中冻结 `accessPolicyVersion` 和 `accessPolicyDigest`。运行中的 operation 不因设置热更新而改变。配置变化只影响下一次 admit。

### 3.3 运行时 policy overlay

新增一个纯函数模块，建议路径 `src/core/access-policy.ts`：

```ts
interface ResolvedAccessPolicy {
  version: number;
  digest: string;
  authorization: 'standard' | 'bypass';
  filesystem: {
    readRoots: 'bound' | 'host';
    writeRoots: 'bound' | 'host';
    systemIntegrity: {
      gitMetadata: 'protect' | 'allow';
      credentialStores: 'protect' | 'allow';
      graphState: 'protect' | 'allow';
    };
  };
  network: 'declared' | 'unrestricted';
  commands: 'allowlisted' | 'host';
  extension: ResolvedExtensionAccess;
}
```

入口建议：

- `src/core/task-runtime.ts` 在 task/operation admit 时解析并冻结 policy。
- `src/core/operation-lifecycle.ts` 把 policy digest 写入 operation。
- `src/runtime/pi-adapter.ts` 将 policy 转成 `additionalReadRoots`、`writeRoots`、network、command runner、extension runtime。
- `src/runtime/capability-bundle.ts` 只接收 overlay，不把可变 access policy 混进不可变 capability bundle digest；将 effective runtime policy 单独 digest。
- `src/runtime/restricted-process.ts` 把 resolved policy 映射成 SRT profile。

这样所有 Agent 使用同一套 policy，Main Agent、subagent、MCP、Pi extension 和程序节点不会产生分叉。

### 3.4 自动审批的实现点

不要在 `insertQuestion()` 中直接写 `status='resolved'`。建议增加统一路径：

```ts
insertQuestion(store, {
  taskId,
  nodeId,
  operationId,
  kind,
  data,
  policy: resolvedAccessPolicy
})
```

事务内执行：

1. 正常创建问题并计算 owner。
2. 若 policy 允许该 kind 自动批准，写入 `answer`。
3. 调用与 `OperationLifecycle.answer()` 相同的状态迁移函数。
4. 发 `question.auto_approved`，记录 `policyDigest`、`kind`、`proposalId` 或 `grant`。
5. 对 `permission` 持久写入 `task_grants`。
6. 对 `system_change` 写 `decision=approved`，并把节点恢复为 pending，让 Main Agent 继续 apply 回合。

这里复用 `answer()` 的原因是可保持现有 authorization、wait ledger、node status 和 event 语义。直接在 `questions` 表写 resolved 会绕过：

- grant 匹配；
- user wait 关闭；
- `system_change` 决策格式；
- 节点重新调度；
- conversation queue；
- `hooks.advance()`。

完全访问模式不建议自动关闭 main-owned problem。可以自动批准“处理该问题所需的权限”，但 `recovery`、`adapter_error`、`unknown_usage` 等仍需经过诊断和 reconcile。

### 3.5 路径放开

完全访问的推荐实现不是把 `bounded-path.ts` 删除，而是把 policy 传进去：

- standard：沿用 workspace + bound read roots，写 workspace + scratch。
- full：
  - read root 允许任意 canonical path；
  - write root 允许任意 canonical path；
  - symlink 可按 policy 跟随，但解析后必须记录 canonical target；
  - 保留 dev/ino 复核、hardlink 写保护和 process-group cleanup；
  - `.git`、credential stores、Graph state 由 mandatory protect list 决定。

`agentTools()` 需要新增 `writeRoots`，并统一使用 root-aware containment。当前 `write_file` 只支持 relative workspace path，见 `src/runtime/agent-tools.ts:83-91`，无法通过传一个 `/` mount 达到 full write。

`restricted-process.ts` 也不应直接把 `/` 加进当前 writePaths。原因：

- `gitMetadataPaths()` 会遍历所有写 roots，当前 50,000 项上限会在大范围根目录上直接失败，见 `src/runtime/restricted-process.ts:265-291`。
- `canonicalGrant()` 要求路径已经是 unchanged canonical path，见 `src/runtime/restricted-process.ts:242-248`。
- Seatbelt profile 仍需要明确的 system read paths、device writes 和 network policy。

更稳的做法是增加 `filesystem: "host"` 分支，使用专门生成的最小 profile，而不是让 full mode 经过 workspace grant 算法的巨大 root 扫描。

### 3.6 capabilities 放开

MCP 和 Pi extension 的 manifest 仍用于描述和审计，但 full access policy 可以覆盖其运行限制：

- MCP 任意域：将 local stdio 的 `networkDomains` 替换为 `allowUnrestrictedNetwork`。
- remote MCP：跳过 domain allowlist 检查，但仍保留 URL protocol、redirect refusal、response bound 和 send gate。
- 任意本地命令：允许 `command` 是绝对 executable，或经 host PATH resolver 解析后记录 realpath 的 bare command。禁止把 command+args 拼接成 shell 文本。
- Pi extension：`runtime: "host"` 时覆盖 declared commands/paths/network/local binding/socket；`appleEvents` 单独 opt-in。
- provisioning：full network 下可以不强制 runtime offline，但保留缓存、版本 pin 和 staging 验证。

### 3.7 UI 与配置生效

设置页已有配置导航和模型、Git 准备、并发限制等 section，见：

- `src/web/Settings.tsx:283-335` 设置页 section 和路由。
- `src/web/Settings.tsx:338-444` 配置草稿加载、保存和 revision 冲突处理。
- `src/web/Settings.tsx:568-600` 常规与 Git section。
- `src/web/Settings.tsx:782-802` 当前并发上限 UI。
- `src/server/app.ts:118-166` 配置读取和原子保存 API。
- `src/server/config-service.ts:40-89` revision lock、validation、atomic rename 和 live apply。

建议新增“访问模式”section，至少显示：

- 当前 mode 与作用域；
- 会自动批准哪些问题；
- 读写路径是否 unrestricted；
- network、commands、Pi extension runtime 状态；
- `.git`、credential stores、Graph state 的保护状态；
- 当前有效 policy digest；
- 输入 typed phrase 后启用；
- 一键回退到 standard。

启用危险字段时应要求：

- 当前没有 running operation，或明确等待下一次安全派发边界；
- 已暂停任务，或二次确认；
- typed phrase 与 schema 中完全匹配；
- 记录 `access.full_enabled`、旧 digest、新 digest 和操作者；
- 禁用时发 `access.full_disabled`，不重写历史 operation。

### 3.8 为什么不应简单删除 sandbox

1. 删除 sandbox 会让 MCP、extension 和任意子进程直接拥有宿主用户权限。
2. 当前 pause、budget、usage 和 MCP exchange 仍依赖 restricted process 作为统一 dispatch adapter。
3. symlink、process tree、Unix socket 和 Git metadata 没有替代防线。
4. 没有 sandbox 后，MCP 和 extension 仍可绕过 Graph 的 provider gateway，读取宿主 key 或直接发请求。
5. 完全访问模式本身也需要可回退、可审计和 scope 一致；直接移除边界会让回退不完整。

### 3.9 为什么不应自动把问题标 resolved

“自动批准”与“问题已经解决”是两件事：

- system change 被批准后，capability 仍可能扫描失败；
- recovery 的权限已批准，但外部副作用仍可能 unknown；
- permission grant 被批准，只说明可以尝试，不说明工具一定成功；
- budget 被批准，不说明实际 usage 已被 authoritative accounting。

问题状态必须继续由正常 apply、reconcile、settle 和 evidence 路径推动。完全访问模式可以减少等待，但不能伪造完成。

## 4. 最小改动文件集合

### 配置与作用域

- `src/server/config.ts`：access schema、默认值、validation。
- `src/server/config-service.ts`：原子保存和 revision。
- `src/server/live-config.ts`：effective access revision 和 policy。
- `src/server/app.ts`：设置 API DTO 与 typed phrase 校验。
- `src/web/Settings.tsx`：危险设置入口和状态展示。

### 正式状态与审批

- `src/core/types.ts`：Operation 或 project/task policy 字段。
- `src/core/store.ts`：需要持久化 scope、policy digest 或自动答案标记时的 migration。
- `src/core/task-runtime.ts`：创建 task/conversation 时冻结 policy。
- `src/core/operation-lifecycle.ts`：admit 时保存 digest，自动批准复用 answer transition。
- `src/core/question-routing.ts`：接收 policy 并产生 auto decision。
- 新增 `src/core/access-policy.ts`：解析、digest、scope 合并和 preset。

### 执行边界

- `src/runtime/agent-tools.ts`：read/write roots 和 root-aware containment。
- `src/runtime/bounded-path.ts`：policy-controlled symlink、Git metadata、credential protect。
- `src/runtime/workspace-command.ts`：host command policy。
- `src/runtime/capability-bundle.ts`：operation overlay 与 effective policy digest。
- `src/runtime/capabilities.ts`：MCP/extension access overlay。
- `src/runtime/pi-process.ts`：把 effective policy 传给 worker。
- `src/runtime/restricted-process.ts`：host filesystem/network/socket profile。

### 测试

- `tests/m8/startup.test.ts`：配置 schema、默认值和迁移。
- `tests/console/question-routing.test.ts`：auto approval owner、grant 和 system change。
- `tests/m3/agent-tools.test.ts`：full read/write、`.git`、symlink、root containment。
- `tests/m0/restricted-process.test.ts`：canonical grant、network、Unix socket、local binding。
- `tests/m3/capabilities.test.ts`：MCP 任意域、任意命令和 extension full runtime。
- `tests/m8/conversation-capability-access.test.ts`：Main Agent 与 worker 的 policy 隔离。
- `tests/m8/system-self-improvement.test.ts`：自动批准后仍需 apply 和验证。

### 兼容策略

- 配置缺失 `access` 时解释为 standard。
- 不修改已有 `task_grants`、budget、credential groups、project grants 和历史 events。
- 不改运行中 operation 的 policy。
- 回退只影响新 operation；已发出的副作用继续走 recovery 和 reconciliation。
- schema migration 只新增字段，不重写历史语义。
- 新 policy 的格式、default 和 typed phrase 应形成 ADR，再进入实现。

## 5. 危险点与测试出口

### 5.1 unrestricted filesystem

必须覆盖：

| 场景 | 期望 |
| --- | --- |
| `.git/config`、worktree `.git` file、hooks | 按 `gitMetadata` policy：protected 时拒绝，writable 时才允许并审计 |
| `.ssh`、`.aws`、`.netrc`、`.git-credentials`、`.env` | credential protect list 默认拒绝读取和写入 |
| Graph `tasks.sqlite`、WAL、app-token、owner lock | graph state protect list 默认拒绝普通 Agent 写入 |
| 路径中的 symlink | 解析到 canonical target；不能通过替换 symlink 改变已批准 grant |
| hardlink overwrite | 保持当前 hardlink 拒绝，除非明显设计出安全的破坏性开关 |
| `/` 作为 mount root | root-aware containment 正确匹配所有绝对路径 |
| 已授权目录被替换成 symlink | 后续 host grant 不能指向新 target |

现有测试形态可参考 `tests/m3/agent-tools.test.ts:28-69`、`tests/m0/restricted-process.test.ts:400-460` 和 `tests/m3/workspace-command.test.ts:107-130`。

### 5.2 unrestricted network

必须证明：

- 任意公共 host 可访问；
- redirect 仍被拒绝；
- response size bound、timeout 和 cancellation 仍生效；
- DNS、mDNSResponder 和 proxy env 不会让其他 operation 继承 unrestricted policy；
- pause 后不再发起新 HTTP/MCP request；
- MCP usage 或零用量 invocation 仍被记录。

### 5.3 Pi extension full host

必须覆盖：

- declared command、read/write、network、local binding 和 Unix socket；
- `allowAppleEvents` 关闭时不能启动宿主应用；
- 开启时明确记录高风险 event；
- extension 仍拿不到 provider key；
- extension 不能修改其他 operation 的 policy；
- extension crash、tool hang 和子进程树清理仍有效。

### 5.4 MCP 任意命令

必须覆盖：

- absolute executable 正常启动；
- bare command 经 host resolver 解析并记录 realpath；
- 不存在或不可执行时 fail closed；
- argv 不经过 shell interpolation；
- environment 只来自 manifest、host allowlist 和 provisioning；
- stdio 输出非 JSON 时只忽略协议外日志，不 eval；
- response 大小、timeout、stderr 和 exit code 可审计。

SRT README 指出允许写 `$PATH` 中的可执行目录、system config 或 shell rc 文件会形成权限提升路径。因此 full filesystem 与 full command 同时开启时，typed phrase 必须明确说明这是宿主级代码执行。

### 5.5 自动批准 system change 的供应链风险

必须证明：

- auto approved proposal 仍写入原 proposal 和 auto decision；
- `apply_system_change` 仍校验 proposal、node、task 和 approval；
- capability bundle 仍先 staging、再 scan、最后 rename；
- literal credential headers 仍拒绝；
- scan 失败不会覆盖旧版本；
- 同 id/version 覆盖仍需要 overwrite 决策；
- apply 失败不把问题标成 resolved；
- 能回退到上一 capability version。

### 5.6 UI 误触

建议的防护：

- standard 与 full 使用明显不同配色和风险文案；
- 输入 typed phrase，例如 `ENABLE FULL HOST ACCESS`；
- 高影响字段不能一个 switch 全部间接开启；
- 开启前显示 effective roots、network、command 和 credential policy；
- 开启事件进入 event log 和 system self-model；
- 回退按钮不需要 typed phrase，但必须说明不会撤销已发出的外部副作用；
- 对 `appleEvents`、credential stores readable、Git metadata writable 使用独立二次确认。

## 6. 建议实施顺序

### P0：完成决策和 ADR

确认本文最后的“关键决策”。尤其需要先决定：

- 完全访问是否允许读取所有 host files；
- 是否接受同用户下凭据与 full path 不可同时保证；
- 是否保留 `.git` 和 Graph state 的 mandatory protection；
- 自动批准是否包含 system change；
- 任务图确认是否仍必须人工完成。

### P1：只做 policy 骨架与 standard 回归

新增 `AccessPolicy`、配置字段、digest、审计和 UI 只读展示。默认 standard 的行为必须与 HEAD 完全一致，不能先改 runtime 行为。

### P2：自动批准与路径 overlay

先实现 `permission` auto grant 和 full read/write policy，再实现 system change auto approval。每步都验证历史 grants、pause、budget、usage 和 recovery 不回归。

### P3：network、commands 和 Pi extension full runtime

最后开启 unrestrict network、host command、local binding、Unix sockets 和 Apple Events。每个高风险子开关独立审计和测试。

### P4：回退演练

在真实 APP 中验证：

- 开启 full 后创建新 operation；
- 暂停后停止新发送；
- 回退 standard 后新 operation 恢复边界；
- 运行中 operation 保留旧 policy；
- 历史 evidence 和 policy digest 可查询；
- 没有静默重写正式状态。

## 7. 关键决策待主线程确认

1. **是否接受方案 A、B 或 C。** 推荐 A：完整工作路径、unrestricted network/capability，但保留 credential stores、Graph state 和 Git metadata 的 mandatory protection。若要求真正绝对 all paths，应选 C，并投入独立 OS identity/container/VM。
2. **`permission` 自动批准是否包含旧 adapter required grant。** 本文建议包含，但记录 bypass，不改写历史 `task_grants`。
3. **`system_change` 是否自动批准。** 本文建议允许，但仍要求后续 Main Agent 调用 `apply_system_change` 和 staging validation。
4. **任务图确认是否自动。** 本文建议不随 access mode 自动，另设独立 `autoConfirmDraft` 决策。
5. **预算策略。** 建议 full mode 只让新 instance 默认 unlimited，不自动追加已有有限预算。
6. **运行中切换。** 建议冻结到 operation；设置变化只影响下一次 admit，避免一条 operation 中途扩大权限。
7. **Apple Events、所有 Unix socket、credential store readable 和 Git metadata writable。** 建议四项独立 high-risk opt-in，不随主开关默认打开。

## 8. 一手来源索引

仓库代码与文档：

- `CONTEXT.md`
- `docs/architecture.md`
- `docs/adr/0008-definition-bound-capability-loading.md`
- `docs/adr/0011-isolated-pi-process-capability-bundles.md`
- `docs/adr/0013-capability-declared-mcp-network.md`
- `docs/adr/0017-unlimited-unknown-usage.md`
- `docs/adr/0018-main-agent-problem-routing.md`
- `docs/adr/0020-main-agent-system-introspection-and-approved-changes.md`
- `docs/adr/0021-capability-binding-default-authorization.md`
- `docs/adr/0022-pi-extension-runtime-declarations.md`
- `docs/adr/0023-mcp-provisioning-runtime-network-split.md`
- `src/core/question-routing.ts`
- `src/core/execution.ts`
- `src/core/operation-lifecycle.ts`
- `src/core/budget-ledger.ts`
- `src/core/task-runtime.ts`
- `src/runtime/agent-tools.ts`
- `src/runtime/bounded-path.ts`
- `src/runtime/workspace-command.ts`
- `src/runtime/restricted-process.ts`
- `src/runtime/capabilities.ts`
- `src/runtime/capability-bundle.ts`
- `src/runtime/mcp-client.ts`
- `src/runtime/pi-process.ts`
- `src/runtime/pi-adapter.ts`
- `src/runtime/controlled-openai.ts`
- `src/runtime/task-gate.ts`
- `src/runtime/model-scheduler.ts`
- `src/runtime/execution-slots.ts`
- `src/server/config.ts`
- `src/server/live-config.ts`
- `src/server/app.ts`
- `src/web/Settings.tsx`

官方上游文档与本地依赖：

- [MCP Transports, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices)
- [Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)
- [Node.js fs documentation](https://nodejs.org/api/fs.html)
- [Git credential storage](https://git-scm.com/docs/gitcredentials)
- `node_modules/@anthropic-ai/sandbox-runtime/README.md`，package version `0.0.75`

