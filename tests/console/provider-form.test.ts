import { describe, expect, it } from 'vitest';
import {
  applyMetadata,
  decodeVendorRef,
  draftFromPlatform,
  encodeVendorRef,
  mergeDiscoveredModels,
  metadataFill,
  newModelDraft,
  providerLabelFor,
  readConcurrency,
  uniqueModelId,
  validateProviderFormDraft,
  writeConcurrency,
  type ModelDraft,
  type PlatformOption,
  type ProbeModel,
} from '../../src/web/provider-form.ts';

/* Pure wizard-logic tests (B-1 lane 3). No DOM, no request, no child process. */

const DEEPSEEK: PlatformOption = {
  platformId: 'deepseek',
  label: 'DeepSeek',
  api: 'openai-completions',
  baseUrl: 'https://api.deepseek.com',
  secretRef: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY',
  configured: false,
  supportsModelList: true,
  credentialLabel: 'DeepSeek API Key',
  credentialKind: 'api-key',
  notes: [],
  custom: false,
};

const CUSTOM: PlatformOption = {
  platformId: 'custom',
  label: '自定义',
  api: 'openai-completions',
  baseUrl: '',
  secretRef: 'GRAPH_CUSTOM_API_KEY',
  configured: false,
  supportsModelList: true,
  credentialLabel: '自定义厂商凭据',
  credentialKind: 'api-key',
  notes: [],
  custom: true,
};

describe('provider draft validation (B-1)', () => {
  it('accepts a built-in platform that only needs its credential ref', () => {
    const result = validateProviderFormDraft(draftFromPlatform(DEEPSEEK), DEEPSEEK);
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ platformId: 'deepseek', baseUrl: 'https://api.deepseek.com' });
  });

  it('requires vendor name, Base URL, compatibility mode and key for 自定义', () => {
    const missing = validateProviderFormDraft({ platformId: 'custom', api: 'openai-completions', baseUrl: '', name: '', secretRef: '' }, CUSTOM);
    expect(missing.ok).toBe(false);
    expect(missing.errors).toMatchObject({ name: expect.any(String), baseUrl: expect.any(String), secretRef: expect.any(String) });

    const badUrl = validateProviderFormDraft({ platformId: 'custom', name: 'Acme', api: 'openai-completions', baseUrl: 'not-a-url', secretRef: 'ACME_KEY' }, CUSTOM);
    expect(badUrl.errors.baseUrl).toMatch(/http/);

    const badApi = validateProviderFormDraft({ platformId: 'custom', name: 'Acme', api: 'responses' as never, baseUrl: 'https://acme.test/v1', secretRef: 'ACME_KEY' }, CUSTOM);
    expect(badApi.errors.api).toMatch(/兼容格式/);

    const good = validateProviderFormDraft({ platformId: 'custom', name: 'Acme', api: 'anthropic-messages', baseUrl: 'https://acme.test', secretRef: 'ACME_KEY' }, CUSTOM);
    expect(good.ok).toBe(true);
    expect(good.value).toMatchObject({ api: 'anthropic-messages', name: 'Acme' });
  });

  it('rejects a credential ref that is not an environment variable name', () => {
    const result = validateProviderFormDraft({ platformId: 'custom', name: 'Acme', api: 'openai-completions', baseUrl: 'https://acme.test', secretRef: 'not a ref' }, CUSTOM);
    expect(result.errors.secretRef).toMatch(/环境变量名/);
  });
});

describe('probe result merging (B-1)', () => {
  it('appends new models and keeps every value the user already filled', () => {
    const handEdited: ModelDraft = {
      id: 'deepseek:deepseek-v4-flash',
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash',
      grade: 'high',
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      credentialId: 'deepseek',
      contextWindow: 123_456,
      maxTokens: 4_096,
      cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
    };
    const discovered: ProbeModel[] = [
      { id: 'deepseek-v4-flash', metadata: { contextWindow: 1_000_000, maxTokens: 384_000, cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 }, currency: 'USD', sourceUrl: 'https://models.dev/api.json' } },
      { id: 'deepseek-v4-pro', metadata: null },
    ];
    const merged = mergeDiscoveredModels([handEdited], discovered, { provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', credentialId: 'deepseek' });
    expect(merged).toHaveLength(2);
    // User-filled row is untouched...
    expect(merged[0]).toMatchObject({ id: 'deepseek:deepseek-v4-flash', contextWindow: 123_456, maxTokens: 4_096, grade: 'high' });
    // ...and the new row is added with a distinct local id.
    expect(merged[1]).toMatchObject({ provider: 'deepseek', modelId: 'deepseek-v4-pro', credentialId: 'deepseek' });
    expect(merged[1]!.id).not.toBe(merged[0]!.id);
  });

  it('suffixes a local id when the same upstream model is added twice', () => {
    expect(uniqueModelId('deepseek', 'm', ['deepseek:m'])).toBe('deepseek:m-2');
    const draft = newModelDraft({ provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://x.test', credentialId: 'c', upstreamId: 'm', taken: ['deepseek:m'] });
    expect(draft.id).toBe('deepseek:m-2');
    expect(draft.modelId).toBe('m');
  });

  it('gives a second connection to the same platform its own provider label', () => {
    const existing = [{ provider: 'deepseek', credentialId: 'deepseek' }];
    expect(providerLabelFor('deepseek', 'deepseek', existing)).toBe('deepseek');
    expect(providerLabelFor('deepseek', 'deepseek-2', existing)).toBe('deepseek@deepseek-2');
  });
});

describe('snapshot metadata auto-fill (B-1)', () => {
  it('fills limits, modalities, reasoning and a known price from the snapshot', () => {
    const filled = applyMetadata(newModelDraft({ provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', credentialId: 'deepseek', upstreamId: 'deepseek-v4-flash', taken: [] }), {
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevels: ['low', 'high', 'max'],
      defaultThinkingLevel: 'medium',
      cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      currency: 'USD',
      sourceUrl: 'https://models.dev/api.json',
      catalogRevision: 'models-dev.2026-09-23T02:39:18.984Z',
    }, { retrievedAt: '2026-09-23' });
    expect(filled).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevels: ['low', 'high', 'max'],
      cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      pricing: { currency: 'USD', unit: 'per_million_tokens', status: 'known', sourceUrl: 'https://models.dev/api.json', retrievedAt: '2026-09-23', catalogRevision: 'models-dev.2026-09-23T02:39:18.984Z' },
    });
  });

  it('leaves unmatched fields empty and marks the price unknown, never zero', () => {
    const metadata = metadataFill(null);
    expect(metadata.contextWindow).toBeUndefined();
    expect(metadata.maxTokens).toBeUndefined();
    expect(metadata.input).toBeUndefined();
    expect(metadata.cost).toBeUndefined();
    expect(metadata.pricing).toMatchObject({ status: 'unknown', unit: 'per_million_tokens' });
    expect(JSON.stringify(metadata)).not.toContain('"input":0');

    const entry = applyMetadata(newModelDraft({ provider: 'custom', api: 'anthropic-messages', baseUrl: 'https://acme.test', credentialId: 'acme', upstreamId: 'acme-1', taken: [] }), null);
    expect(entry.contextWindow).toBeUndefined();
    expect(entry.maxTokens).toBeUndefined();
    expect(entry.cost).toBeUndefined();
    expect(entry.pricing?.status).toBe('unknown');
  });

  it('matches the built-in snapshot row when the snapshot carries a price but no modalities', () => {
    const entry = applyMetadata(newModelDraft({ provider: 'acme', api: 'openai-completions', baseUrl: 'https://acme.test', credentialId: 'acme', upstreamId: 'acme-plain', taken: [] }), { contextWindow: 8_192, reasoning: false, currency: 'USD', sourceUrl: 'https://models.dev/api.json' });
    expect(entry).toMatchObject({ contextWindow: 8_192, reasoning: false });
    expect(entry.maxTokens).toBeUndefined();
    expect(entry.input).toBeUndefined();
    expect(entry.pricing?.status).toBe('unknown');
  });
});

describe('inline concurrency limits (B-1)', () => {
  it('writes and reads back a per-credential cap', () => {
    const written = writeConcurrency(undefined, undefined, 'deepseek', { credentialLimit: 3 });
    expect(written.limits.credentials).toEqual({ deepseek: 3 });
    expect(readConcurrency(written.limits, written.credential, 'deepseek')).toEqual({ credentialLimit: 3 });
  });

  it('keeps the shared group on the credential and its cap in the limits document', () => {
    const written = writeConcurrency({ credentials: { deepseek: 3 }, sharedGroups: {} }, { sharedLimitGroupId: 'acme' }, 'deepseek', { credentialLimit: 3, sharedGroupId: 'acme', sharedGroupLimit: 6 });
    expect(written.credential.sharedLimitGroupId).toBe('acme');
    expect(written.limits.sharedGroups).toEqual({ acme: 6 });
    expect(readConcurrency(written.limits, written.credential, 'deepseek')).toEqual({ credentialLimit: 3, sharedGroupId: 'acme', sharedGroupLimit: 6 });
  });

  it('removes a cleared cap, group and group cap without touching other vendors', () => {
    const cleared = writeConcurrency({ credentials: { deepseek: 3, other: 1 }, sharedGroups: { acme: 6, keep: 2 } }, { sharedLimitGroupId: 'acme' }, 'deepseek', { sharedGroupId: '' });
    expect(cleared.limits.credentials).toEqual({ other: 1 });
    expect(cleared.limits.sharedGroups).toEqual({ keep: 2 });
    expect(cleared.credential.sharedLimitGroupId).toBeUndefined();
    // Moving to another group drops the old group cap.
    const moved = writeConcurrency({ credentials: {}, sharedGroups: { acme: 6 } }, { sharedLimitGroupId: 'acme' }, 'deepseek', { sharedGroupId: 'beta', sharedGroupLimit: 4 });
    expect(moved.limits.sharedGroups).toEqual({ beta: 4 });
    expect(readConcurrency(moved.limits, moved.credential, 'deepseek')).toEqual({ sharedGroupId: 'beta', sharedGroupLimit: 4 });
  });
});

describe('vendor refs (B-1)', () => {
  it('round-trips a preset id and a custom name without a schema change', () => {
    expect(decodeVendorRef(encodeVendorRef('deepseek', 'DeepSeek'), ['deepseek', 'grok'])).toEqual({ platformId: 'deepseek', name: 'deepseek' });
    expect(decodeVendorRef(encodeVendorRef('custom', 'My Gateway'), ['deepseek'])).toEqual({ platformId: 'custom', name: 'My Gateway' });
    expect(decodeVendorRef(undefined, [])).toEqual({ platformId: 'custom', name: '' });
    // An unknown legacy display name degrades to 自定义 instead of a broken preset.
    expect(decodeVendorRef('旧名字', ['deepseek'])).toEqual({ platformId: 'custom', name: '旧名字' });
  });
});
