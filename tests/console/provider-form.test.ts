/**
 * Sandbox-safe tests for the B-1 provider form logic.
 *
 * Everything here is pure: request construction, response/merge handling,
 * snapshot mapping and concurrency read-back. No DOM, no sockets, no child
 * processes — real network probing and browser behaviour are covered by the
 * human acceptance check.
 */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PLATFORMS,
  addManualModelPick,
  buildEntryDraft,
  buildProbePayload,
  customDraft,
  draftFromPlatform,
  draftToModelEntry,
  fillEntryFromMetadata,
  hasProviderErrors,
  mergeProbeModels,
  metadataToFields,
  normalizePlatforms,
  parseLimit,
  platformById,
  readConcurrency,
  selectedProbeModels,
  validateProviderDraft,
  writeConcurrency,
  type ConcurrencyConfig,
} from '../../src/web/provider-form.ts';

const preset = FALLBACK_PLATFORMS[0]!;

describe('provider draft validation (step 1)', () => {
  it('accepts a supported platform with just a key', () => {
    const draft = draftFromPlatform(preset);
    expect(validateProviderDraft(draft, { custom: false, hasKey: true })).toEqual({});
  });

  it('requires a key (or a resolvable env var) even for a supported platform', () => {
    const errors = validateProviderDraft(draftFromPlatform(preset), { custom: false, hasKey: false });
    expect(errors.key).toMatch(/API KEY|环境变量/);
    expect(hasProviderErrors(errors)).toBe(true);
  });

  it('requires name, base URL and compatibility for a custom provider', () => {
    const errors = validateProviderDraft(customDraft(), { custom: true, hasKey: false });
    expect(errors.name).toBeTruthy();
    expect(errors.baseUrl).toMatch(/Base URL/);
    expect(errors.key).toMatch(/API KEY/);
  });

  it('rejects a non-http base URL and an unknown compatibility mode', () => {
    const errors = validateProviderDraft(
      { ...customDraft(), name: '本地网关', baseUrl: 'ftp://example.com', api: 'responses' as never },
      { custom: true, hasKey: true },
    );
    expect(errors.baseUrl).toMatch(/http/);
    expect(errors.api).toMatch(/兼容格式/);
  });

  it('rejects malformed credential ids and secret refs', () => {
    const errors = validateProviderDraft(
      { ...customDraft(), name: '网关', baseUrl: 'https://api.example.com/v1', credentialId: 'Bad Id', secretRef: '1-bad' },
      { custom: true, hasKey: true },
    );
    expect(errors.credentialId).toMatch(/凭据 id/);
    expect(errors.secretRef).toMatch(/环境变量/);
  });
});

describe('platform catalog normalization', () => {
  it('reads { platforms } and a bare array, applying defaults', () => {
    const payload = { platforms: [{ id: 'grok', label: 'Grok', baseUrl: 'https://api.x.ai/v1', api: 'openai-completions', secretRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN' }] };
    const [platform] = normalizePlatforms(payload);
    expect(platform).toMatchObject({ id: 'grok', label: 'Grok', credentialId: 'grok', credentialKind: 'api-key' });
    expect(normalizePlatforms([{ id: 'custom-compat', baseUrl: 'https://x/v1', api: 'anthropic-messages' }])[0]).toMatchObject({ api: 'anthropic-messages' });
  });

  it('drops entries without an id or base URL instead of crashing', () => {
    expect(normalizePlatforms({ platforms: [{ id: '', baseUrl: 'https://x' }, { id: 'ok' }, null] })).toEqual([]);
  });

  it('keeps the built-in credential environment variable names aligned with usage', () => {
    expect(platformById(FALLBACK_PLATFORMS, 'opencode-go')!.secretRef).toBe('GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY');
    expect(platformById(FALLBACK_PLATFORMS, 'chatgpt')!.secretRef).toBe('GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN');
    expect(platformById(FALLBACK_PLATFORMS, 'custom')).toBeUndefined();
  });
});

describe('probe request/response handling (step 2)', () => {
  it('builds a probe payload that carries a credential reference, never a secret', () => {
    const draft = { ...draftFromPlatform(preset), secretRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY' };
    const payload = buildProbePayload(draft, 'gpt-5');
    expect(payload.provider).toMatchObject({ id: 'opencode-go', api: 'openai-completions', secretRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY' });
    expect(payload.modelId).toBe('gpt-5');
    expect(JSON.stringify(payload)).not.toMatch(/sk-/);
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
