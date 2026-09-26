import { expect, test } from 'vitest';
import { emptyGraphConfig, parseGraphConfig } from '../../src/server/config.ts';
import { sanitizeConfig } from '../../src/server/config-service.ts';
import { sedimentSettings } from '../../src/runtime/sediment.ts';

// The sedimentation switch is only real if it survives the whole path a document travels: the
// parser that builds the runtime config, the sanitizer that hands the document back to the console,
// and the reader the adapter asks. A switch the parser drops is a feature nobody can turn on.
const MODELS = {
  entries: [{
    id: 'reader', provider: 'custom', grade: 'low', api: 'openai-completions',
    baseUrl: 'https://x.example/v1', contextWindow: 1_000, maxTokens: 100, credentialId: 'a',
  }],
};
const document = (skills?: unknown) => ({
  version: 1, revision: 0, projects: [],
  credentials: { a: { secretRef: 'GRAPH_KEY_A' } },
  models: MODELS,
  ...(skills === undefined ? {} : { skills }),
});

test('the sedimentation switch survives the config document and reaches the reader', () => {
  const parsed = parseGraphConfig(document({ sedimentation: { enabled: true, afterToolCalls: 4, model: 'reader', budgetTokens: 20_000 } }), '/tmp/graph.config.json');
  // What the console gets back must be the same switch, or the next save would remove it.
  const sanitized = sanitizeConfig(parsed, {}) as { skills?: unknown };
  expect(sanitized.skills).toEqual({ sedimentation: { enabled: true, afterToolCalls: 4, model: 'reader', budgetTokens: 20_000 } });
  expect(sedimentSettings(sanitized)).toEqual({ enabled: true, afterToolCalls: 4, model: 'reader', budgetTokens: 20_000 });
});

test('a document without the block keeps sedimentation off with the documented defaults', () => {
  const config = parseGraphConfig(document(), '/tmp/graph.config.json');
  expect(sedimentSettings(config)).toEqual({ enabled: false, afterToolCalls: 10, model: null, budgetTokens: 40_000 });
  // An unconfigured daemon has no models at all, and still answers.
  expect(sedimentSettings(emptyGraphConfig())).toEqual({ enabled: false, afterToolCalls: 10, model: null, budgetTokens: 40_000 });
});

test('a sanitized document can be saved again, so the switch cannot erase itself', () => {
  // The console loads the sanitized document and saves it back. `model` is null until somebody
  // names one, so null has to be a legal value to read — otherwise the round-trip rejects itself.
  const first = parseGraphConfig(document({ sedimentation: { enabled: true } }), '/tmp/graph.config.json');
  const saved = sanitizeConfig(first, {}) as { skills?: unknown };
  expect(saved.skills).toEqual({ sedimentation: { enabled: true, afterToolCalls: 10, model: null, budgetTokens: 40_000 } });
  const second = parseGraphConfig({ ...document(), ...saved, revision: 1 }, '/tmp/graph.config.json');
  expect(sedimentSettings(second)).toEqual({ enabled: true, afterToolCalls: 10, model: null, budgetTokens: 40_000 });
});

test('a malformed switch is a config error instead of a silent no-op', () => {
  const reject = (skills: unknown, pattern: RegExp) => expect(() => parseGraphConfig(document(skills), '/tmp/graph.config.json')).toThrow(pattern);
  reject({ sedimentation: { enabled: 'yes' } }, /skills\.sedimentation\.enabled/);
  reject({ sedimentation: { afterToolCalls: 0 } }, /skills\.sedimentation\.afterToolCalls/);
  reject({ sedimentation: { afterToolCalls: 2.5 } }, /skills\.sedimentation\.afterToolCalls/);
  reject({ sedimentation: { budgetTokens: -1 } }, /skills\.sedimentation\.budgetTokens/);
  reject({ sedimentation: { model: '   ' } }, /skills\.sedimentation\.model/);
  // A model that does not exist would fall back silently at runtime, so say so now.
  reject({ sedimentation: { model: 'nobody' } }, /skills\.sedimentation\.model references unknown model/);
});
