# U04 供应商 transport 与模型/价格目录：实施与验证报告

日期：2026-09-15。分支 `feat/unified-console`。前置 `afe9242`（U03）。

## 交付内容

- **transport 白名单**：`ModelApi = 'openai-completions' | 'anthropic-messages'`。配置解析只接受这两者；同一 provider 标签必须共享 endpoint、凭据与 api，避免同名模型串路由。其余平台（Gemini 兼容、DeepSeek、OpenRouter、自定义本地）统一走已验证的 openai-completions；未验证协议不写入配置。
- **Anthropic 原生 Messages**：`controlledOpenAIStream(gate, key, slot, api)` 按 api 调用 Pi 公开 SDK 的 `streamSimple`（`@earendil-works/pi-ai/api/anthropic-messages`），复用同一调用门、凭据槽、重试/未发送判定与 usage 归一化。usage 解析区分协议：OpenAI 的 prompt/completion/cached；Anthropic 的 `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`，缺 usage 结算为 unknown 而不是零。Anthropic 的 baseUrl 是 host 根（SDK 追加 `/v1/messages`），模板已按此设置。
- **连接测试**：`/api/config/test` 按 api 选择 endpoint 与认证头（Anthropic 用 `x-api-key` + `anthropic-version`），仍是显式按钮触发，不在保存/刷新时偷发调用。
- **价格目录**：`ModelPricing{currency, unit:'per_million_tokens', sourceUrl, retrievedAt, catalogRevision, status}`；`estimateCost` 输出 `{amount, currency, unit, priceRevision}` 并冻结进 invocation 的 cost JSON。缺价格显示未知，免费价是带来源的真实 0；价格刷新只影响新 invocation，历史快照不被重写（测试对照）。
- **供应商模板**：`src/catalog/providers.ts` 提供 openai / anthropic / gemini / deepseek / openrouter / custom 六类模板，包含 docs 链接、key 引用提示与边界说明；没有可核实来源的模板不带价格（unknown），不硬编码未经核查的实时价格。`templateModelEntry` 供 U05 向导生成配置。

## 验证

- `tsc` 主/Web、`vite build`、`vitest run`：62 → 64 文件 / 314 项通过。
- `tests/console/anthropic-transport.test.ts`（4 项）：原生请求形状（`/v1/messages`、`x-api-key`、无 Authorization）、assistant 文本流、缓存用量归一化（25/7/10/5）、缺 usage → null、HTTP 400 → unknown 且不伪造零；模板 transport 白名单与“无来源不带价格”校验。
- `tests/console/pricing.test.ts`（2 项）：单位换算手算对照、免费价为零、无价格未知；真实 daemon 两次调用跨价格刷新：旧 invocation 保留 r1 金额与币种，新 invocation 使用 r2。
- 原始输出：`acceptance-evidence/unified-console/u04/verification.output.txt`。

## 边界与后续

- 未运行真实付费供应商冒烟：Gemini/DeepSeek/OpenRouter 的兼容行为、Anthropic 的真实工具往返与多轮，均须在 U11 用指定测试凭据单独记录；未测不标“官方已验证”。
- Responses-only 的 OpenAI 模型仍未支持；OAuth 与企业身份不在本轮。
- `openrouter/auto` 等目录模型的价格保持 unknown，刷新接口与来源标注随 U05/U10 提供。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/vitest run tests/console/anthropic-transport.test.ts tests/console/pricing.test.ts
```
