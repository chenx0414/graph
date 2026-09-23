# B-1 收尾三项独立审查

Verdict: fail

审查对象是集成提交 `e5f0a0b21256c064c529d45a84e02c398bf4cbb3` 相对 `bdb577e955ed0ff9eb4995a46ab00e559996b02a` 的 diff。工作区干净，变更只落在两条车道列出的 8 个文件。

## 程序检查

- `check-types`（`0f36bda3`）退出码 0。
- `check-listing-rules`（`3c9dc035`）`tests/console/provider-api.test.ts` 29 通过。
- `check-model-step`（`1f95994d`）`provider-form.test.ts` + `settings-sections.test.ts` 53 通过。
- `tests/m8/settings-ui.test.ts` 不在上述检查输入里，本次审查只做源码核对，没有运行它。

## 已成立的部分

1. `src/server/providers.ts` 中 `opencode-go` 的 `modelsListSupported` 已改为 `true`，`x-opencode-session` 头保留。其它预设仍为 `true`，没有被猜测改成 `false`。
2. `src/server/app.ts` 的 `runProviderProbe` 用 `shouldProbeModels(probeModels)` 决定是否请求 `/models`。该函数只在 `probeModels === false` 时返回 false，不再读取 `provider.modelsListSupported`。非 2xx 仍走 `parseModelsResponse` → `vendorErrorText`，原始错误进入 `modelsError`；`probeModels:false` 仍可带 `modelId` 做验证。
3. 浏览器模式密钥卡说明了没有钥匙串通道的原因，给出桌面 App 路径和 `export <REF>=…`（可复制，值为占位符）。桌面路径仍是 `type="password"`，保存只走既有 `bridge.saveSecret`，配置只写 `secretRef`。没有新增密钥接口或明文落盘。
4. 「② 选择模型」下拉由 `modelVendorsFrom` 生成，未配置厂商不出现；空列表有指定文案并禁用下拉。勾选后仍走 `lookupSnapshot` / `metadataToFields`，卡片未知价格文案仍是「价格未知（pricing.status=unknown，不会按 0 计算）」。
5. B-1 的保存并验证、内联并发、被拒编辑不覆盖文档、密钥不进页面，在 `tests/m8/settings-ui.test.ts` 的断言里仍然存在，源码路径也没有被删掉。

## 缺陷

### 1. 选中厂商后自动拉取会在列表尚未就绪时被永久跳过

位置：`src/web/Settings.tsx` 约 516–524 行。

```tsx
useEffect(() => {
  if (!shouldAutoProbe(selectedVendorId, probedVendor.current)) return;
  const vendor = vendors.find(item => item.id === selectedVendorId);
  if (!vendor) return;
  probedVendor.current = selectedVendorId;
  void runProbe(draftFromModelVendor(vendor), { verification: false });
}, [selectedVendorId]);
```

`probedVendor.current` 在 `runProbe` 之前就被写成当前 id，而 effect 只依赖 `selectedVendorId`。因此只要这次 effect 运行时 `vendors` 里还没有该 id，函数直接返回，并且之后 `shouldAutoProbe` 会一直返回 false。厂商列表随后到来也不会再发 `/models`。

真实触发路径：

- 页面用 `FALLBACK_PLATFORMS` 启动，其中 `credentialConfigured` 只有自定义项为 `false`。
- `GET /api/providers` 是异步的（同组件约 413–421 行）。在它返回前，`modelVendorsFrom(draft, platforms)` 只能看见配置里的 `credentials` 键，看不见「凭据已解析但配置里还没有该 id」的厂商。
- 目录返回后，`credentialConfigured === true` 的厂商（包括已配置的 opencode-go）才会进入下拉。
- 用户在目录返回前选中一个已在配置里的厂商：effect 找不到 vendor，记下 id，不发请求。目录返回后下拉内容变了，但选中值没变，effect 不再跑。
- 用户在目录返回后选中一个只因 `credentialConfigured` 才出现的厂商：若 effect 闭包里的 `vendors` 仍是上一轮（React 不保证 effect 与这次 render 的 `vendors` 同步，且依赖数组没有 `vendors`），同样记成已拉取并跳过。

这直接违反「选中某个厂商后自动拉取它的可用模型列表」。失败不是显示厂商错误，而是静默不发请求；用户只能发现列表没来再点「重新获取」。`shouldAutoProbe` 的单测只覆盖纯函数，没有覆盖这个接线，所以 `check-model-step` 通过不能证明选中即拉取成立。

影响：已配置厂商（含 opencode）在设置页的主路径上仍可能根本不请求 `/models`，与本次要修的「不要因为本地假设跳过请求」同类。

### 2. 自定义厂商选中后，自动拉取与「重新获取」发出的是没有 Base URL 的探测

位置：

- `src/web/provider-form.ts` `draftFromModelVendor`（约 310–320 行）：`platformId === 'custom'` 时才带 `label` 和 `baseUrl`；命名预设故意留空，交给服务端预设。
- `src/web/provider-form.ts` `modelVendorsFrom`（约 290–303 行）：只要 `platformById` 命中且不是 `custom`，就用预设的 `baseUrl`，并把 `platformId` 设为该预设 id。
- `src/web/Settings.tsx` 约 521 行与 680 行都用这个 draft 调 `runProbe`。

自定义厂商的凭据 id 可以与预设 id 相同（`①` 的凭据 id 可编辑）。保存后配置里会有 `credentials.opencode-go`（或 grok 等），但端点是用户填的自定义 Base URL。`modelVendorsFrom` 看到目录里有同名预设，就把该凭据标成命名预设：`platformId` 变成 `opencode-go`，`baseUrl` 变成 `https://opencode.ai/zen/go/v1`，用户保存的地址被丢掉。随后 `draftFromModelVendor` 对命名预设又把 `baseUrl` 置空。服务端 `validateProviderDraft` 对命名预设会回填预设地址，于是自动拉取打到预设端点，而不是该凭据实际保存的端点。

若目录里没有这个 id（用户自定 id，或目录尚未返回），`platformId` 才是 `custom`。此时 `baseUrl` 只从 `models.entries` 里找。还没有模型的已配置自定义厂商 `baseUrl` 为空。页面会显示「请先在①填写并保存 Base URL」并禁用「重新获取」，但自动拉取的 effect 不看 `vendorBlockedReason`，仍会 `runProbe`。`probePayload` 会 POST `baseUrl: ""`，daemon 校验失败，`runProbe` 的 catch 在 `updateList` 时执行 `setNote('')`，把「正在请求厂商接口…」清掉，不显示厂商/校验错误。用户看到的是空 note 和被禁用的「重新获取」，选中并没有拉到模型，也没有原始错误。

这违反「选中即自动拉取可用模型列表；失败时显示厂商原始错误文案」。自定义厂商是 B-1 已交付的配置路径，不能只按预设 id 处理。

## 未削弱、但不足以抵消上述缺陷的点

- 服务端闸门本身是对的：显式 `probeModels:false` 才跳过，失败文本原样返回。
- 密钥指引文案和「不新增通道、不落明文」成立。
- 未知价格不会显示 0。
- diff 没有新增依赖，没有改 IPC、Electron、Pi SDK 或配置格式。

## 结论

服务端「opencode 不再被本地标记挡住」成立，但设置页「选中即拉取」在两条真实路径上不成立：厂商列表晚于选中到达时请求被永久跳过；自定义/同名凭据会被发到错误端点或空端点，且失败文案被清掉。因此三项收尾不能算全部成立。
