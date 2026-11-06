import { expect, test } from 'vitest';

import { fullAccessPolicy, standardAccessPolicy } from '../../src/core/access-policy-presets.ts';
import { configFile, session, start, stubProvider, temp } from './settings-ui.fixture.ts';

/**
 * The console builds the access document it saves from `access-policy-presets.ts`,
 * while the backend decides what that document means from `core_access_policy_presets.go`.
 * Those are two hand-written copies of the same eight axes, so this case pins them
 * together: whoever edits one side and forgets the other turns this red instead of
 * quietly changing what "fully trusted" means.
 */
test('the console presets and the policy the backend reads back agree on every axis', async () => {
  for (const [name, preset] of [['standard', standardAccessPolicy()], ['full', fullAccessPolicy()]] as const) {
    const dir = await temp(`preset-${name}`);
    const stub = await stubProvider();
    const path = await configFile(dir, stub.baseUrl, { access: preset });
    const daemon = await start(dir, path);
    const api = await session(daemon.url);
    const body = await (await api.get('/api/config')).json() as { config: { access: unknown } };
    console.log(`[preset ${name}] ${JSON.stringify(body.config.access)}`);
    expect(body.config.access, `the ${name} preset the console writes is not the policy the backend reads`).toEqual(preset);
  }
}, 120_000);

