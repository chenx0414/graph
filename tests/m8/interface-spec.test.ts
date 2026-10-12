import { describe, expect, test } from 'vitest';
import {
  parseGraphDefinition, protocolReferenced, validateProtocolValue, INTERFACE_SCHEMA_VERSION,
} from '../../src/core/interface-spec.ts';
import { RuntimeError } from '../../src/core/types.ts';

/**
 * Issue #1 §4: JSON is the only formal definition format, edges must reference the
 * same protocol id and version at both ends, and a bad definition must be refused
 * whole rather than partially accepted.
 *
 * These are black-box assertions on the public parse entry point, so they stay
 * true through internal refactors of the validator.
 */

const pipeline = {
  schemaVersion: INTERFACE_SCHEMA_VERSION,
  name: 'pipeline',
  protocols: {
    'implementation-request': {
      type: 'object',
      required: ['goal'],
      properties: { goal: { type: 'string' } },
    },
    'code-result': {
      type: 'object',
      required: ['repository', 'commit', 'artifact'],
      properties: {
        repository: { type: 'string' },
        commit: { type: 'string' },
        artifact: { type: 'object' },
      },
    },
  },
  nodes: {
    worker: {
      recipe: 'worker@1',
      task: '实现功能',
      inputs: { task: { protocol: 'implementation-request' } },
      outputs: { result: { protocol: 'code-result' } },
      submission: { required: ['result'] },
    },
  },
  edges: {},
  inputs: { task: { to: 'worker.task', protocol: 'implementation-request' } },
  outputs: { result: { from: 'worker.result', protocol: 'code-result' } },
};

/** Indexed access is checked; the tests want the value or a loud failure. */
const at = <T,>(record: Record<string, T>, key: string): T => {
  const value = record[key];
  if (value === undefined) throw new Error(`missing key ${key}`);
  return value;
};

const expectInvalid = (definition: unknown, fragment: string) => {
  try {
    parseGraphDefinition(definition);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).message).toContain(fragment);
    return;
  }
  throw new Error(`expected the definition to be refused with "${fragment}"`);
};

describe('parseGraphDefinition — pipeline shape', () => {
  test('accepts a well-formed definition and reports protocol references', () => {
    const definition = parseGraphDefinition(pipeline);
    expect(definition.schemaVersion).toBe(INTERFACE_SCHEMA_VERSION);
    expect(Object.keys(definition.nodes)).toEqual(['worker']);
    expect(at(at(definition.nodes, 'worker').inputs, 'task').protocol).toBe('implementation-request');
    expect(protocolReferenced(definition, 'code-result')).toBe(true);
    expect(protocolReferenced(definition, 'missing-protocol')).toBe(false);
  });

  test.each([
    { recipe: undefined, command: { run: 'node', args: ['--version'] } },
    { recipe: 'worker@1', command: { run: '' } },
    { recipe: 'worker@1', command: null },
  ])('nodes reject command declarations; host commands belong to modules (%j)', fields => {
    expectInvalid({ ...pipeline, nodes: { worker: { ...pipeline.nodes.worker, ...fields } } }, 'operation module');
  });

  test('unknown inputs and malformed node environments are refused with exact paths', () => {
    expectInvalid({
      ...pipeline,
      inputs: { task: { to: 'worker.missing', protocol: 'implementation-request' } },
    }, 'worker.missing');
    for (const [fields, message] of [
      [{ workspace: { base: 'project', path: '../outside' } }, 'workspace.path'],
      [{ workspace: { base: 'project', path: '/absolute' } }, 'workspace.path'],
      [{ workspace: { base: 'project', path: 'some\\path' } }, 'workspace.path'],
      [{ workspace: { base: 'elsewhere' } }, 'workspace requires base'],
      [{ access: { mode: 'standard', commands: 'shell' } }, 'access.commands'],
      [{ access: { mode: 'standard', filesystem: { unknown: true } } }, 'access.filesystem'],
      [{ access: { filesystem: { read: 'host' } } }, 'access requires mode'],
    ] as const) expectInvalid({ ...pipeline, nodes: { worker: { ...pipeline.nodes.worker, ...fields } } }, message);
  });

  test('edges require explicit boolean enablement and declared endpoints', () => {
    const valid = {
      ...pipeline,
      nodes: { worker: { ...pipeline.nodes.worker, inputs: {
        ...pipeline.nodes.worker.inputs, result: { protocol: 'code-result' },
      } } },
    };
    for (const enabled of [undefined, null, 0, 1, 'false', {}, []]) {
      expectInvalid({ ...valid, edges: { link: { from: 'worker.result', to: 'worker.result', enabled } } }, 'enabled');
    }
    for (const enabled of [false, true]) {
      expect(parseGraphDefinition({ ...valid, edges: { link: { from: 'worker.result', to: 'worker.result', enabled } } }).edges.link?.enabled).toBe(enabled);
    }
    expectInvalid({
      ...pipeline,
      edges: { 'worker-review': { from: 'worker.nope', to: 'worker.task', enabled: true } },
    }, 'worker.nope');
  });

  test('edge protocol version must agree at both ends', () => {
    // The edge itself carries no protocol; both endpoints must resolve to the same
    // protocol id AND version. An output promising v2 into an input promising v1 is refused.
    expectInvalid({
      ...pipeline,
      protocols: { ...pipeline.protocols, ping: { type: 'object' } },
      nodes: {
        worker: {
          ...pipeline.nodes.worker,
          inputs: { task: { protocol: 'implementation-request' }, ping: { protocol: 'ping' } },
          outputs: { result: { protocol: 'code-result' }, ping2: { protocol: 'ping', version: 2 } },
        },
      },
      edges: { 'mismatch': { from: 'worker.ping2', to: 'worker.ping', enabled: true } },
    }, 'ping');
  });

  test('two node ids differing only by case are distinct, but a blank id is refused', () => {
    // JSON.parse collapses duplicate keys, so id uniqueness is enforced by the map
    // itself; this pins the blank-id guard that the parser does own.
    expectInvalid({ ...pipeline, edges: { '': { from: 'worker.result', to: 'worker.task' } } }, 'blank');
  });
});

describe('parseGraphDefinition — rework and fan-in shapes (§14)', () => {
  test('a rework loop is an ordinary edge and is accepted', () => {
    const withRework = {
      ...pipeline,
      protocols: {
        ...pipeline.protocols,
        'review-result': {
          type: 'object',
          required: ['passed', 'reason', 'reviewedCommit'],
          properties: {
            passed: { type: 'boolean' },
            reason: { type: 'string' },
            reviewedCommit: { type: 'string' },
          },
        },
      },
      nodes: {
        worker: {
          ...pipeline.nodes.worker,
          inputs: {
            task: { protocol: 'implementation-request' },
            rework: { protocol: 'review-result' },
          },
        },
        reviewer: {
          recipe: 'work-reviewer@1',
          task: '审查 commit',
          inputs: { code: { protocol: 'code-result' } },
          outputs: { review: { protocol: 'review-result' } },
          submission: { required: ['review'] },
        },
      },
      edges: {
        'worker-review': { from: 'worker.result', to: 'reviewer.code', enabled: true },
        rework: { from: 'reviewer.review', to: 'worker.rework', enabled: true },
      },
    };
    const definition = parseGraphDefinition(withRework);
    expect(Object.keys(definition.edges)).toEqual(['worker-review', 'rework']);
    expect(at(definition.edges, 'rework').enabled).toBe(true);
  });

  test('two edges into the same named input is permitted (fan-in is a module job)', () => {
    const definition = parseGraphDefinition({
      ...pipeline,
      protocols: { ...pipeline.protocols, ping: { type: 'object' } },
      nodes: {
        worker: {
          ...pipeline.nodes.worker,
          inputs: { task: { protocol: 'implementation-request' }, ping: { protocol: 'ping' } },
          outputs: { result: { protocol: 'code-result' }, ping: { protocol: 'ping' } },
        },
      },
      edges: {
        a: { from: 'worker.ping', to: 'worker.ping', enabled: true },
        b: { from: 'worker.ping', to: 'worker.ping', enabled: true },
      },
    });
    expect(at(definition.edges, 'a').to).toBe('worker.ping');
    expect(at(definition.edges, 'b').to).toBe('worker.ping');
  });
});

describe('parseGraphDefinition — invalid shapes are refused whole (§15.9)', () => {
  test('unsupported schemaVersion is refused', () => {
    expectInvalid({ ...pipeline, schemaVersion: 1 }, 'schemaVersion');
  });
  test('missing protocol referenced by an output is refused', () => {
    expectInvalid({
      ...pipeline,
      nodes: { worker: { ...pipeline.nodes.worker, outputs: { result: { protocol: 'nope' } } } },
    }, 'nope');
  });
  test('required output must name a declared output', () => {
    expectInvalid({
      ...pipeline,
      nodes: { worker: { ...pipeline.nodes.worker, submission: { required: ['ghost'] } } },
    }, 'ghost');
  });
});


test('protocols enforce enum, additionalProperties and nested constraints without modifying values', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['status', 'items'], properties: {
    status: { type: 'string', enum: ['approved', 'rework'] }, items: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
  } };
  expect(validateProtocolValue(schema, { status: 'approved', items: [1] })).toBeNull();
  expect(validateProtocolValue(schema, { status: 'made-up', items: [1] })).not.toBeNull();
  expect(validateProtocolValue(schema, { status: 'approved', items: [] })).not.toBeNull();
  expect(validateProtocolValue(schema, { status: 'approved', items: [0] })).not.toBeNull();
  expect(validateProtocolValue(schema, { status: 'approved', items: [1], extra: true })).not.toBeNull();
  expectInvalid({ ...pipeline, protocols: { ...pipeline.protocols, bad: { type: 'not-a-type' } } }, 'invalid schema');
});


test.each([{ model: '' }, { model: 7 }, { retry: { automatic: -1 } }, { retry: { resubmit: 0.5 } },
  { retry: [] }, { retry: { unknown: 1 } }, { instructions: '' }, { instructions: ' \n\t' }, { instructions: 7 }, { instructions: null }])('node configuration rejects invalid model, retry or instructions declaration: %j', configuration => {
  expect(() => parseGraphDefinition({ ...pipeline, nodes: { worker: { ...pipeline.nodes.worker, ...configuration } } })).toThrow(RuntimeError);
});


test.each([
  { budget: { tokens: -1 } }, { budget: { tokens: 1.5 } }, { budget: {} },
  { budget: { tokens: 1, other: 2 } }, { budget: [] }, { retry: { automatic: -1 } }, { model: '' },
])('invalid graph execution defaults are rejected atomically: %j', defaults => {
  expect(() => parseGraphDefinition({ ...pipeline, defaults })).toThrow(/defaults/);
});


test.each([
  {},
  [{ id: 'a', description: 'inspect', kind: 'human' }, { id: 'a', description: 'again', kind: 'human' }],
  [{ id: 'a', kind: 'human' }],
  [{ id: 'a', description: 'inspect', kind: 'anything' }],
  [{ id: 'a', description: 'test', kind: 'check', module: 'missing' }],
  [{ id: 'a', description: 'review', kind: 'review', node: 'missing' }],
  [{ id: 'a', description: 'inspect', kind: 'human', passed: true }],
])('invalid final acceptance is refused as a whole: %j', acceptance => {
  expect(() => parseGraphDefinition({ ...pipeline, acceptance })).toThrow(RuntimeError);
});
