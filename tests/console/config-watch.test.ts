import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { configDigest, createConfigWatch } from '../../src/server/config-watch.ts';
import { parseGraphConfig, type GraphConfig } from '../../src/server/config.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanups.reverse()) await action();
  cleanups.length = 0;
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'graph-config-watch-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function document(revision: number, modelId: string) {
  return {
    version: 1,
    revision,
    projects: [],
    credentials: { custom: { secretRef: 'GRAPH_PROVIDER_API_KEY' } },
    models: {
      entries: [{
        id: modelId, provider: 'custom', grade: 'medium', api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1', contextWindow: 8000, maxTokens: 1000, credentialId: 'custom',
      }],
    },
  };
}

/** Drives the watcher without file-system timing: every call re-reads the file. */
async function watcher(dir: string) {
  const applied: { revision: number; id: string }[] = [];
  const watch = createConfigWatch({
    path: join(dir, 'graph.config.json'),
    log: () => {},
    watch: false,
    readFile: async () => await (await import('node:fs/promises')).readFile(join(dir, 'graph.config.json'), 'utf8'),
    parse: text => {
      const raw = JSON.parse(text) as { revision?: number };
      return { config: parseGraphConfig(raw, join(dir, 'graph.config.json')), revision: typeof raw.revision === 'number' ? raw.revision : null };
    },
    apply: (config: GraphConfig, revision: number) => {
      applied.push({ revision, id: config.models?.entries[0]?.id ?? '' });
      return { applied: true };
    },
  });
  return { watch, applied };
}

test('a changed document is applied and an identical one is not', async () => {
  const dir = await temp();
  await writeFile(join(dir, 'graph.config.json'), JSON.stringify(document(1, 'model-a')));
  const { watch, applied } = await watcher(dir);
  await watch.handleChange();
  expect(applied).toEqual([{ revision: 1, id: 'model-a' }]);
  // The daemon's own save writes the same document again: the watcher must stay quiet.
  await watch.handleChange();
  expect(applied).toHaveLength(1);
  // A hand edit that does not bump the revision is still a change (content decides).
  await writeFile(join(dir, 'graph.config.json'), JSON.stringify(document(1, 'model-b')));
  await watch.handleChange();
  expect(applied).toEqual([{ revision: 1, id: 'model-a' }, { revision: 1, id: 'model-b' }]);
  expect(watch.report()).toMatchObject({ applied: 2, ignored: 1, lastReason: null, fileRevision: 1 });
});

test('an unparsable document keeps the previous configuration and reports why', async () => {
  const dir = await temp();
  await writeFile(join(dir, 'graph.config.json'), JSON.stringify(document(1, 'model-a')));
  const { watch, applied } = await watcher(dir);
  await watch.handleChange();
  await writeFile(join(dir, 'graph.config.json'), '{"version":1,"models":{"entries":[{"id":"broken"}]}}');
  await watch.handleChange();
  expect(applied).toHaveLength(1);
  expect(watch.report().lastReason).toMatch(/grade|api|credentialId/);
  expect(watch.report().applied).toBe(1);
});

test('a truncated file during a write is retried instead of reported as a bad document', async () => {
  const dir = await temp();
  await writeFile(join(dir, 'graph.config.json'), JSON.stringify(document(1, 'model-a')));
  const { watch, applied } = await watcher(dir);
  await watch.handleChange();
  await writeFile(join(dir, 'graph.config.json'), '{"version":1,"rev');
  await watch.handleChange();
  // Not valid JSON: the next event decides, and the previous state is untouched.
  expect(applied).toHaveLength(1);
  expect(watch.report().applied).toBe(1);
  await writeFile(join(dir, 'graph.config.json'), JSON.stringify(document(1, 'model-a')));
  await watch.handleChange();
  expect(applied).toHaveLength(1);
});

test('the digest follows the configuration, not the revision or key order', () => {
  const config = (doc: object) => parseGraphConfig(doc, '/tmp/graph.config.json');
  expect(configDigest(config(document(1, 'model-a')))).toBe(configDigest(config(document(2, 'model-a'))));
  expect(configDigest(config(document(1, 'model-a')))).toBe(configDigest(config(document(1, 'model-a'))));
  expect(configDigest(config(document(1, 'model-a')))).not.toBe(configDigest(config(document(1, 'model-b'))));
});

test('the real watcher notices a file that is replaced by rename', async () => {
  const dir = await temp();
  const path = join(dir, 'graph.config.json');
  await writeFile(path, JSON.stringify(document(1, 'model-a')));
  const applied: string[] = [];
  const watch = createConfigWatch({
    path,
    log: () => {},
    readFile: async () => await (await import('node:fs/promises')).readFile(path, 'utf8'),
    parse: text => {
      const raw = JSON.parse(text) as { revision?: number };
      return { config: parseGraphConfig(raw, path), revision: typeof raw.revision === 'number' ? raw.revision : null };
    },
    apply: config => { applied.push(config.models?.entries[0]?.id ?? ''); return { applied: true }; },
  });
  try {
    expect(watch.report().watching).toBe(true);
    await watch.handleChange();
    // Atomic saves write a temporary file and rename it over the target.
    await writeFile(join(dir, 'graph.config.json.tmp'), JSON.stringify(document(2, 'model-c')));
    const { rename } = await import('node:fs/promises');
    await rename(join(dir, 'graph.config.json.tmp'), path);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(applied).toEqual(['model-a', 'model-c']);
  } finally {
    watch.stop();
  }
}, 20_000);
