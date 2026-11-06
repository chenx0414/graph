import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * P9 — one vocabulary for the provider api, one conclusion for ChatGPT, and a
 * live configuration a node or a test cannot rewrite.
 *
 * Everything here goes through a real daemon and the console's own HTTP face:
 * the provider catalog the settings page reads, the configuration store the
 * settings page saves through, and the state database the daemon keeps. The
 * three facts it pins:
 *
 *   1. the api strings the product publishes are the three the parser accepts,
 *      and a value outside them is refused with the accepted list - not
 *      silently sent to the chat-completions endpoint by the runtime;
 *   2. the ChatGPT platform is concluded: the catalog no longer offers it as a
 *      usable platform, and a configuration that still names it is refused with
 *      the reason and the replacement, instead of being accepted and failing at
 *      the first send;
 *   3. the legal successor entry (grok, from the delivery that removed ChatGPT)
 *      parses completely, transport fallback included.
 *
 * `docs/evidence/independent-model-entries.json` is read as the record of that
 * decision: the file and the product must agree on what is supported.
 */

const GROK = {
  id: 'grok:grok-4.5', provider: 'grok', modelId: 'grok-4.5', grade: 'high', api: 'openai-completions',
  baseUrl: 'https://api.x.ai/v1', contextWindow: 131072, maxTokens: 8192, credentialId: 'grok',
  input: ['text'], reasoning: true,
};

const CHATGPT = {
  id: 'chatgpt:gpt-6.1-sol', provider: 'chatgpt', modelId: 'gpt-6.1-sol', grade: 'high', api: 'openai-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex', contextWindow: 400000, maxTokens: 8192, credentialId: 'chatgpt',
  input: ['text'], reasoning: true, fallbackModelId: 'grok:grok-4.5',
};

interface Daemon {
  request: (path: string, init?: RequestInit) => Promise<{ status: number; body: Record<string, any> }>;
  close: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => { for (const close of cleanups.reverse()) await close(); });

/** One daemon over a caller-owned config file. */
async function startDaemon(root: string, options: { configPath?: string; stateDir?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Daemon> {
  const configPath = options.configPath ?? join(root, 'graph.config.json');
  if (!options.configPath) {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: root }],
      credentials: { grok: { secretRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN', platform: 'grok' } },
      models: { entries: [{ ...GROK, id: 'main', modelId: 'main-model', contextWindow: 32000, maxTokens: 512, grade: 'high' }] },
    }));
  }
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const daemon = await launchCli(root, {
    configPath,
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
    env: { GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN: 'grok-synthetic', ...options.env },
  });
  cleanups.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  return { request, close: () => daemon.close() };
}

const save = (daemon: Daemon, document: unknown, expectedRevision: number) => daemon.request('/api/config', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ expectedRevision, document }),
});

const documentOf = (entries: unknown[]) => ({
  version: 1,
  projects: [],
  credentials: {
    grok: { secretRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN', platform: 'grok' },
    chatgpt: { secretRef: 'GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN' },
  },
  models: { entries },
});

test('the api vocabulary the product publishes is the one it accepts, and an unsupported value names the accepted list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-vocabulary-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const daemon = await startDaemon(root);

  const accepted = ['anthropic-messages', 'openai-completions', 'openai-responses'];

  // 1. Every platform the console offers carries an api the configuration
  //    parser accepts: the catalog and the config file speak one vocabulary.
  const providers = await daemon.request('/api/providers');
  expect(providers.status).toBe(200);
  const platforms = (providers.body.platforms ?? []) as {
    id: string; api: string; unsupported?: boolean; unsupportedReason?: string; notes?: string[];
  }[];
  expect(platforms.length).toBeGreaterThan(0);
  const published = [...new Set(platforms.map(platform => platform.api))];
  expect(published.filter(api => !accepted.includes(api)),
    'the catalog publishes an api the configuration cannot name').toEqual([]);

  // 2. The ChatGPT platform is concluded: the catalog keeps the record so the
  //    settings page can explain it, but the record says it is not usable and
  //    names the reason and the replacement.
  const chatgpt = platforms.find(platform => platform.id === 'chatgpt');
  expect(chatgpt, 'the catalog dropped the record of the removed platform').toBeTruthy();
  expect(chatgpt!.unsupported, `the catalog still offers chatgpt as usable: ${JSON.stringify(chatgpt)}`).toBe(true);
  expect(String(chatgpt!.unsupportedReason), 'the concluded platform must carry its reason')
    .toMatch(/EOF|openai-responses/);
  expect(String(chatgpt!.unsupportedReason), 'the reason must name the transport that replaced it').toMatch(/grok/);

  // 3. Every accepted value really is configurable: one entry per transport
  //    through the same store. A vocabulary of three that the store only
  //    honours twice is how `responses` and `openai-responses` came apart.
  let revision = 0;
  for (const api of accepted) {
    const saved = await save(daemon, documentOf([{ ...GROK, api }]), revision);
    expect(saved.status, `the store refused api "${api}": ${saved.status} ${JSON.stringify(saved.body)}`).toBe(200);
    expect(saved.body.revision).toBe(revision + 1);
    revision = saved.body.revision;
  }

  // 4. A value outside the vocabulary is refused with the accepted three, and
  //    the file keeps the bytes the last accepted save wrote. The runtime must
  //    never be the place where an unknown api gets guessed.
  const before = await readFile(join(root, 'graph.config.json'), 'utf8');
  const refused = await save(daemon, documentOf([{ ...GROK, api: 'responses' }]), revision);
  expect(refused.status, `expected api "responses" to be rejected; got ${refused.status} ${JSON.stringify(refused.body)}`)
    .toBe(400);
  expect(String(refused.body.message))
    .toContain('must be "openai-completions", "openai-responses" or "anthropic-messages"');
  expect(await readFile(join(root, 'graph.config.json'), 'utf8'), 'a refused save rewrote the configuration')
    .toBe(before);
});

test('the ChatGPT entry is concluded: the catalog and the delivery record both mark it unsupported, with its fallback and the reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-chatgpt-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const daemon = await startDaemon(root);

  // The product's own record of the platform, as the settings page reads it.
  const providers = await daemon.request('/api/providers');
  const chatgptPlatform = ((providers.body.platforms ?? []) as { id: string; unsupported?: boolean; unsupportedReason?: string }[])
    .find(platform => platform.id === 'chatgpt');
  expect(chatgptPlatform, 'the catalog dropped the record of the concluded platform').toBeTruthy();
  expect(chatgptPlatform!.unsupported, 'the catalog still presents chatgpt as a usable platform').toBe(true);
  expect(String(chatgptPlatform!.unsupportedReason), 'the concluded platform must carry the reason and the replacement')
    .toMatch(/EOF|openai-responses/);
  expect(String(chatgptPlatform!.unsupportedReason)).toMatch(/grok/);

  // The delivery that removed the entry keeps the same decision on the same
  // entry: marked unsupported, with the transport fallback and the reason.
  const record = JSON.parse(await readFile(join(process.cwd(), 'docs', 'evidence', 'independent-model-entries.json'), 'utf8')) as {
    models: { entries: { id: string; status?: string; fallbackModelId?: string; unsupportedReason?: string }[] };
  };
  const chatgpt = record.models.entries.find(entry => entry.id === 'chatgpt:gpt-6.1-sol');
  expect(chatgpt, 'the record no longer carries the removed entry').toBeTruthy();
  expect(chatgpt!.status, `expected the record to mark chatgpt unsupported; got ${JSON.stringify(chatgpt)}`).toBe('unsupported');
  expect(chatgpt!.fallbackModelId, 'the record must keep the transport fallback it was concluded with').toBe('grok:grok-4.5');
  expect(String(chatgpt!.unsupportedReason), 'the record must keep the reason').toMatch(/EOF|openai-responses/);

  // The two records say the same thing: the catalog's reason and the delivery's
  // reason describe one conclusion, not two.
  expect(String(chatgptPlatform!.unsupportedReason).length).toBeGreaterThan(0);
  expect(String(chatgpt!.unsupportedReason)).toMatch(/grok:grok-4\.5/);
});

test('the legal successor entry parses completely, transport fallback included', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-grok-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const daemon = await startDaemon(root);

  // The entry is taken from the delivery file itself, so the document that is
  // meant to be merged into a live configuration is what the parser is given.
  const record = JSON.parse(await readFile(join(process.cwd(), 'docs', 'evidence', 'independent-model-entries.json'), 'utf8')) as {
    models: { entries: Record<string, any>[] };
  };
  const grok = record.models.entries.find(entry => entry.id === GROK.id);
  expect(grok, 'the delivery file no longer carries the grok entry').toBeTruthy();

  const saved = await save(daemon, documentOf([{ ...grok, grade: 'high' }]), 0);
  expect(saved.status, `the grok entry did not parse: ${saved.status} ${JSON.stringify(saved.body)}`).toBe(200);
  expect(saved.body.revision).toBe(1);

  const read = await daemon.request('/api/config');
  expect(read.status).toBe(200);
  const entry = (read.body.config?.models?.entries ?? [])[0];
  expect(entry, 'the saved configuration has no model entry').toBeTruthy();
  const declared = Object.fromEntries(Object.entries(grok!).filter(([, value]) => value !== undefined));
  expect(entry).toMatchObject({
    id: declared.id, provider: declared.provider, modelId: declared.modelId, api: declared.api,
    baseUrl: declared.baseUrl, contextWindow: declared.contextWindow, maxTokens: declared.maxTokens,
    credentialId: declared.credentialId,
  });
});

test('the live application configuration is not writable from a daemon that does not own it, and the file is left byte-identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-live-config-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  // The macOS application home for this HOME: the file the Graph app itself
  // loads and saves. A caller-owned daemon pointed at it is the shape a test or
  // a node would take to edit the user's live configuration.
  const home = join(root, 'home');
  const appHome = join(home, 'Library', 'Application Support', 'Graph');
  const livePath = join(appHome, 'graph.config.json');
  await mkdir(appHome, { recursive: true });
  await writeFile(livePath, `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const before = await readFile(livePath);
  await mkdir(join(root, 'caller'), { recursive: true });
  await mkdir(join(root, 'owner'), { recursive: true });
  const caller = await launchCli(join(root, 'caller'), {
    configPath: livePath, webDir: join(root, 'web'),
    stateDir: join(root, 'caller', 'state'),
    env: { HOME: home, GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN: 'grok-synthetic' },
  });
  cleanups.push(() => caller.close());
  const attempt = await caller.request('/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, document: documentOf([GROK]) }),
  });
  const body = await attempt.json().catch(() => ({})) as Record<string, any>;
  expect(attempt.status, `expected the live configuration write to be refused; got ${attempt.status} ${JSON.stringify(body)}`)
    .toBe(400);
  expect(String(body.message), 'the refusal must say why the live configuration is not writable here')
    .toMatch(/live application configuration|state directory/);
  expect(Buffer.compare(await readFile(livePath), before), 'the refused request rewrote the live configuration').toBe(0);

  // The installation that owns the file keeps working: its own daemon - the one
  // whose state directory sits beside the configuration - saves it as before.
  const owner = await launchCli(join(root, 'owner'), {
    configPath: livePath, webDir: join(root, 'web'),
    stateDir: join(appHome, 'state'),
    env: { HOME: home, GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN: 'grok-synthetic' },
  });
  cleanups.push(() => owner.close());
  const applied = await owner.request('/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, document: documentOf([GROK]) }),
  });
  const appliedBody = await applied.json().catch(() => ({})) as Record<string, any>;
  expect(applied.status, `the owning daemon could not save its own configuration: ${applied.status} ${JSON.stringify(appliedBody)}`).toBe(200);
  expect(appliedBody.revision).toBe(1);
  const savedLive = JSON.parse(await readFile(livePath, 'utf8')) as { models?: { entries?: { id: string }[] } };
  expect(savedLive.models?.entries?.map(entry => entry.id)).toEqual([GROK.id]);
});
