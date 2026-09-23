# B-1 收尾三项独立审查

审查对象：任务分支 `graph/task/eb3eeb92-448b-4dc2-bf8d-a34d71ee5958` 的 HEAD `47deac8`（合并 `impl-model-listing` `eeeff12` 与 `impl-model-step-ux` `9596ff7`）。对照产品线 `bdb577e`。工作区与 HEAD blob 一致（`git hash-object` 与 `git rev-parse HEAD:<path>` 相同，`git diff HEAD` 为空）。

## 结论

三项收尾在实现上成立，B-1 已交付的保证没有被改坏。程序检查均通过。人工验收（桌面窗口填写密钥、真实 opencode 列表）仍留给 `human-accept`，不构成代码缺陷。

## 证据

### ① 密钥指引（方案 A）

- 桌面模式（`bridge` 存在）保留 `type="password"` 的 `provider-key`，只经 `bridge.saveSecret(credentialRef, key)` 写入钥匙串，成功后立刻 `setKey('')`。配置写入只有 `secretRef` / `displayName`。见 `src/web/Settings.tsx` 的 `saveProvider` 与密钥输入分支。
- 浏览器模式渲染 `provider-key-guidance`：文案含「浏览器无法访问系统钥匙串，所以这里没有密钥输入框」，并给出桌面 App 窗口路径与环境变量名。`keyEntryGuidance` 生成 `export <REF>=…`（占位符，不是明文），页面有可复制按钮 `provider-key-copy` 与可见行 `provider-key-export`。见 `src/web/provider-form.ts` `keyEntryGuidance`。
- 探测体 `probePayload` 只带 `credentialRef`，不带密钥。服务端 `sanitizeProviderView` / `platformCatalogView` 只回 `secretRef` 与布尔 `resolved`/`credentialConfigured`。`/api/app/secret` 仍在既有 app-token 钩子之后，本轮没有新增密钥通道。
- 样式只加了 `.key-guidance` / `.model-vendor-picker`，没有新依赖。

### ② 选择模型自带厂商下拉

- `modelVendorsFrom` 只收 `credentialConfigured === true` 的平台，以及配置 `credentials` 里已有的 id。未配置平台不进入数组（完全隐藏，不是置灰）。空列表时下拉 `disabled`，并显示「还没有已配置凭据的厂商：请先在「① 配置厂商」保存一次。」选项文案为「`label · 已有 N 个`」。
- 选中变化走 `useEffect([selectedVendorId, vendors])` + `autoProbeDecision`：没有 `baseUrl` 不发请求、也不记为已拉取；真正发出后才 `probedVendor.current = id`，同一厂商后续渲染不再请求。保留「重新获取」与「手动添加」。
- `draftFromModelVendor` 对所有厂商都带该厂商自己的 `baseUrl`/`api`（预设端点，或该凭据已有模型条目的端点），不再写空串、也不回落到①卡片草稿。
- `runProbe` 的 catch 在 `updateList` 时写入 `probeFailureNote(message)`（含原始错误与「可手动添加模型 id」），只在新请求开始时把 note 设为「正在请求厂商接口…」。厂商 HTTP 非 2xx 由 `parseModelsResponse` 收成 `modelsError`，探测路由仍 200 返回，页面走成功分支把 `modelsError` 写进 note，不会被 `api()` 丢掉。
- 勾选后 `buildEntryDraft` + `metadataToFields`：无快照时 `pricing.status=unknown`，卡片文案是「价格未知（pricing.status=unknown，不会按 0 计算）」，不是 0。

### ③ opencode 自动拉模型

- `PLATFORM_PRESETS` 中 `opencode-go.modelsListSupported` 已是 `true`，`x-opencode-session` 头保留。command-goat / grok / chatgpt / deepseek / custom 仍为 `true`，没有被改成 false。
- `runProviderProbe` 使用 `wantModels = shouldProbeModels(probeModels)`，即只有显式 `probeModels: false` 才跳过 `/models`。`modelsListSupported` 不再参与闸门，只留作文案（`!selected.modelsListSupported` 时提示「仍会尝试请求并以厂商响应为准」）。
- `buildModelsRequest` 仍是 `GET <baseUrl>/models`。非 2xx 经 `vendorErrorText` 原样进入 `modelsError`。无列表时验证仍按「有 verifyModel 就发最小 chat，否则 skipped 文案」，手动 `modelId` + `probeModels: false` 路径仍被 `validateProbeRequest` 接受。
- 前端 `FALLBACK_PLATFORMS` 的 opencode 也是 `modelsListSupported: true`，离线目录与服务端一致。

### B-1 既有保证

- 「保存并验证」仍 `POST /api/providers/probe`，并在有候选模型时带 `modelId` 发最小 chat；`updateList: false` 避免覆盖②的列表 note。
- 并发上限仍在厂商卡片内（`provider-concurrency`，id 由 `concurrencyControlIds` 派生）。`ADVANCED_SETTINGS` 仍为空数组，导航顺序未改。
- 被拒编辑仍走既有 autosave / revision 路径，本轮没有改 `persistDraft` 的冲突处理。
- `tests/m8/settings-ui.test.ts` 保留：保存并验证发出真实请求、页面不含密钥明文、内联并发持久化、被拒编辑不覆盖文档；并断言选中厂商后桩服务立刻收到 `/v1/models`、未配置厂商不在下拉、未知价格显示「价格未知」。该文件不在 `check-model-step` 的运行清单里（该检查只跑 provider-form 与 settings-sections），但其源码断言仍在，且任务说明浏览器行为由主 Agent 现场自验覆盖。

### 文件范围与检查

- 相对 `bdb577e` 的代码 diff 只在车道清单内：`src/server/app.ts`、`src/server/providers.ts`、`src/web/Settings.tsx`、`src/web/provider-form.ts`、`src/web/styles.css`、`tests/console/provider-api.test.ts`、`tests/console/provider-form.test.ts`、`tests/m8/settings-ui.test.ts`。另有既有 `reviews/b1-followup-review.md`，不是实现文件。没有改 `package.json`、IPC、Electron、Pi SDK 或配置格式。
- `check-types` exit 0；`check-listing-rules` 29 passed；`check-model-step` 57 passed。

## 非阻断观察

- `tests/console/provider-api.test.ts` 对「handler 不再硬闸门」用的是源码字符串断言（`shouldProbeModels(probeModels)` 存在、旧表达式不存在），不是直接调用 `runProviderProbe`。闸门函数本身与 `app.ts` 调用点已人工核对，字符串断言只是防回归钉，不构成失败。
- 自定义凭据若配置里有条目、但还没有任何带 `baseUrl` 的模型，②会显示「还没有可用的端点地址」并禁用拉取/手动添加，直到①保存了 Base URL。这与返工要求「没有 baseUrl 只显示原因、不发请求」一致。
- 浏览器指引的「一键复制」依赖 `navigator.clipboard`；失败时 toast 提示手动复制，且 export 行本身始终可见。

## 判定

pass。代码侧三项收尾成立，且没有削弱 B-1 已交付的保存验证、secretRef-only、内联并发与被拒编辑不覆盖文档。真实桌面窗口与 opencode 现场列表留给人工验收。
