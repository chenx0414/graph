import { describe, expect, test } from 'vitest';
import {
  SETUP_TEMPLATES, buildConfigDocument, defaultSecretRef, defaultSetupForm,
  setupFieldFor, validateSetup, type SetupForm,
} from '../../src/web/setup.ts';
import { ensureConfigFile } from '../../desktop/lib.ts';

const valid: SetupForm = { ...defaultSetupForm(), projectRoot: '/tmp/project' };

describe('first-run wizard form', () => {
  test('derives environment variable names from credential ids', () => {
    expect(defaultSecretRef('local')).toBe('GRAPH_LOCAL_KEY');
    expect(defaultSecretRef('my-team key')).toBe('GRAPH_MY_TEAM_KEY_KEY');
    expect(defaultSecretRef('')).toBe('GRAPH_MODEL_KEY');
  });

  test('accepts the template defaults and rejects broken fields', () => {
    expect(validateSetup(valid)).toEqual({});
    expect(validateSetup({ ...valid, projectId: 'Bad Id' }).projectId).toBeTruthy();
    expect(validateSetup({ ...valid, projectRoot: '  ' }).projectRoot).toBeTruthy();
    expect(validateSetup({ ...valid, baseUrl: 'ftp://x' }).baseUrl).toBeTruthy();
    expect(validateSetup({ ...valid, baseUrl: 'nope' }).baseUrl).toBeTruthy();
    expect(validateSetup({ ...valid, contextWindow: 100 }).contextWindow).toBeTruthy();
    expect(validateSetup({ ...valid, maxTokens: valid.contextWindow }).maxTokens).toBeTruthy();
    expect(validateSetup({ ...valid, secretRef: 'lower-case' }).secretRef).toBeTruthy();
    expect(validateSetup({ ...valid, credentialId: 'A B' }).credentialId).toBeTruthy();
  });

  test('templates stay inside their window budget', () => {
    for (const template of Object.values(SETUP_TEMPLATES)) {
      expect(template.maxTokens).toBeLessThan(template.contextWindow);
    }
  });
});

describe('config document building', () => {
  test('creates the minimal document a daemon can load', () => {
    const document = buildConfigDocument({ version: 1 }, valid);
    expect(document.version).toBe(1);
    expect(document.projects).toEqual([{ id: 'demo', root: '/tmp/project' }]);
    expect(document.models).toMatchObject({
      entries: [{
        id: 'local-model', provider: 'local', grade: 'medium', api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:8080/v1', contextWindow: 32_768, maxTokens: 4_096, credentialId: 'local',
      }],
    });
    expect(document.credentials).toEqual({ local: { secretRef: 'GRAPH_LOCAL_KEY' } });
  });

  test('merges without dropping unrelated entries and replaces same ids', () => {
    const existing = {
      version: 1,
      projects: [{ id: 'other', root: '/other' }, { id: 'demo', root: '/old' }],
      models: { entries: [{ id: 'other-model', provider: 'x' }, { id: 'local-model', provider: 'old' }] },
      credentials: { other: { secretRef: 'GRAPH_OTHER_KEY' }, local: { secretRef: 'GRAPH_OLD_KEY' } },
    };
    const document = buildConfigDocument(existing, valid);
    expect(document.projects).toEqual([{ id: 'other', root: '/other' }, { id: 'demo', root: '/tmp/project' }]);
    expect((document.models as { entries: unknown[] }).entries).toHaveLength(2);
    expect((document.credentials as Record<string, unknown>).other).toEqual({ secretRef: 'GRAPH_OTHER_KEY' });
    expect((document.credentials as Record<string, unknown>).local).toEqual({ secretRef: 'GRAPH_LOCAL_KEY' });
  });

  test('maps API field paths back to form fields', () => {
    expect(setupFieldFor('projects[0].root')).toBe('projectRoot');
    expect(setupFieldFor('projects[0].id')).toBe('projectId');
    expect(setupFieldFor('models.entries[0].baseUrl')).toBe('baseUrl');
    expect(setupFieldFor('models.entries[0].contextWindow')).toBe('contextWindow');
    expect(setupFieldFor('models.entries[0].grade')).toBe('modelId');
    expect(setupFieldFor('credentials.local.secretRef')).toBe('secretRef');
    expect(setupFieldFor('credentials.local.sharedLimitGroupId')).toBe('credentialId');
    expect(setupFieldFor(undefined)).toBeUndefined();
  });
});

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
