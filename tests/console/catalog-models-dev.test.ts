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
      },
    },
  },
});

describe('models.dev snapshot mapping (B-1)', () => {
  it('maps a built-in snapshot entry onto context, output, modalities, cost and currency', () => {
    const metadata = lookupModelMetadata('deepseek', 'deepseek-v4-flash');
    expect(metadata).not.toBeNull();
    expect(metadata).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      input: ['text', 'image'],
      reasoning: true,
      cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
      currency: 'USD',
      sourceUrl: MODELS_DEV_SOURCE_URL,
    });
    expect(metadata!.catalogRevision).toMatch(/^models-dev\./);
    // The snapshot really is the vendored copy and not an empty stub.
    expect(Object.keys(builtinModelsDevSnapshot().providers).length).toBeGreaterThan(50);
  });

  it('resolves a console platform id through its catalog alias (grok → xai)', () => {
    const metadata = lookupModelMetadata('grok', 'grok-4.3');
    expect(metadata).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 30_000,
      reasoning: true,
      defaultThinkingLevel: 'medium',
      currency: 'USD',
    });
    expect(metadata!.thinkingLevels).toEqual(['off', 'low', 'medium', 'high']);
    expect(metadata!.cost?.input).toBe(1.25);
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
