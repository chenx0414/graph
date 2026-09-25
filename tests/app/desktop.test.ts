import { describe, expect, test } from 'vitest';
import {
  appRootFilePath, applySecretRequest, daemonArgs, isLoopbackUrl, loadSecrets, parseBannerAddress, resolveAppPaths,
  loadRawSecretEntries, resolveDaemonMode, resolveSourceRoot, resourceDirectory, rsiRestartDecision, saveSecrets, tailText, taskNotifications,
  trayIconPath, trayMenuItems,
  type AppPaths, type SecretCodec,
} from '../../desktop/lib.ts';

const codec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`),
  decryptString: value => value.toString().replace(/^sealed:/, ''),
};

const banner = [
  'Graph console',
  '  mode:      view-only (history, settings and graph; no model dispatch)',
  '  config:    none — first run; add graph.config.json to enable projects and models',
  '  state:     /tmp/state',
  '  web:       /tmp/web',
  '  models:    0 configured, 0 enabled',
  '  address:   http://127.0.0.1:53631',
].join('\n');

const paths: AppPaths = {
  root: '/repo', sourceRoot: '/repo', stateDir: '/repo/state', graphHome: '/repo/.graph', configPath: '/repo/graph.config.json',
  secretsPath: '/repo/secrets.json', serverEntry: '/repo/src/server/cli.ts', webDir: '/repo/dist/web',
};

describe('desktop app paths', () => {
  test('dev layout serves the repository web build and keeps state in userData', () => {
    const resolved = resolveAppPaths({ appPath: '/repo', isPackaged: false, userData: '/home/me/Library/Application Support/Graph', graphHome: '/home/me/.graph' });
    expect(resolved.root).toBe('/repo');
    expect(resolved.sourceRoot).toBe('/repo');
    expect(resolved.serverEntry).toBe('/repo/src/server/cli.ts');
    expect(resolved.webDir).toBe('/repo/dist/web');
    expect(resolved.stateDir).toBe('/home/me/Library/Application Support/Graph/state');
    expect(resolved.graphHome).toBe('/home/me/.graph');
    expect(resolved.configPath).toBe('/home/me/Library/Application Support/Graph/graph.config.json');
  });

  test('packaged layout reads server and web from the app directory', () => {
    const resolved = resolveAppPaths({ appPath: '/Applications/Graph.app/Contents/Resources/app', isPackaged: true, userData: '/home/me/Library/Application Support/Graph' });
    expect(resolved.root).toBe('/Applications/Graph.app/Contents/Resources/app');
    expect(resolved.webDir).toBe('/Applications/Graph.app/Contents/Resources/app/web');
    expect(resolved.serverEntry).toBe('/Applications/Graph.app/Contents/Resources/app/src/server/cli.ts');
    expect(resolved.sourceRoot).toBe('/Applications/Graph.app/Contents/Resources/app');
  });

  test('a GRAPH_RSI_ROOT source checkout runs the daemon from that checkout', () => {
    const resolved = resolveAppPaths({
      appPath: '/Applications/Graph.app/Contents/Resources/app',
      isPackaged: true,
      userData: '/home/me/Library/Application Support/Graph',
      sourceRoot: '/work/graph',
    });
    expect(resolved.root).toBe('/Applications/Graph.app/Contents/Resources/app');
    expect(resolved.sourceRoot).toBe('/work/graph');
    expect(resolved.serverEntry).toBe('/work/graph/src/server/cli.ts');
    expect(resolved.webDir).toBe('/work/graph/dist/web');
  });

  test('resource libraries resolve to allowlisted local storage roots', () => {
    expect(resourceDirectory('/home/me/.graph', 'skills')).toBe('/home/me/.graph/capabilities/skills');
    expect(resourceDirectory('/home/me/.graph', 'mcp')).toBe('/home/me/.graph/capabilities/mcp');
    expect(resourceDirectory('/home/me/.graph', 'pi-extensions')).toBe('/home/me/.graph/capabilities/pi-extensions');
    expect(resourceDirectory('/home/me/.graph', 'agent-md')).toBe('/home/me/.graph/capabilities/agent-md');
    expect(resourceDirectory('/home/me/.graph', 'prompts')).toBe('/home/me/.graph/prompts');
  });
});

describe('daemon launch contract', () => {
  test('passes an explicit state dir, web dir and a free port', () => {
    expect(daemonArgs({ paths, port: 0, mode: 'view', hasConfig: false })).toEqual([
      '--state-dir', paths.stateDir, '--graph-home', paths.graphHome, '--web-dir', paths.webDir, '--port', '0',
    ]);
  });

  test('adds the config and execute flag only when usable', () => {
    expect(daemonArgs({ paths, port: 4173, mode: 'execute', hasConfig: true })).toEqual([
      '--state-dir', paths.stateDir, '--graph-home', paths.graphHome, '--web-dir', paths.webDir, '--port', '4173',
      '--config', paths.configPath, '--execute',
    ]);
  });

  test('parses only the loopback banner address', () => {
    expect(parseBannerAddress(banner)).toBe('http://127.0.0.1:53631');
    expect(parseBannerAddress('  address:   http://10.0.0.5:4173')).toBeUndefined();
    expect(parseBannerAddress('  address:   http://127.0.0.1:4173/path')).toBe('http://127.0.0.1:4173');
    expect(parseBannerAddress('no address here')).toBeUndefined();
    expect(isLoopbackUrl('http://127.0.0.1:9/a')).toBe(true);
    expect(isLoopbackUrl('http://evil.example/')).toBe(false);
  });

  test('execute mode needs one resolvable model; unresolved models stay disabled', () => {
    const config = {
      version: 1,
      models: { entries: [{ id: 'local', credentialId: 'local' }, { id: 'go', credentialId: 'go' }] },
      credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' }, go: { secretRef: 'OPENCODE_GO_API_KEY' } },
    };
    expect(resolveDaemonMode(undefined, {}, {})).toBe('view');
    expect(resolveDaemonMode({ ...config, models: { entries: [] } }, {}, {})).toBe('view');
    expect(resolveDaemonMode(config, {}, {})).toBe('view');
    // One broken credential must not force the whole daemon into view-only.
    expect(resolveDaemonMode(config, { OPENCODE_GO_API_KEY: 'x' }, {})).toBe('execute');
    expect(resolveDaemonMode(config, {}, { OPENCODE_GO_API_KEY: 'x' })).toBe('execute');
    expect(resolveDaemonMode(config, { GRAPH_LOCAL_KEY: 'x' }, {})).toBe('execute');
    expect(resolveDaemonMode({ ...config, models: { entries: [{ id: 'local', credentialId: 'missing' }] } }, { OPENCODE_GO_API_KEY: 'x' }, {})).toBe('view');
  });
});

describe('keychain secrets file', () => {
  test('round-trips through the safeStorage codec without plaintext keys', () => {
    const files = new Map<string, string>();
    expect(saveSecrets('/secrets.json', codec, { GRAPH_A_KEY: 'sk-a' }, (path, data) => files.set(path, data))).toBe(true);
    const raw = files.get('/secrets.json')!;
    expect(raw).not.toContain('sk-a');
    expect(loadSecrets('/secrets.json', codec, path => files.get(path)!)).toEqual({ GRAPH_A_KEY: 'sk-a' });
  });

  test('degrades to no secrets when encryption is unavailable or the file is corrupt', () => {
    const unavailable: SecretCodec = { ...codec, isEncryptionAvailable: () => false };
    expect(loadSecrets('/secrets.json', unavailable, () => '{}')).toEqual({});
    expect(saveSecrets('/secrets.json', unavailable, { A: 'x' }, () => { throw new Error('must not write'); })).toBe(false);
    expect(loadSecrets('/secrets.json', codec, () => 'not json')).toEqual({});
    expect(loadSecrets('/secrets.json', codec, () => '{"version":1,"entries":{"A":"%%%"}}')).toEqual({});
  });

  test('a save preserves store entries the caller never touched', () => {
    const files = new Map<string, string>();
    // One entry this app instance cannot decrypt is still an entry the user
    // saved; a write for another ref must not erase it.
    files.set('/secrets.json', JSON.stringify({ version: 1, entries: { STALE_KEY: 'not-base64', GRAPH_A_KEY: codec.encryptString('sk-a').toString('base64') } }));
    expect(saveSecrets('/secrets.json', codec, { GRAPH_A_KEY: 'sk-a', GRAPH_B_KEY: 'sk-b' }, (path, data) => files.set(path, data), {
      raw: loadRawSecretEntries('/secrets.json', path => files.get(path)!),
      touched: ['GRAPH_B_KEY'],
    })).toBe(true);
    const written = JSON.parse(files.get('/secrets.json')!) as { entries: Record<string, string> };
    expect(Object.keys(written.entries).sort()).toEqual(['GRAPH_A_KEY', 'GRAPH_B_KEY', 'STALE_KEY']);
    expect(written.entries.STALE_KEY).toBe('not-base64');
  });

  test('an explicit revocation still removes its entry even when it cannot be decrypted', () => {
    const files = new Map<string, string>();
    files.set('/secrets.json', JSON.stringify({ version: 1, entries: { STALE_KEY: 'not-base64', GRAPH_A_KEY: codec.encryptString('sk-a').toString('base64') } }));
    expect(saveSecrets('/secrets.json', codec, { GRAPH_A_KEY: 'sk-a' }, (path, data) => files.set(path, data), {
      raw: loadRawSecretEntries('/secrets.json', path => files.get(path)!),
      touched: ['STALE_KEY'],
    })).toBe(true);
    const written = JSON.parse(files.get('/secrets.json')!) as { entries: Record<string, string> };
    expect(Object.keys(written.entries)).toEqual(['GRAPH_A_KEY']);
  });

  test('tails logs for bounded dialogs', () => {
    expect(tailText('a\n\nb\nc\n', 2)).toBe('b\nc');
  });
});

describe('tray surface', () => {
  test('points at the template image and reports open questions', () => {
    expect(trayIconPath('/app')).toBe('/app/build/trayTemplate.png');
    const items = trayMenuItems(2);
    expect(items[0]).toMatchObject({ label: '打开控制台', action: 'open' });
    expect(items[1]).toMatchObject({ label: '待处理问题 2', enabled: false });
    expect(items[2]?.separator).toBe(true);
    expect(items[3]).toMatchObject({ label: '退出 Graph', action: 'quit' });
    expect(trayMenuItems(0)[1]?.label).toBe('没有待处理问题');
  });
});

describe('desktop task notifications', () => {
  test('primes on the first snapshot and reports new questions and terminal states', () => {
    const first = taskNotifications({ primed: false, questions: {}, status: {} }, [
      { id: 'a', request: 'first task', status: 'running', openQuestions: 1 },
    ]);
    expect(first.notifications).toEqual([]);
    expect(first.openTotal).toBe(1);
    expect(first.state).toMatchObject({ primed: true, questions: { a: 1 }, status: { a: 'running' } });

    const second = taskNotifications(first.state, [
      { id: 'a', request: 'first task', status: 'running', openQuestions: 2 },
      { id: 'b', request: 'second task', status: 'completed' },
    ]);
    expect(second.notifications.map(item => item.title)).toEqual(['任务需要处理']);
    expect(second.notifications[0]?.taskId).toBe('a');
    expect(second.openTotal).toBe(2);

    const third = taskNotifications(second.state, [
      { id: 'a', request: 'first task', status: 'completed', openQuestions: 0 },
      { id: 'b', request: 'second task', status: 'completed' },
    ]);
    expect(third.notifications.map(item => item.title)).toEqual(['任务已完成']);
    expect(third.notifications[0]?.body).toBe('first task');
  });

  test('does not notify for answered questions or unchanged terminal tasks', () => {
    const state = { primed: true, questions: { a: 0 }, status: { a: 'completed' } };
    const result = taskNotifications(state, [
      { id: 'a', request: 'done', status: 'completed', openQuestions: 0 },
    ]);
    expect(result.notifications).toEqual([]);
    expect(result.openTotal).toBe(0);
  });
});

describe('desktop secret bridge contract (C04)', () => {
  test('null expresses an explicit revocation and empty strings do not', () => {
    const before = { KEY_A: 'one', KEY_B: 'two' };
    const revoked = applySecretRequest(before, 'KEY_A', null);
    expect(revoked).toEqual({ ok: true, secrets: { KEY_B: 'two' }, revoked: true });
    // The caller's map is untouched.
    expect(before).toEqual({ KEY_A: 'one', KEY_B: 'two' });
    const set = applySecretRequest(before, 'KEY_C', '  value  ');
    expect(set).toEqual({ ok: true, secrets: { KEY_A: 'one', KEY_B: 'two', KEY_C: 'value' }, revoked: false });
    expect(applySecretRequest(before, 'KEY_C', '   ')).toMatchObject({ ok: false });
    expect(applySecretRequest(before, 'KEY_C', 42)).toMatchObject({ ok: false });
    expect(applySecretRequest(before, 'bad ref', 'x')).toMatchObject({ ok: false });
    // Revoking an unknown ref is still a valid no-op revocation.
    expect(applySecretRequest(before, 'KEY_Z', null)).toEqual({ ok: true, secrets: { KEY_A: 'one', KEY_B: 'two' }, revoked: true });
  });
});

describe('the checkout the daemon executes', () => {
  const canServe = (root: string) => root === '/work/product' || root === '/work/rsi';

  test('the app root file names the checkout the app runs, ahead of a stale environment', () => {
    // The file is what survives a Finder launch, so it wins over whatever the environment says.
    expect(resolveSourceRoot({ fileRoot: '/work/product\n', envRoot: '/work/stale', canServe })).toBe('/work/product');
  });

  test('a root that cannot serve the console is skipped instead of leaving a blank window', () => {
    expect(resolveSourceRoot({ fileRoot: '/work/half-prepared', envRoot: '/work/rsi', canServe })).toBe('/work/rsi');
    expect(resolveSourceRoot({ fileRoot: '/work/half-prepared', canServe })).toBeUndefined();
  });

  test('an environment-only dev run still works and a blank value falls back', () => {
    expect(resolveSourceRoot({ envRoot: ' /work/rsi ', canServe })).toBe('/work/rsi');
    expect(resolveSourceRoot({ fileRoot: '   ', envRoot: '', canServe })).toBeUndefined();
    expect(resolveSourceRoot({ canServe })).toBeUndefined();
  });

  test('the root file lives in the graph home the app already uses', () => {
    expect(appRootFilePath('/home/me/.graph')).toBe('/home/me/.graph/app-root');
  });
});

describe('self-improvement reload decision', () => {
  const pending = { pendingRestart: { id: 'rsi-1', root: '/graph', branch: 'rsi/x', commit: 'c'.repeat(40), requestedAt: 1 } };

  test('reloads only when a request is pending and no operation is running', () => {
    expect(rsiRestartDecision({ ...pending, canRestart: true }, false)).toEqual({ id: 'rsi-1' });
    expect(rsiRestartDecision({ ...pending, canRestart: false }, false)).toBeNull();
    expect(rsiRestartDecision({ ...pending, canRestart: true }, true)).toBeNull();
    expect(rsiRestartDecision({ pendingRestart: null, canRestart: true }, false)).toBeNull();
    expect(rsiRestartDecision(null, false)).toBeNull();
    expect(rsiRestartDecision({ pendingRestart: {}, canRestart: true }, false)).toBeNull();
  });
});
