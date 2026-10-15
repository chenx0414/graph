import { describe, expect, test } from 'vitest';
import { ensureConfigFile } from '../../desktop/lib.ts';

describe('config seeding', () => {
  test('writes the smallest valid document once', () => {
    const files = new Map<string, string>();
    const write = (path: string, data: string) => files.set(path, data);
    expect(ensureConfigFile('/cfg/graph.config.json', path => files.has(path), write)).toBe(true);
    const seeded = JSON.parse(files.get('/cfg/graph.config.json')!);
    expect(seeded).toEqual({ version: 1, projects: [] });
    files.set('/cfg/graph.config.json', '{"version":1,"projects":[{"id":"x","root":"/x"}]}');
    expect(ensureConfigFile('/cfg/graph.config.json', path => files.has(path), write)).toBe(true);
    expect(files.get('/cfg/graph.config.json')).toContain('"id": "x"'.replace('": "', '":"'));
  });

  test('reports failure instead of throwing when the path is not writable', () => {
    expect(ensureConfigFile('/nope/config.json', () => false, () => { throw new Error('EROFS'); })).toBe(false);
  });
});
