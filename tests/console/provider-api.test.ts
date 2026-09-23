import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildModelsRequest,
  buildModelsUrl,
  buildVerifyRequest,
  parseModelsResponse,
  parseVerifyResponse,
  platformCatalog,
  platformPreset,
  PLATFORM_IDS,
  PLATFORM_PRESETS,
  sanitizeProviderView,
  validateProviderDraft,
  vendorErrorText,
  type ProviderDraft,
} from '../../src/server/providers.ts';

/* Pure provider-contract tests (B-1 lane 2). Request construction, response
 * parsing, view sanitizing and preset consistency; no socket is opened and no
 * child process is started. The real probe is exercised by the human check. */

const openAi: ProviderDraft = { platformId: 'opencode-go', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1' };
const anthropic: ProviderDraft = { platformId: 'custom', name: 'Acme', api: 'anthropic-messages', baseUrl: 'https://api.acme.test' };

describe('provider platform directory (B-1)', () => {
  it('covers the already-supported platforms plus 自定义', () => {
    expect(PLATFORM_IDS).toEqual(expect.arrayContaining(['opencode-go', 'command-goat', 'grok', 'chatgpt', 'deepseek', 'custom']));
    // Every non-custom platform ships a usable default endpoint and transport.
    for (const preset of PLATFORM_PRESETS) {
      expect(preset.label).toBeTruthy();
      if (!preset.custom) {
        expect(preset.baseUrl).toMatch(/^https:\/\//);
        expect(preset.credential.secretRef).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
    expect(platformPreset('custom')?.custom).toBe(true);
    expect(platformPreset('missing')).toBeUndefined();
  });

  it('reuses the exact credential env refs declared by the usage service', () => {
    // The usage page imports these names; provider setup must resolve the same
    // key. Comparing against the usage source keeps the two lists from drifting
    // without editing that file from this lane.
    const usageSource = readFileSync(new URL('../../src/server/usage.ts', import.meta.url), 'utf8');
    for (const preset of PLATFORM_PRESETS) {
      if (preset.id === 'custom') continue;
      expect(usageSource).toContain(`'${preset.credential.secretRef}'`);
    }
    expect(platformCatalog({ GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY: 'sk-test' }).find(entry => entry.platformId === 'deepseek')?.configured).toBe(true);
    expect(platformCatalog({}).find(entry => entry.platformId === 'deepseek')?.configured).toBe(false);
  });
});

describe('provider request construction (B-1)', () => {
  it('appends /models to the OpenAI-compatible base and carries the bearer key', () => {
    const request = buildModelsRequest(openAi, 'sk-secret');
    expect(request.url).toBe('https://opencode.ai/zen/go/v1/models');
    expect(request.headers.authorization).toBe('Bearer sk-secret');
    // OpenCode Go rejects routing without the session hint.
    expect(request.headers['x-opencode-session']).toBeTruthy();
  });

  it('uses the Anthropic models path and key header', () => {
    const request = buildModelsRequest(anthropic, 'anthropic-secret');
    expect(request.url).toBe('https://api.acme.test/v1/models');
    expect(request.headers['x-api-key']).toBe('anthropic-secret');
    expect(request.headers['anthropic-version']).toBeTruthy();
    expect(request.headers.authorization).toBeUndefined();
  });

  it('does not invent a base /v1 segment twice', () => {
    expect(buildModelsUrl('anthropic-messages', 'https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/models');
    expect(buildModelsUrl('openai-completions', 'https://api.deepseek.com/')).toBe('https://api.deepseek.com/models');
  });

  it('builds a minimal chat verification request per transport', () => {
    const openAiVerify = buildVerifyRequest(openAi, 'qwen3.7-max', 'sk-secret');
    expect(openAiVerify.url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(openAiVerify.body).toMatchObject({ model: 'qwen3.7-max', max_tokens: 1, stream: false });
    const anthropicVerify = buildVerifyRequest(anthropic, 'claude-sonnet-4-5', 'anthropic-secret');
    expect(anthropicVerify.url).toBe('https://api.acme.test/v1/messages');
    expect(anthropicVerify.body).toMatchObject({ model: 'claude-sonnet-4-5', max_tokens: 1 });
    expect(anthropicVerify.headers['x-api-key']).toBe('anthropic-secret');
  });

  it('rejects an unknown platform and a missing base URL', () => {
    expect(() => buildModelsRequest({ platformId: 'nope', api: 'openai-completions', baseUrl: 'https://x.test' })).toThrow(/Unknown platform/);
    expect(() => buildModelsRequest({ platformId: 'custom', api: 'openai-completions', baseUrl: '   ' })).toThrow(/Base URL is required/);
    expect(() => validateProviderDraft({ platformId: 'custom', api: 'responses' as never, baseUrl: 'https://x.test' })).toThrow(/api must be/);
    expect(() => buildVerifyRequest(anthropic, '  ')).toThrow(/model id is required/);
  });
});

describe('provider response parsing (B-1)', () => {
  it('reads the model list from data, models or a bare array', () => {
    expect(parseModelsResponse(openAi, 200, { data: [{ id: 'a', name: 'A' }, { id: 'b' }] })).toEqual({ models: [{ id: 'a', name: 'A' }, { id: 'b' }] });
    expect(parseModelsResponse(openAi, 200, { models: [{ id: 'c' }] })).toEqual({ models: [{ id: 'c' }] });
    expect(parseModelsResponse(openAi, 200, ['d'])).toEqual({ models: [{ id: 'd' }] });
    expect(parseModelsResponse(anthropic, 200, { data: [{ id: 'claude', display_name: 'Claude' }] })).toEqual({ models: [{ id: 'claude', name: 'Claude' }] });
  });

  it('keeps the vendor error text verbatim on a non-2xx response', () => {
    expect(parseModelsResponse(openAi, 401, { error: { message: 'Invalid API key provided' } })).toEqual({ error: 'Invalid API key provided' });
    expect(parseModelsResponse(openAi, 400, { error: { error: { message: 'deepseek: model not found' } } })).toEqual({ error: 'deepseek: model not found' });
    expect(parseModelsResponse(anthropic, 429, 'rate limit exceeded')).toEqual({ error: 'rate limit exceeded' });
    expect(vendorErrorText(500, { error: 'boom' })).toBe('boom');
    expect(vendorErrorText(503, undefined)).toBe('HTTP 503');
  });

  it('reports an unusable 2xx body as an error instead of an empty list', () => {
    const outcome = parseModelsResponse(openAi, 200, { unexpected: true });
    expect('error' in outcome).toBe(true);
    expect(parseModelsResponse(openAi, 200, { data: [] })).toMatchObject({ error: '模型列表为空' });
  });

  it('turns a 2xx verification into ok and a failure into the raw text', () => {
    expect(parseVerifyResponse(200, { id: 'stub' })).toEqual({ ok: true });
    expect(parseVerifyResponse(403, { error: { message: 'missing x-api-key' } })).toEqual({ ok: false, error: 'missing x-api-key' });
  });
});

describe('provider view sanitizing (B-1)', () => {
  it('never returns a secret value, only the ref and its resolution', () => {
    const view = sanitizeProviderView({
      platformId: 'deepseek',
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      credential: { secretRef: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY', configured: true, value: 'sk-plain-text-secret' },
    });
    expect(view).toEqual({
      platformId: 'deepseek',
      name: 'DeepSeek',
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      secretRef: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY',
      configured: true,
      supportsModelList: true,
    });
    expect(JSON.stringify(view)).not.toContain('sk-plain-text-secret');
    expect('value' in view).toBe(false);
  });

  it('falls back to the platform defaults for a partial view', () => {
    expect(sanitizeProviderView({ platformId: 'grok' })).toMatchObject({
      name: 'Grok',
      baseUrl: 'https://api.x.ai/v1',
      secretRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN',
      configured: false,
    });
  });
});
