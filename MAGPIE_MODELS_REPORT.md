# Magpie 模型接入 Graph 模型选择

## 改了什么

- 后端新增动态 Magpie 模型目录 `backend/internal/graph/magpie_models.go`：
  - 从 Magpie gateway 的 `/v1/models` 读取模型，不写死 provider/model 名称；
  - 只保留 `configured && !off` 的 provider；
  - 模型 ID 使用 `provider:gateway模型ID`（例如 `codex:codex/gpt-6.1-sol`），`provider` 字段保留 Magpie 的 `owned_by`；
  - 模型条目保留 gateway 的上下文窗口、最大输出、输入模态和 reasoning 默认档位；
  - 合并时保持 Graph 原有模型在前，ID 冲突时 Graph 模型优先，不会被 Magpie 覆盖；
  - 模型请求使用 Magpie gateway 的 `/v1` 地址和原始 model ID，凭据 ID 为 `magpie`。
- `TaskRuntime` 接入模型目录：`liveEntries()` / `liveConfiguredEntries()` 会附加 Magpie 模型，`liveCredentialFor()` 为 Magpie 模型绑定 gateway 凭据，选择模型后继续走现有 `SelectModel` 和 Pi 请求链路。
- `/api/settings` 因此会同时返回 Graph 原有模型和 Magpie 模型；`/api/providers/magpie` 刷新供应商时也会刷新模型缓存。
- 应用侧模型选择：
  - 读取 settings 里的 `provider`，按 provider 过滤不再依赖从 ID 猜前缀；
  - 供应商页点击「用 X 的模型」后，模型选择器按该 provider 过滤；
  - 刷新供应商时清空模型和模型元数据缓存，下一次模型选择会重新读取；
  - 选择 Magpie 模型后 POST 的 `model` 就是该 Magpie 模型 ID，会话状态显示所选模型。
- 启动时在 daemon 中注入 `NewMagpieModels()`；未配置 Magpie 或 gateway 不可达时返回空列表，不影响 Graph 原有模型。

## 怎么用

1. 保持 Magpie gateway 运行，或设置 `GRAPH_MAGPIE_DIR` 指向测试用 Magpie 配置目录。
2. 打开 Graph 的「供应商」页，确认目标 provider 已连接/未关闭。
3. 点击「用 X 的模型」，模型选择器会列出该 provider 的 Magpie 模型。
4. 选择模型后，会话状态显示该模型，下一轮请求走 Magpie gateway。
5. 需要 gateway key 时可设置 `MAGPIE_API_KEY`；未设置时使用本地占位值，不读取或修改真实 Magpie 凭据。

## 验证命令

```text
go -C app test
go -C backend test ./...
go -C backend run ./cmd/graphcheck all
```

结果：

- `go -C app test`：`ok graph/app`
- `go -C backend test ./...`：全部包 `ok`
- `go -C backend run ./cmd/graphcheck all`：`[check] ok`，包含 build、vet、backend/app 测试、comments、tokens、ownership、api、machines、harness、evidence

## 证据

- 后端模型映射与过滤：
  - `TestTheMagpieModelsBecomeGraphModelsForEnabledProviders`
  - `TestAMagpieModelIdIsProviderPrefixedAndNeverReplacesAGraphModel`
  - `TestTheSettingsModelListOffersMagpieModelsNextToTheGraphOnes`
- 刷新与缓存：
  - `TestTheMagpieModelListFollowsAProviderRefresh`
  - `TestRefreshingProvidersLoadsTheNewMagpieModelList`
- 本地假 gateway 请求：
  - `TestAMagpieTurnSendsTheGatewayModelIdAndKey`：假 gateway 收到 `"model":"codex/gpt-6.1-sol"` 和 `Bearer <magpieAPIKey()>`，不调用付费模型。
- 选择会话：
  - 后端 `TestARuntimeSelectsAMagpieModelAndBindsTheGateway`
  - 应用 `TestAProviderRowLeadsToItsModelInTheSession`、`TestChoosingAMagpieModelSendsItsID`
- 共 12 个 Magpie 相关测试，全部通过。

## 已知限制

- gateway 的 `/v1/models` 使用 2 秒超时；Magpie 不可达时首次 settings 读取会短暂等待，然后只显示 Graph 自己的模型。
- 只展示 Magpie 中已配置且未关闭的 provider 的模型。
- Magpie 模型 ID 与 Graph 原模型 ID 相同时由 Graph 原模型优先，Magpie 同 ID 模型不会重复出现。
- reasoning 档位按 gateway 返回的 `reasoning_levels` 推断，未覆盖时默认 `medium`。
