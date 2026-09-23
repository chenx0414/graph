import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  PLATFORM_CREDENTIAL_REFS,
  PLATFORM_PRESETS,
  platformCatalogView,
  platformPreset,
  parseModelsResponse,
  parseVerifyResponse,
  sanitizeProviderView,
  validateProviderDraft,
  vendorErrorText,
  buildModelsRequest,
  buildVerifyRequest,
  type ProbeTarget,
} from '../../src/server/providers.ts';
import type { GraphConfig } from '../../src/server/config.ts';
import { parseGraphConfig } from '../../src/server/config.ts';

const KEY = 'sk-test-secret-value';

function targetFor(id: string, apiKey: string | undefined = KEY): ProbeTarget {
  const preset = platformPreset(id)!;
  return {
    baseUrl: preset.baseUrl,
    api: preset.api,
    ...(apiKey ? { apiKey } : {}),
    ...(preset.headers ? { headers: preset.headers } : {}),
  };
}

describe('platform directory', () => {
  test('covers the supported vendors and the custom entry', () => {
    const ids = PLATFORM_PRESETS.map(preset => preset.id);
    expect(ids).toEqual(expect.arrayContaining(['opencode-go', 'command-goat', 'grok', 'chatgpt', 'deepseek', 'custom']));
  });

  test('credential environment variable names match src/server/usage.ts', async () => {
    const source = await readFile(new URL('../../src/server/usage.ts', import.meta.url), 'utf8');
    for (const preset of PLATFORM_PRESETS) {
      if (preset.id === 'custom') continue;
      expect(PLATFORM_CREDENTIAL_REFS[preset.id]).toBe(preset.credentialRef);
      // One key configures both the usage adapter and the provider wizard.
      expect(source).toContain(preset.credentialRef);
    }
  });

  test('catalog view flags resolved credentials without any secret value', () => {
    const view = platformCatalogView({ [PLATFORM_CREDENTIAL_REFS['deepseek']!]: KEY });
    const deepseek = view.platforms.find(platform => platform.id === 'deepseek')!;
    const grok = view.platforms.find(platform => platform.id === 'grok')!;
    expect(deepseek.credentialConfigured).toBe(true);
    expect(grok.credentialConfigured).toBe(false);
    expect(JSON.stringify(view)).not.toContain(KEY);
  });
});

describe('model listing request/response', () => {
  test('OpenAI-compatible platforms list <baseUrl>/models with a bearer token', () => {
    const request = buildModelsRequest(targetFor('deepseek'));
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://api.deepseek.com/v1/models');
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request.headers.accept).toBe('application/json');
    expect(JSON.stringify(request.headers)).toContain(KEY);
  });

  test('Anthropic-compatible targets use x-api-key and the version header', () => {
    const request = buildModelsRequest({ baseUrl: 'https://api.anthropic.com/', api: 'anthropic-messages', apiKey: KEY });
    expect(request.url).toBe('https://api.anthropic.com/models');
    expect(request.headers['x-api-key']).toBe(KEY);
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.headers.authorization).toBeUndefined();
  });

  test('OpenCode Go carries its session routing header', () => {
    const request = buildModelsRequest(targetFor('opencode-go'));
    expect(request.headers['x-opencode-session']).toBe('graph-console');
  });

  test('an unresolved credential omits auth headers instead of sending an empty one', () => {
    const request = buildModelsRequest({ baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' });
    expect(request.headers.authorization).toBeUndefined();
  });

  test('parses data/models/array shapes and dedupes by id', () => {
    const target = targetFor('grok');
    const data = parseModelsResponse(target, 200, { data: [{ id: 'grok-4', name: 'Grok 4' }, { id: 'grok-4' }] });
    expect(data).toEqual({ models: [{ id: 'grok-4', name: 'Grok 4' }] });
    expect(parseModelsResponse(target, 200, { models: ['a', { model: 'b', display_name: 'Bee' }] })).toEqual({
      models: [{ id: 'a' }, { id: 'b', name: 'Bee' }],
    });
    expect(parseModelsResponse(target, 200, [{ slug: 'c' }])).toEqual({ models: [{ id: 'c' }] });
  });

  test('an empty 2xx body is an empty list, not an error', () => {
    expect(parseModelsResponse(targetFor('deepseek'), 200, undefined)).toEqual({ models: [] });
  });

  test('non-2xx responses surface the vendor wording verbatim', () => {
    const target = targetFor('deepseek');
    expect(parseModelsResponse(target, 401, { error: { message: 'Authentication Fails, Your api key is invalid' } }))
      .toEqual({ error: 'Authentication Fails, Your api key is invalid' });
    expect(parseModelsResponse(target, 500, 'upstream exploded')).toEqual({ error: 'upstream exploded' });
    // A JSON string body is parsed so its message survives untouched.
    expect(parseModelsResponse(target, 429, '{"error":{"message":"Rate limit reached"}}')).toEqual({ error: 'Rate limit reached' });
  });
});

describe('minimal verification request/response', () => {
  test('OpenAI-compatible verification posts one tiny chat request', () => {
    const request = buildVerifyRequest(targetFor('command-goat'), 'goat-model');
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.commandcode.ai/provider/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(request.body!)).toMatchObject({ model: 'goat-model', max_tokens: 1, stream: false });
  });

  test('Anthropic-compatible verification posts to /messages', () => {
    const request = buildVerifyRequest({ baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', apiKey: KEY }, 'claude-x');
    expect(request.url).toBe('https://api.anthropic.com/messages');
    expect(request.headers['x-api-key']).toBe(KEY);
    expect(JSON.parse(request.body!)).toMatchObject({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
  });

  test('2xx marks the provider usable, non-2xx keeps the raw error text', () => {
    expect(parseVerifyResponse(200, { choices: [] })).toEqual({ ok: true, status: 200 });
    expect(parseVerifyResponse(403, { error: { message: 'insufficient_quota' } })).toEqual({ ok: false, status: 403, error: 'insufficient_quota' });
    expect(parseVerifyResponse(0, 'fetch failed')).toEqual({ ok: false, status: 0, error: 'fetch failed' });
  });

  test('vendorErrorText never generalizes and falls back to the HTTP status', () => {
    expect(vendorErrorText({ message: 'boom' }, 400)).toBe('boom');
    expect(vendorErrorText(undefined, 503)).toBe('HTTP 503');
  });
});

describe('provider draft validation', () => {
  test('a supported platform only needs a credential reference', () => {
    const result = validateProviderDraft({ id: 'opencode-go' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toMatchObject({
      id: 'opencode-go',
      api: 'openai-completions',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      secretRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY',
      custom: false,
      modelsListSupported: false,
    });
    expect(result.provider.headers?.['x-opencode-session']).toBe('graph-console');
  });

  test('a custom provider requires name + baseUrl + api + secret ref', () => {
    const complete = validateProviderDraft({
      id: 'custom', label: 'My Gateway', baseUrl: 'http://127.0.0.1:8080/v1', api: 'anthropic-messages', secretRef: 'MY_GATEWAY_KEY',
    });
    expect(complete.ok).toBe(true);
    if (complete.ok) expect(complete.provider).toMatchObject({ label: 'My Gateway', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:8080/v1', secretRef: 'MY_GATEWAY_KEY', custom: true });

    const missing = validateProviderDraft({ id: 'custom' });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(new Set(missing.errors.map(error => error.field))).toEqual(new Set(['baseUrl', 'api', 'label']));

    // A custom provider may omit the credential name; the directory default is used.
    const defaultRef = validateProviderDraft({ id: 'custom', label: 'My Gateway', baseUrl: 'https://gw.example/v1', api: 'openai-completions' });
    expect(defaultRef.ok).toBe(true);
    if (defaultRef.ok) expect(defaultRef.provider.secretRef).toBe(PLATFORM_CREDENTIAL_REFS['custom']);

    const badUrl = validateProviderDraft({ id: 'custom', label: 'x', baseUrl: 'not-a-url', api: 'openai-completions', secretRef: 'X_KEY' });
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.errors.some(error => error.field === 'baseUrl')).toBe(true);

    const badRef = validateProviderDraft({ id: 'custom', label: 'x', baseUrl: 'https://x.dev/v1', api: 'openai-completions', secretRef: 'not a ref' });
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) expect(badRef.errors.some(error => error.field === 'secretRef')).toBe(true);

    const badApi = validateProviderDraft({ id: 'custom', label: 'x', baseUrl: 'https://x.dev/v1', api: 'responses', secretRef: 'X_KEY' });
    expect(badApi.ok).toBe(false);
    if (!badApi.ok) expect(badApi.errors.some(error => error.field === 'api')).toBe(true);
  });

  test('an unknown platform is rejected', () => {
    const result = validateProviderDraft({ id: 'not-a-platform', baseUrl: 'https://x.dev/v1', api: 'openai-completions', secretRef: 'X_KEY' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(error => error.field === 'id')).toBe(true);
  });
});

describe('concurrency stays on the credential', () => {
  test('per-credential limits and shared groups keep their existing semantics', () => {
    const config = parseGraphConfig({
      version: 1,
      credentials: {
        'opencode-go': { secretRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY', sharedLimitGroupId: 'go' },
        grok: { secretRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN', sharedLimitGroupId: 'go' },
      },
      limits: { credentials: { 'opencode-go': 2, grok: 2 }, sharedGroups: { go: 4 } },
    }, '/tmp/graph.config.json');
    expect(config.credentials['opencode-go']?.sharedLimitGroupId).toBe('go');
    expect(config.limits.credentials['opencode-go']).toBe(2);
    expect(config.limits.sharedGroups['go']).toBe(4);
  });
});

describe('sanitized provider view', () => {
  test('exposes secret refs and resolved flags but never a plaintext secret', () => {
    const config = {
      credentials: {
        local: { secretRef: 'GRAPH_LOCAL_KEY', displayName: 'Local', sharedLimitGroupId: 'group-1' },
        idle: { secretRef: 'GRAPH_IDLE_KEY' },
      },
    } as unknown as GraphConfig;
    const view = sanitizeProviderView(config, { GRAPH_LOCAL_KEY: KEY });
    expect(view.credentials['local']).toMatchObject({ secretRef: 'GRAPH_LOCAL_KEY', resolved: true, displayName: 'Local', sharedLimitGroupId: 'group-1' });
    expect(view.credentials['idle']).toMatchObject({ secretRef: 'GRAPH_IDLE_KEY', resolved: false });
    const text = JSON.stringify(view);
    expect(text).not.toContain(KEY);
    expect(text).not.toMatch(/"(value|apiKey|key)"/);
  });

  test('a missing config yields an empty credential view', () => {
    expect(sanitizeProviderView(null)).toEqual({ credentials: {} });
  });
});
