import { describe, expect, it } from 'vitest';
import {
  builtinModelsDevSnapshot,
  catalogProvenance,
  lookupModelMetadata,
  normalizeModelsDevSnapshot,
  MODELS_DEV_ATTRIBUTION,
  MODELS_DEV_SOURCE_URL,
  type ModelsDevSnapshot,
} from '../../src/catalog/models-dev.ts';

/* Pure mapping tests for the vendored models.dev snapshot (B-1 lane 1).
 * No network, no DOM and no child process: the built-in snapshot plus small
 * handwritten samples are enough to pin every mapping rule. */

const SAMPLE: ModelsDevSnapshot = normalizeModelsDevSnapshot({
  sourceUrl: 'https://example.test/api.json',
  fetchedAt: '2026-01-02T03:04:05.000Z',
  providers: {
    acme: {
      id: 'acme',
      name: 'Acme',
      models: {
        'acme-flagship': {
          id: 'acme-flagship',
          name: 'Acme Flagship',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['none', 'bogus', 'max'] }, { type: 'budget_tokens', min: 1024 }],
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          limit: { context: 200_000, output: 32_000 },
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, currency: 'EUR' },
        },
        'acme-plain': {
          id: 'acme-plain',
          name: 'Acme Plain',
          reasoning: false,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 8_192 },
        },
        'acme-unpriced': {
          id: 'acme-unpriced',
          name: 'Acme Unpriced',
          reasoning: false,
          modalities: { input: ['text'] },
          limit: { context: 4_096, output: 1_024 },
        },
        'acme-partial': {
          id: 'acme-partial',
          name: 'Acme Partial Price',
          reasoning: false,
          modalities: { input: ['text'] },
          limit: { context: 8_000, output: 2_000 },
          cost: { input: 2, output: 8 },
        },
      },
    },
  },
});

describe('models.dev snapshot mapping (B-1)', () => {
  it('maps a built-in snapshot entry onto context, output, modalities and provenance', () => {
    const metadata = lookupModelMetadata('deepseek', 'deepseek-v4-flash');
    expect(metadata).not.toBeNull();
    expect(metadata).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 393_216,
      input: ['text', 'image'],
      reasoning: true,
      sourceUrl: MODELS_DEV_SOURCE_URL,
    });
    expect(metadata!.catalogRevision).toMatch(/^models-dev\./);
    // This entry prices only three of the four sides, so no cost is reported.
    expect(metadata!.cost).toBeUndefined();
    // The snapshot really is the vendored copy and not an empty stub.
    expect(Object.keys(builtinModelsDevSnapshot().providers).length).toBeGreaterThan(50);
  });

  it('reports a built-in price only when all four amounts are present', () => {
    const metadata = lookupModelMetadata('anthropic', 'claude-sonnet-4-6');
    expect(metadata).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      currency: 'USD',
    });
  });

  it('resolves a console platform id through its catalog alias (grok → xai)', () => {
    const metadata = lookupModelMetadata('grok', 'grok-4.3');
    expect(metadata).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 30_000,
      reasoning: true,
    });
    expect(metadata!.thinkingLevels).toEqual(['off', 'low', 'medium', 'high']);
    // models.dev records no default thinking strength, even though 'medium' is a
    // listed level; the wizard must not invent one.
    expect(metadata!.defaultThinkingLevel).toBeUndefined();
    // No cache-write rate is published, so the price (and currency) is left to the user.
    expect(metadata!.cost).toBeUndefined();
    expect(metadata!.currency).toBeUndefined();
  });

  it('resolves models for a second OpenCode Go account and the current catalog', () => {
    expect(lookupModelMetadata('opencode-go-3', 'deepseek-v4.1-flash')?.thinkingLevels).toEqual(['low', 'high', 'max']);
    expect(lookupModelMetadata('opencode-go-3', 'space-bunny-free')?.thinkingLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('never invents a default thinking strength for a reasoning model', () => {
    // 'medium' is one of the listed levels and the model reasons, but the
    // snapshot says nothing about a default, so the result must not carry one.
    for (const [provider, id] of [['grok', 'grok-4.3'], ['deepseek', 'deepseek-v4-flash'], ['anthropic', 'claude-sonnet-4-6']] as const) {
      const metadata = lookupModelMetadata(provider, id);
      expect(metadata).not.toBeNull();
      expect(metadata!.reasoning).toBe(true);
      expect(metadata!.defaultThinkingLevel).toBeUndefined();
      expect('defaultThinkingLevel' in metadata!).toBe(false);
    }
  });

  it('keeps only thinking levels the repository models and never invents one', () => {
    const metadata = lookupModelMetadata('acme', 'acme-flagship', SAMPLE);
    // 'bogus' is dropped; 'none' maps onto the repository's off level.
    expect(metadata!.thinkingLevels).toEqual(['off', 'max']);
    // No medium level exists, so no default is guessed.
    expect(metadata!.defaultThinkingLevel).toBeUndefined();
  });

  it('treats image as supported only when the snapshot lists it as an input modality', () => {
    expect(lookupModelMetadata('acme', 'acme-flagship', SAMPLE)!.input).toEqual(['text', 'image']);
    expect(lookupModelMetadata('acme', 'acme-plain', SAMPLE)!.input).toEqual(['text']);
  });

  it('normalizes price and currency per million tokens including cache rates', () => {
    const metadata = lookupModelMetadata('acme', 'acme-flagship', SAMPLE);
    expect(metadata!.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(metadata!.currency).toBe('EUR');
    expect(metadata!.sourceUrl).toBe('https://example.test/api.json');
    expect(metadata!.catalogRevision).toBe('models-dev.2026-01-02T03:04:05.000Z');
  });

  it('returns null when the snapshot, provider or model is missing', () => {
    expect(lookupModelMetadata('deepseek', 'deepseek-v4-flash', { providers: {} })).toBeNull();
    expect(lookupModelMetadata('not-a-provider', 'deepseek-v4-flash')).toBeNull();
    expect(lookupModelMetadata('deepseek', 'no-such-model')).toBeNull();
    expect(lookupModelMetadata('', 'deepseek-v4-flash')).toBeNull();
  });

  it('omits cost entirely when the snapshot prices only part of the model', () => {
    const metadata = lookupModelMetadata('acme', 'acme-partial', SAMPLE);
    expect(metadata).not.toBeNull();
    expect(metadata!.contextWindow).toBe(8_000);
    expect(metadata!.cost).toBeUndefined();
    // No side may quietly become 0.
    expect(JSON.stringify(metadata)).not.toMatch(/"(input|output|cacheRead|cacheWrite)":0\b/);
  });

  it('leaves a price unknown instead of zero-filling it', () => {
    const metadata = lookupModelMetadata('acme', 'acme-unpriced', SAMPLE);
    expect(metadata).not.toBeNull();
    expect(metadata!.cost).toBeUndefined();
    expect(metadata!.currency).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain('"input":0');
  });

  it('leaves unsupported snapshot fields empty rather than defaulting them', () => {
    const metadata = lookupModelMetadata('acme', 'acme-plain', SAMPLE);
    expect(metadata!.maxTokens).toBeUndefined();
    expect(metadata!.cost).toBeUndefined();
    expect(metadata!.thinkingLevels).toBeUndefined();
    expect(metadata!.defaultThinkingLevel).toBeUndefined();
  });

  it('accepts both the bare model id and the vendor/model spelling', () => {
    const bare = lookupModelMetadata('deepseek', 'deepseek-v4-flash');
    const qualified = lookupModelMetadata('deepseek', 'deepseek/deepseek-v4-flash');
    expect(qualified).toEqual(bare);
    expect(bare).not.toBeNull();
    // A bare segment only matches inside a provider that also resolves.
    expect(lookupModelMetadata('anthropic', 'deepseek-v4-flash')).toBeNull();
  });

  it('exposes snapshot provenance for ModelPricing', () => {
    const provenance = catalogProvenance();
    expect(provenance.sourceUrl).toBe(MODELS_DEV_SOURCE_URL);
    expect(provenance.retrievedAt).toMatch(/^20\d\d-/);
    expect(provenance.catalogRevision).toBe(`models-dev.${provenance.retrievedAt}`);
    expect(provenance.attribution).toContain('models.dev');
    expect(catalogProvenance({ providers: {} }).attribution).toBe(MODELS_DEV_ATTRIBUTION);
  });

  it('reads the vendored `_meta` block and the earlier top-level metadata shape', () => {
    const withMeta = normalizeModelsDevSnapshot({ _meta: { sourceUrl: 'https://meta.test/api.json', fetchedAt: '2026-05-06T07:08:09.000Z', attribution: 'meta attribution' }, providers: {} });
    expect(withMeta).toMatchObject({ sourceUrl: 'https://meta.test/api.json', fetchedAt: '2026-05-06T07:08:09.000Z', attribution: 'meta attribution' });
    expect(catalogProvenance(withMeta)).toMatchObject({ sourceUrl: 'https://meta.test/api.json', catalogRevision: 'models-dev.2026-05-06T07:08:09.000Z' });
    expect(normalizeModelsDevSnapshot({ sourceUrl: 'https://legacy.test', fetchedAt: '2025-01-01T00:00:00.000Z', license: 'legacy', providers: {} })).toMatchObject({ sourceUrl: 'https://legacy.test', fetchedAt: '2025-01-01T00:00:00.000Z', attribution: 'legacy' });
  });

  it('accepts a bare provider map as a snapshot', () => {
    const bare = normalizeModelsDevSnapshot({ acme: { id: 'acme', models: { 'acme-plain': { id: 'acme-plain', limit: { context: 1_024, output: 512 } } } } });
    expect(lookupModelMetadata('acme', 'acme-plain', bare)).toMatchObject({ contextWindow: 1_024, maxTokens: 512 });
  });
});
