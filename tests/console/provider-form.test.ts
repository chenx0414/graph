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
  autoProbeDecision,
  buildEntryDraft,
  completeCost,
  costError,
  customDraft,
  draftFromModelVendor,
  draftFromPlatform,
  draftToModelEntry,
  fillEntryFromMetadata,
  hasRequiredModelFields,
  keyEntryGuidance,
  metadataToFields,
  thinkingOptionsFromMetadata,
  missingRequiredModelFields,
  modelFieldErrors,
  modelVendorsFrom,
  normalizePlatforms,
  platformById,
  platformsRequest,
  probeFailureNote,
  probeRequest,
  selectionBlockedReason,
  shouldAutoProbe,
  withCostField,
  type ConcurrencyConfig,
} from '../../src/web/provider-form.ts';
import { estimateCost } from '../../src/catalog/models.ts';
import { lookupModelMetadata } from '../../src/catalog/models-dev.ts';

const preset = FALLBACK_PLATFORMS[0]!;

describe('model thinking options in the provider editor', () => {
  it('shows OpenCode Go effort levels as soon as metadata is fetched', () => {
    expect(thinkingOptionsFromMetadata(lookupModelMetadata('opencode-go', 'deepseek-v4.1-flash')))
      .toEqual([{ level: 'low', label: 'low' }, { level: 'high', label: 'high' }, { level: 'max', label: 'max' }]);
    expect(thinkingOptionsFromMetadata(null).map(option => option.level)).toEqual(['minimal', 'low', 'medium', 'high']);
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
    expect(platformById(FALLBACK_PLATFORMS, 'opencode-go')!.modelsListSupported).toBe(true);
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

});

describe('snapshot metadata mapping', () => {

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

    const problems = missingRequiredModelFields([{ id: 'unknown-model' }, { id: 'known', contextWindow: 128_000, maxTokens: 4_096, grade: 'medium' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ index: 0, id: 'unknown-model' });
    expect(problems[0]!.fields).toEqual(expect.arrayContaining(['contextWindow', 'maxTokens', 'grade']));
  });

  it('passes once the user fills the required caps and picks a grade', () => {
    const entry = { ...buildEntryDraft({ id: 'x', provider: 'p', baseUrl: 'https://x/v1', api: 'openai-completions', credentialId: 'c', modelId: 'm', metadata: null }), contextWindow: 128_000, maxTokens: 8_192, grade: 'medium' as const };
    expect(modelFieldErrors(entry)).toEqual({});
    expect(hasRequiredModelFields(entry)).toBe(true);
    expect(missingRequiredModelFields([entry])).toEqual([]);
  });

  it('(e) requires the user to pick a grade instead of defaulting to medium', () => {
    const unknownGrade = { id: 'm', contextWindow: 128_000, maxTokens: 4_096 };
    expect(modelFieldErrors(unknownGrade).grade).toMatch(/请选择模型等级/);
    expect(missingRequiredModelFields([unknownGrade])[0]!.fields).toContain('grade');
    expect(modelFieldErrors({ ...unknownGrade, grade: 'high' }).grade).toBeUndefined();
  });

  it('blocks model selection while the credential is unresolved and names the daemon ref', () => {
    const blocked = selectionBlockedReason({ resolved: false, credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN' });
    expect(blocked).toMatch(/凭据未解析/);
    expect(blocked).toContain('GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN');
    expect(selectionBlockedReason({ resolved: true, credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN' })).toBeNull();
  });
});

describe('price completeness (step 2)', () => {
  it('(d) rejects a half-filled price and never turns a missing side into 0', () => {
    expect(costError({ input: 5 })).toMatch(/成套/);
    expect(costError({ input: 5, output: 6 })).toMatch(/成套/);
    expect(completeCost({ input: 5, output: 6 })).toBeNull();

    const entry = { id: 'm', contextWindow: 128_000, maxTokens: 4_096, grade: 'medium', cost: { input: 5 } };
    expect(modelFieldErrors(entry).cost).toMatch(/成套/);
    // The partial cost is never completed with a zero.
    expect(completeCost(entry.cost)).toBeNull();
    expect(completeCost(entry.cost)).not.toEqual({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('accepts a complete price (including genuine free prices) and clears to unknown when emptied', () => {
    const complete = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(costError(complete)).toBeNull();
    expect(completeCost(complete)).toEqual(complete);
    expect(costError(undefined)).toBeNull();
    expect(completeCost(undefined)).toBeNull();
    const partial = withCostField({ input: 5 }, 'output', 6);
    expect(partial).toEqual({ input: 5, output: 6 });
    expect(withCostField(partial, 'output', undefined)).toEqual({ input: 5 });
    expect(withCostField({ input: 5 }, 'input', undefined)).toBeUndefined();
  });

  it('(d) estimateCost treats a missing price side as unknown, never as 0', () => {
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
    expect(estimateCost(usage, { input: 1, output: null as unknown as number, cacheRead: 0, cacheWrite: 0 })).toEqual({ unknown: true });
    expect(estimateCost(usage, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toMatchObject({ amount: 2 });
  });
});

describe('unset default thinking strength (round A)', () => {

  it('(A) only writes a default level when one is actually provided', () => {
    const draft = buildEntryDraft({ id: 'x', provider: 'p', baseUrl: 'https://x/v1', api: 'openai-completions', credentialId: 'c', modelId: 'm', metadata: { reasoning: true, defaultThinkingLevel: 'high' } });
    expect(draft.defaultThinkingLevel).toBe('high');
    expect(draftToModelEntry(draft).defaultThinkingLevel).toBe('high');
  });
});

describe('model step vendor picker (step 2)', () => {
  const platform = (id: string, credentialConfigured: boolean) => ({ ...platformById(FALLBACK_PLATFORMS, id)!, credentialConfigured });

  it('lists only configured credentials and counts the models of each vendor', () => {
    const platforms = [platform('opencode-go', true), platform('grok', false), platform('deepseek', true)];
    const config = {
      credentials: {
        grok: { secretRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN' },
        local: { secretRef: 'GRAPH_LOCAL_KEY', displayName: '本地网关' },
      },
      models: { entries: [{ credentialId: 'grok' }, { credentialId: 'grok' }, { credentialId: 'local' }] },
    };
    const vendors = modelVendorsFrom(config, platforms);
    expect(vendors.map(vendor => vendor.id)).toEqual(['opencode-go', 'deepseek', 'grok', 'local']);
    const byId = Object.fromEntries(vendors.map(vendor => [vendor.id, vendor]));
    expect(byId.grok).toMatchObject({ platformId: 'grok', label: 'Grok', modelCount: 2 });
    expect(byId['opencode-go']).toMatchObject({ platformId: 'opencode-go', modelCount: 0 });
    expect(byId.local).toMatchObject({ platformId: 'custom', label: '本地网关', credentialRef: 'GRAPH_LOCAL_KEY', modelCount: 1 });
    // An unconfigured platform is hidden entirely, never greyed out.
    expect(vendors.some(vendor => vendor.id === 'chatgpt')).toBe(false);
  });

  it('is empty when no credential is configured', () => {
    expect(modelVendorsFrom(null, FALLBACK_PLATFORMS.map(item => ({ ...item, credentialConfigured: false })))).toEqual([]);
    expect(modelVendorsFrom({ credentials: {}, models: { entries: [] } }, [])).toEqual([]);
  });

  it('probes a user-defined credential as the custom platform', () => {
    const [vendor] = modelVendorsFrom({ credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } } }, []);
    expect(draftFromModelVendor(vendor!)).toMatchObject({ platformId: 'custom', credentialId: 'local', credentialRef: 'GRAPH_LOCAL_KEY', api: 'openai-completions' });
    const named = draftFromModelVendor(modelVendorsFrom({ credentials: {} }, [platform('grok', true)])[0]!);
    expect(named).toMatchObject({ platformId: 'grok', credentialId: 'grok', credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN' });
  });

  it('carries each vendor’s own endpoint and api instead of a blank one', () => {
    // A supported platform keeps the preset endpoint (never an empty probe URL).
    const named = draftFromModelVendor(modelVendorsFrom({ credentials: {} }, [platform('grok', true)])[0]!);
    expect(named.baseUrl).toBe('https://api.x.ai/v1');
    expect(named.api).toBe('openai-completions');
    expect(named.baseUrl).not.toBe('');
    // A user-defined credential takes the endpoint of the models already under it.
    const customVendor = modelVendorsFrom({
      credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
      models: { entries: [{ credentialId: 'local', baseUrl: 'http://127.0.0.1:9999/v1', api: 'anthropic-messages' }] },
    }, [])[0]!;
    const customDraft = draftFromModelVendor(customVendor);
    expect(customDraft.baseUrl).toBe('http://127.0.0.1:9999/v1');
    expect(customDraft.api).toBe('anthropic-messages');
  });

  it('auto-probes only when the selected vendor actually changes', () => {
    expect(shouldAutoProbe('grok', null)).toBe(true);
    expect(shouldAutoProbe('grok', 'deepseek')).toBe(true);
    expect(shouldAutoProbe('grok', 'grok')).toBe(false);
    expect(shouldAutoProbe('', 'grok')).toBe(false);
    expect(shouldAutoProbe('   ', null)).toBe(false);
  });

  it('records a vendor as probed only when a request is really issued', () => {
    // No endpoint yet: do not probe and do not record, so the same selection
    // can auto-probe later.
    expect(autoProbeDecision('grok', null, '')).toEqual({ probe: false, recorded: null });
    expect(autoProbeDecision('grok', null, 'https://api.x.ai/v1')).toEqual({ probe: true, recorded: 'grok' });
    // Already probed: a later render stays silent.
    expect(autoProbeDecision('grok', 'grok', 'https://api.x.ai/v1')).toEqual({ probe: false, recorded: 'grok' });
  });

  it('still auto-probes once when the vendor only becomes resolvable later', () => {
    // Effect run 1: the vendor is selected but not resolvable yet (no baseUrl).
    const first = autoProbeDecision('grok', null, '');
    expect(first.probe).toBe(false);
    let probed = first.recorded;
    // Effect run 2: the catalog arrived; the id is still unrecorded, so it probes.
    const second = autoProbeDecision('grok', probed, 'https://api.x.ai/v1');
    expect(second.probe).toBe(true);
    probed = second.recorded;
    expect(probed).toBe('grok');
    expect(autoProbeDecision('grok', probed, 'https://api.x.ai/v1').probe).toBe(false);
  });

  it('keeps the vendor’s own wording in the model-list failure copy', () => {
    expect(probeFailureNote('Rate limit reached')).toContain('Rate limit reached');
    expect(probeFailureNote('Rate limit reached')).toContain('手动添加模型 id');
    expect(probeFailureNote('  ')).toContain('未知错误');
  });
});

describe('key entry guidance', () => {

  it('desktop mode keeps the keychain input path', () => {
    const guidance = keyEntryGuidance({ hasBridge: true, credentialRef: 'GRAPH_PROVIDER_API_KEY' });
    expect(guidance.mode).toBe('desktop');
    expect(guidance.title).toContain('API 密钥');
    expect(guidance.lines.join(' ')).toContain('钥匙串');
    expect(guidance.lines.join(' ')).not.toContain('浏览器');
  });

  it('falls back to a real variable name when the ref is blank', () => {
    expect(keyEntryGuidance({ hasBridge: false, credentialRef: '  ' }).envVar).toBe('GRAPH_PROVIDER_API_KEY');
  });
});
