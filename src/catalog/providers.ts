import type { ModelApi, ModelGrade, ModelInput, ModelPricing } from './models.ts';
import { snapshotFor, snapshotPricing } from './price-snapshot.ts';

/** One first-class connection template: a provider label, the transport Graph
 * has verified for it and a small set of model defaults. Templates are not
 * "official support" by themselves; a transport counts only after the contract
 * tests in this round pass. Prices are intentionally absent unless a verified
 * snapshot exists, so unknown never becomes zero. */
export interface ProviderTemplateModel {
  id: string;
  grade: ModelGrade;
  contextWindow: number;
  maxTokens: number;
  input?: ModelInput[];
  /** Set only with a verifiable source; absent means the price is unknown. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  pricing?: ModelPricing;
}

export interface ProviderTemplate {
  id: string;
  label: string;
  api: ModelApi;
  baseUrl: string;
  credentialRefHint: string;
  docsUrl: string;
  /** Boundaries the wizard must state, for example compatibility modes. */
  notes: string[];
  models: ProviderTemplateModel[];
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    credentialRefHint: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    notes: ['API key 登录；本轮只启用 Chat Completions 传输。仅支持 Responses 的模型需另行验收后才会标注可用。'],
    models: [
      { id: 'gpt-4o', grade: 'highest', contextWindow: 128_000, maxTokens: 16_384, input: ['text', 'image'] },
      { id: 'gpt-4o-mini', grade: 'medium', contextWindow: 128_000, maxTokens: 16_384, input: ['text', 'image'] },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    api: 'anthropic-messages',
    // The Messages transport appends /v1/messages to the host root.
    baseUrl: 'https://api.anthropic.com',
    credentialRefHint: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://platform.claude.com/docs/en/api/overview',
    notes: ['API key 登录；使用原生 Messages 传输，不复用 OpenAI 请求格式。'],
    models: [
      { id: 'claude-sonnet-4-5', grade: 'highest', contextWindow: 200_000, maxTokens: 8_192, input: ['text', 'image'] },
      { id: 'claude-haiku-4-5', grade: 'medium', contextWindow: 200_000, maxTokens: 8_192, input: ['text', 'image'] },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    api: 'openai-completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    credentialRefHint: 'GEMINI_API_KEY',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    notes: ['使用官方 OpenAI 兼容模式；工具与用量按兼容层实际行为验收后才算可用。'],
    models: [
      { id: 'gemini-2.0-flash', grade: 'medium', contextWindow: 1_048_576, maxTokens: 8_192, input: ['text', 'image'] },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    credentialRefHint: 'DEEPSEEK_API_KEY',
    docsUrl: 'https://api-docs.deepseek.com/guides/function_calling',
    notes: ['使用官方兼容传输；以厂商实际支持的字段与契约为准。'],
    models: [
      { id: 'deepseek-flash', grade: 'high', contextWindow: 1_048_576, maxTokens: 65_536 },
      { id: 'deepseek-v4-pro', grade: 'highest', contextWindow: 1_048_576, maxTokens: 65_536 },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    credentialRefHint: 'OPENROUTER_API_KEY',
    docsUrl: 'https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties',
    notes: ['兼容传输；模型目录与价格随路由变化，需刷新并从来源标注，不覆盖历史费用。'],
    models: [
      { id: 'openrouter/auto', grade: 'high', contextWindow: 128_000, maxTokens: 8_192 },
    ],
  },
  {
    id: 'custom',
    label: '自定义兼容平台 / 本地服务',
    api: 'openai-completions',
    baseUrl: '',
    credentialRefHint: 'GRAPH_LOCAL_KEY',
    docsUrl: '',
    notes: ['高级入口：端点、模型与可选 key；不宣称支持任意协议。无 key 的本地服务不要填伪密钥。'],
    models: [],
  },
];

// Attach only archived, source-dated prices. Models without a verified entry
// keep `cost`/`pricing` absent so the wizard shows "价格未知" instead of zero.
for (const template of PROVIDER_TEMPLATES) {
  for (const model of template.models) {
    const snapshot = snapshotFor(template.id, model.id);
    if (!snapshot) continue;
    model.cost = { ...snapshot.cost };
    model.pricing = snapshotPricing(snapshot);
  }
}

export function providerTemplate(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find(template => template.id === id);
}

/** Config entry for one template model; unknown prices stay absent. */
export function templateModelEntry(template: ProviderTemplate, model: ProviderTemplateModel, credentialId: string): Record<string, unknown> {
  return {
    id: model.id,
    provider: template.id,
    grade: model.grade,
    api: template.api,
    baseUrl: template.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.input ? { input: model.input } : {}),
    credentialId,
    ...(model.cost ? { cost: model.cost } : {}),
    ...(model.pricing ? { pricing: model.pricing } : {}),
  };
}

/** Shared directory for setup, the settings workbench and the HTTP catalog.
 * A subscription token is deliberately not advertised as an OAuth login. */
export interface ProviderPreset {
  id: string;
  label: string;
  api: ModelApi;
  baseUrl: string;
  credentialRef: string;
  credentialKind: 'api-key' | 'subscription';
  oauthProvider?: 'openrouter';
  modelsListSupported: boolean;
  docsUrl?: string;
  headers?: Record<string, string>;
  notes: string[];
}

const SUBSCRIPTION_PRESETS: ProviderPreset[] = [
  { id: 'opencode-go', label: 'OpenCode Go', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', credentialRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY', credentialKind: 'subscription', modelsListSupported: true, headers: { 'x-opencode-session': 'graph-console' }, docsUrl: 'https://opencode.ai/docs/zen', notes: ['订阅凭据；所有请求自动附带 x-opencode-session。'] },
  { id: 'command-goat', label: 'Command Goat', api: 'openai-completions', baseUrl: 'https://api.commandcode.ai/provider/v1', credentialRef: 'GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY', credentialKind: 'subscription', modelsListSupported: true, notes: ['订阅访问令牌；请从自己的服务商账户获取凭据。'] },
  { id: 'grok', label: 'Grok', api: 'openai-completions', baseUrl: 'https://api.x.ai/v1', credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN', credentialKind: 'subscription', modelsListSupported: true, notes: ['订阅访问令牌；使用 xAI 的 OpenAI 兼容端点。'] },
  { id: 'chatgpt', label: 'ChatGPT', api: 'openai-completions', baseUrl: 'https://chatgpt.com/backend-api/codex', credentialRef: 'GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN', credentialKind: 'subscription', modelsListSupported: true, notes: ['订阅访问令牌；Responses 协议适配尚未完成，登录或配置凭据不代表模型可调用，请先验证连接。'] },
];

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  ...SUBSCRIPTION_PRESETS,
  ...PROVIDER_TEMPLATES.map(template => ({
    id: template.id,
    label: template.label,
    api: template.api,
    baseUrl: template.baseUrl,
    // Preserve the reference already used by the settings workbench.
    credentialRef: template.id === 'deepseek' ? 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY'
      : template.id === 'custom' ? 'GRAPH_PROVIDER_API_KEY' : template.credentialRefHint,
    credentialKind: 'api-key' as const,
    ...(template.id === 'openrouter' ? { oauthProvider: 'openrouter' as const } : {}),
    modelsListSupported: true,
    docsUrl: template.docsUrl,
    notes: template.notes,
  })),
];

export function providerPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(preset => preset.id === id);
}
