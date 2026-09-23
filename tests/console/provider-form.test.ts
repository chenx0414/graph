/**
 * Sandbox-safe tests for the B-1 provider form logic.
 *
 * Everything here is pure: request construction, response/merge handling,
 * snapshot mapping, required-field gating and concurrency read-back. No DOM, no
 * sockets, no child processes — real network probing and browser behaviour are
 * covered by the human acceptance check.
 *
 * The field names mirror the daemon contract in src/server/providers.ts:
 * `label` (not `name`) and `credentialRef` (not `secretRef`), plus `requestId`
 * on every probe POST.
 */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PLATFORMS,
  addManualModelPick,
  buildEntryDraft,
  customDraft,
  draftFromPlatform,
  draftToModelEntry,
  fillEntryFromMetadata,
  hasProviderErrors,
  hasRequiredModelFields,
  mergeProbeModels,
  metadataToFields,
  missingRequiredModelFields,
  modelFieldErrors,
  normalizePlatforms,
  parseLimit,
  platformById,
  platformsRequest,
  probeRequest,
  readConcurrency,
  selectedProbeModels,
  selectionBlockedReason,
  validateProviderDraft,
  writeConcurrency,
  type ConcurrencyConfig,
} from '../../src/web/provider-form.ts';
// @ts-ignore -- .tsx import from a NodeNext test program
import { ADVANCED_SETTING_IDS } from '../../src/web/Settings.tsx';

const preset = FALLBACK_PLATFORMS[0]!;

describe('provider draft validation (step 1)', () => {
  it('accepts a supported platform with just a key', () => {
    expect(validateProviderDraft(draftFromPlatform(preset), { custom: false, hasKey: true })).toEqual({});
  });

  it('requires a key (or a resolvable credential) even for a supported platform', () => {
    const errors = validateProviderDraft(draftFromPlatform(preset), { custom: false, hasKey: false });
    expect(errors.key).toMatch(/API KEY|环境变量/);
    expect(hasProviderErrors(errors)).toBe(true);
  });

  it('requires label, base URL, compatibility and key for a custom provider', () => {
    const errors = validateProviderDraft(customDraft(), { custom: true, hasKey: false });
    expect(errors.label).toBe('自定义厂商必须填写厂商名');
    expect(errors.baseUrl).toMatch(/Base URL/);
    expect(errors.key).toMatch(/API KEY/);
  });

  it('rejects a non-http base URL and an unknown compatibility mode', () => {
    const errors = validateProviderDraft(
      { ...customDraft(), label: '本地网关', baseUrl: 'ftp://example.com', api: 'responses' as never },
      { custom: true, hasKey: true },
    );
    expect(errors.baseUrl).toMatch(/http/);
    expect(errors.api).toMatch(/兼容格式/);
  });

  it('rejects malformed credential ids and credential refs with the daemon wording', () => {
    const errors = validateProviderDraft(
      { ...customDraft(), label: '网关', baseUrl: 'https://api.example.com/v1', credentialId: 'Bad Id', credentialRef: '1-bad' },
      { custom: true, hasKey: true },
    );
    expect(errors.credentialId).toMatch(/凭据 id/);
    expect(errors.credentialRef).toBe('credentialRef 必须是环境变量名');
  });
});

describe('platform catalog normalization', () => {
  it('reads { platforms, credentials } and keeps credentialConfigured / credentialRef', () => {
    const payload = {
      platforms: [
        { id: 'grok', label: 'Grok', api: 'openai-completions', baseUrl: 'https://api.x.ai/v1', credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN', credentialKind: 'subscription', modelsListSupported: true, credentialConfigured: false },
        { id: 'custom', label: '自定义', api: 'openai-completions', baseUrl: '', credentialRef: 'GRAPH_PROVIDER_API_KEY', credentialKind: 'api-key', modelsListSupported: true, custom: true, credentialConfigured: false },
      ],
      credentials: {},
    };
    const platforms = normalizePlatforms(payload);
    expect(platforms[0]).toMatchObject({ id: 'grok', credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN', credentialConfigured: false, modelsListSupported: true });
    expect(platforms[1]).toMatchObject({ id: 'custom', custom: true, baseUrl: '', credentialRef: 'GRAPH_PROVIDER_API_KEY' });
  });

  it('keeps the built-in custom entry even when the daemon list omits it', () => {
    expect(normalizePlatforms([{ id: 'custom', label: '自定义', baseUrl: '', api: 'openai-completions', credentialRef: 'GRAPH_PROVIDER_API_KEY' }])[0]).toMatchObject({ custom: true });
  });

  it('drops entries without an id instead of crashing', () => {
    expect(normalizePlatforms({ platforms: [{ id: '', baseUrl: 'https://x' }, { label: 'no id' }, null] })).toEqual([]);
  });

  it('keeps the built-in credential environment variable names aligned with usage', () => {
    expect(platformById(FALLBACK_PLATFORMS, 'opencode-go')!.credentialRef).toBe('GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY');
    expect(platformById(FALLBACK_PLATFORMS, 'chatgpt')!.credentialRef).toBe('GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN');
    expect(platformById(FALLBACK_PLATFORMS, 'opencode-go')!.modelsListSupported).toBe(false);
  });
});

describe('probe request/response handling (step 2)', () => {
  it('targets the console /api/providers path and always carries a requestId', () => {
    expect(platformsRequest().url).toBe('/api/providers');
    const draft = draftFromPlatform(preset);
    const request = probeRequest(draft, 'probe-123', 'gpt-5');
    expect(request.url).toBe('/api/providers/probe');
    expect(request.init.method).toBe('POST');
    const body = JSON.parse(request.init.body) as { requestId: string; modelId?: string; provider: Record<string, unknown> };
    expect(body.requestId).toBe('probe-123');
    expect(body.modelId).toBe('gpt-5');
    // (a) the display name is `label`, never `name`, and the ref is `credentialRef`.
    expect(body.provider).toMatchObject({ id: 'opencode-go', label: 'OpenCode Go', api: 'openai-completions', credentialRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY' });
    expect(body.provider).not.toHaveProperty('name');
    expect(body.provider).not.toHaveProperty('secretRef');
    expect(request.init.body).not.toMatch(/sk-/);
    expect(JSON.parse(probeRequest(draft, 'probe-456').init.body)).not.toHaveProperty('modelId');
  });

  it('merges a probed list without overwriting the user’s existing picks', () => {
    const previous = [
      { modelId: 'manual-model', selected: true, manual: true },
      { modelId: 'gpt-5', selected: true },
    ];
    const merged = mergeProbeModels([{ id: 'gpt-5', name: 'GPT-5' }, { id: 'o4-mini', name: 'o4-mini' }], previous);
    expect(merged.map(pick => pick.modelId)).toEqual(['manual-model', 'gpt-5', 'o4-mini']);
    expect(merged[0]).toMatchObject({ selected: true, manual: true });
    expect(merged[1]).toMatchObject({ selected: true });
    expect(merged[2]).toMatchObject({ selected: false });
    expect(selectedProbeModels(merged).map(pick => pick.modelId)).toEqual(['manual-model', 'gpt-5']);
  });

  it('lets the endpoint without a model list keep manual ids', () => {
    const first = addManualModelPick([], 'local-llama');
    const second = addManualModelPick(first, 'local-llama');
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ modelId: 'local-llama', selected: true, manual: true });
  });
});

describe('snapshot metadata mapping', () => {
  it('fills every field when the snapshot hits', () => {
    const fields = metadataToFields({
      contextWindow: 200_000,
      maxTokens: 8_192,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevels: ['low', 'medium', 'high'],
      defaultThinkingLevel: 'medium',
      grade: 'high',
      cost: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.875 },
      currency: 'USD',
      sourceUrl: 'https://models.dev/api.json',
    });
    expect(fields).toMatchObject({
      contextWindow: 200_000,
      maxTokens: 8_192,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevels: ['low', 'medium', 'high'],
      defaultThinkingLevel: 'medium',
      grade: 'high',
      cost: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.875 },
    });
    expect(fields.pricing).toMatchObject({ currency: 'USD', unit: 'per_million_tokens', status: 'known' });
  });

  it('leaves an unmatched model blank and marks pricing unknown — never zero', () => {
    const fields = metadataToFields(null);
    expect(fields.contextWindow).toBeNull();
    expect(fields.maxTokens).toBeNull();
    expect(fields.cost).toBeNull();
    expect(fields.pricing.status).toBe('unknown');
    expect(fields.grade).toBeNull();
    expect(buildEntryDraft({ id: 'x', provider: 'p', baseUrl: 'https://x/v1', api: 'openai-completions', credentialId: 'c', modelId: 'unknown-model', metadata: null })).not.toHaveProperty('cost');
  });

  it('marks pricing unknown when the model matched but has no usable price', () => {
    const fields = metadataToFields({ contextWindow: 128_000, maxTokens: 4_096, reasoning: true });
    expect(fields.contextWindow).toBe(128_000);
    expect(fields.cost).toBeNull();
    expect(fields.pricing.status).toBe('unknown');
    expect(JSON.stringify(fields)).not.toContain('"input":0');
  });

  it('never invents thinking levels that the catalog does not declare', () => {
    const fields = metadataToFields({ reasoning: true, thinkingLevels: ['low', 'bogus'], defaultThinkingLevel: 'bogus' });
    expect(fields.thinkingLevels).toEqual(['low']);
    expect(fields.defaultThinkingLevel).toBeNull();
  });

  it('converts a fully known selection into the existing ModelEntry shape', () => {
    const draft = buildEntryDraft({
      id: 'deepseek:v3', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', api: 'openai-completions', credentialId: 'deepseek',
      modelId: 'deepseek-v3',
      metadata: { contextWindow: 64_000, maxTokens: 8_192, input: ['text'], reasoning: true, defaultThinkingLevel: 'low', grade: 'medium', cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 }, currency: 'USD' },
    });
    const entry = draftToModelEntry(draft);
    expect(entry).toMatchObject({ id: 'deepseek:v3', modelId: 'deepseek-v3', contextWindow: 64_000, maxTokens: 8_192, grade: 'medium' });
    expect(entry.cost).toEqual({ input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 });
    expect(entry.pricing?.status).toBe('known');
  });

  it('omits unknown context/output instead of inventing positive numbers', () => {
    const draft = buildEntryDraft({ id: 'x', provider: 'p', baseUrl: 'https://x/v1', api: 'openai-completions', credentialId: 'c', modelId: 'm', metadata: null });
    const entry = draftToModelEntry(draft);
    expect(entry).not.toHaveProperty('contextWindow');
    expect(entry).not.toHaveProperty('maxTokens');
    expect(entry).not.toHaveProperty('cost');
    expect(entry.pricing?.status).toBe('unknown');
  });

  it('does not overwrite values the user already typed', () => {
    const typed = { ...buildEntryDraft({ id: 'x', provider: 'p', baseUrl: 'https://x/v1', api: 'openai-completions', credentialId: 'c', modelId: 'm', metadata: null }), contextWindow: 9_999, maxTokens: 1_234, manual: false };
    const filled = fillEntryFromMetadata(typed, { contextWindow: 128_000, maxTokens: 4_096 });
    expect(filled.contextWindow).toBe(9_999);
    expect(filled.maxTokens).toBe(1_234);

    const manual = { ...typed, manual: true };
    const untouched = fillEntryFromMetadata(manual, { contextWindow: 128_000, maxTokens: 4_096 });
    expect(untouched.contextWindow).toBe(9_999);
    expect(untouched.maxTokens).toBe(1_234);
  });

  it('fills blanks from a later refresh but keeps an unknown price unknown', () => {
    const entry = buildEntryDraft({ id: 'x', provider: 'p', baseUrl: 'https://x/v1', api: 'openai-completions', credentialId: 'c', modelId: 'm', metadata: null });
    const filled = fillEntryFromMetadata(entry, { contextWindow: 128_000 });
    expect(filled.contextWindow).toBe(128_000);
    expect(filled.cost).toBeUndefined();
    expect(filled.pricing?.status).toBe('unknown');
  });
});

describe('required model fields and credential gating (step 2)', () => {
  it('blocks saving until contextWindow and maxTokens are known, with a named reason', () => {
    const unknown = buildEntryDraft({ id: 'unknown-model', provider: 'p', baseUrl: 'https://x/v1', api: 'openai-completions', credentialId: 'c', modelId: 'm', metadata: null });
    const errors = modelFieldErrors(unknown);
    expect(errors.contextWindow).toMatch(/请填写/);
    expect(errors.maxTokens).toMatch(/请填写/);
    expect(hasRequiredModelFields(unknown)).toBe(false);

    const problems = missingRequiredModelFields([{ id: 'unknown-model' }, { id: 'known', contextWindow: 128_000, maxTokens: 4_096 }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ index: 0, id: 'unknown-model', fields: ['contextWindow', 'maxTokens'] });
  });

  it('passes once the user fills both required caps', () => {
    const entry = { ...buildEntryDraft({ id: 'x', provider: 'p', baseUrl: 'https://x/v1', api: 'openai-completions', credentialId: 'c', modelId: 'm', metadata: null }), contextWindow: 128_000, maxTokens: 8_192 };
    expect(modelFieldErrors(entry)).toEqual({});
    expect(hasRequiredModelFields(entry)).toBe(true);
    expect(missingRequiredModelFields([entry])).toEqual([]);
  });

  it('blocks model selection while the credential is unresolved and names the daemon ref', () => {
    const blocked = selectionBlockedReason({ resolved: false, credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN' });
    expect(blocked).toMatch(/凭据未解析/);
    expect(blocked).toContain('GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN');
    expect(selectionBlockedReason({ resolved: true, credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN' })).toBeNull();
  });
});

describe('settings registry (step 1 / concurrency)', () => {
  it('no longer declares an independent 并发限制 advanced section', () => {
    expect(ADVANCED_SETTING_IDS).not.toContain('settings-limits');
  });
});

describe('concurrency limits inside a provider entry', () => {
  it('reads a credential cap and its shared group from the config', () => {
    const config: ConcurrencyConfig = {
      credentials: { opencode: { sharedLimitGroupId: 'team-a' } },
      limits: { credentials: { opencode: 3 }, sharedGroups: { 'team-a': 8 } },
    };
    expect(readConcurrency(config, 'opencode')).toEqual({ credentialLimit: '3', sharedGroupId: 'team-a', sharedGroupLimit: '8' });
    expect(readConcurrency({}, 'missing')).toEqual({ credentialLimit: '', sharedGroupId: '', sharedGroupLimit: '' });
  });

  it('writes the per-credential and shared-group caps back into the document', () => {
    const config: ConcurrencyConfig = { credentials: { opencode: { sharedLimitGroupId: 'old' } }, limits: { credentials: {}, sharedGroups: { old: 2 } } };
    writeConcurrency(config, 'opencode', { credentialLimit: '5', sharedGroupId: 'team-a', sharedGroupLimit: '9' });
    expect(config.limits?.credentials).toEqual({ opencode: 5 });
    expect(config.credentials?.opencode?.sharedLimitGroupId).toBe('team-a');
    expect(config.limits?.sharedGroups).toEqual({ 'team-a': 9 });
  });

  it('clears caps and groups when the fields are emptied or invalid', () => {
    const config: ConcurrencyConfig = { credentials: { opencode: { sharedLimitGroupId: 'team-a' } }, limits: { credentials: { opencode: 3 }, sharedGroups: { 'team-a': 8 } } };
    writeConcurrency(config, 'opencode', { credentialLimit: '0', sharedGroupId: '', sharedGroupLimit: 'abc' });
    expect(config.limits?.credentials).toEqual({});
    expect(config.credentials?.opencode?.sharedLimitGroupId).toBeUndefined();
    expect(config.limits?.sharedGroups).toEqual({});
    expect(parseLimit('4')).toBe(4);
    expect(parseLimit('4.5')).toBeUndefined();
    expect(parseLimit('-1')).toBeUndefined();
  });
});
