import { describe, expect, test } from 'vitest';
import { parseGraphDefinition, type GraphDefinition } from '../../src/core/interface-spec.ts';
import { expandSubgraph } from '../../src/core/subgraph.ts';

/**
 * Issue #1 §2, §9 — subgraph expansion.
 *
 * Failure modes first (R24):
 *   S1  a subgraph's public io maps into the parent's connection model
 *   S2  expansion produces NO extra execution (it is all compiled connections)
 *   S3  two instances of the same template have isolated stable paths
 *   S4  the template version is pinned; a modified template does not hot-change an instance
 *   S5  a subgraph's public output still points at one of its own nodes
 */

const template = (): GraphDefinition => parseGraphDefinition({
  schemaVersion: 2, name: 'inner',
  protocols: {
    job: { type: 'object', required: ['goal'], properties: { goal: { type: 'string' } } },
    done: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
  },
  nodes: {
    work: { recipe: 'w@1', task: 'work', inputs: { in: { protocol: 'job' } }, outputs: { out: { protocol: 'done' } }, submission: { required: ['out'] } },
  },
  modules: {}, edges: {},
  inputs: { job: { to: 'work.in', protocol: 'job' } },
  outputs: { result: { from: 'work.out', protocol: 'done' } },
});

describe('expandSubgraph — public io maps into the parent (§9)', () => {
  test('S1/S5: node paths are stable and prefixed, and public io is re-pointed', () => {
    const expanded = expandSubgraph({
      instance: 'build',
      template: template(),
      templateVersion: 7,
    });
    // Stable path identity: instance/nodeId.
    expect(Object.keys(expanded.nodes)).toEqual(['build/work']);
    expect(expanded.nodes['build/work']!.inputs.in!.protocol).toBe('job');
    // The subgraph's public input now targets the prefixed endpoint.
    expect(expanded.inputs.job).toEqual({ to: 'build/work.in', protocol: 'job' });
    expect(expanded.outputs.result).toEqual({ from: 'build/work.out', protocol: 'done' });
    // The template version is pinned.
    expect(expanded.templateVersion).toBe(7);
  });

  test('S2: expansion adds no module and no synthetic scheduler step', () => {
    const expanded = expandSubgraph({ instance: 'build', template: template(), templateVersion: 1 });
    expect(Object.keys(expanded.modules)).toEqual([]);
    // Edges inside the template, if any, are re-pointed but nothing extra is added.
    expect(expanded.edges).toEqual({});
  });

  test('S3: two instances of one template have isolated paths', () => {
    const first = expandSubgraph({ instance: 'build', template: template(), templateVersion: 1 });
    const second = expandSubgraph({ instance: 'test', template: template(), templateVersion: 1 });
    expect(Object.keys(first.nodes)).toEqual(['build/work']);
    expect(Object.keys(second.nodes)).toEqual(['test/work']);
    expect(first.inputs.job!.to).toBe('build/work.in');
    expect(second.inputs.job!.to).toBe('test/work.in');
  });

  test('S4: a template change does not alter an already-expanded instance', () => {
    const pinned = expandSubgraph({ instance: 'build', template: template(), templateVersion: 1 });
    const changed = template();
    changed.nodes['work'] = { recipe: 'w@2', task: 'work v2', inputs: { in: { protocol: 'job' } }, outputs: { out: { protocol: 'done' } }, submission: { required: ['out'] } };
    const fresh = expandSubgraph({ instance: 'build', template: changed, templateVersion: 2 });
    // The pinned instance still references the old recipe and version.
    expect(pinned.nodes['build/work']!.recipe).toBe('w@1');
    expect(pinned.templateVersion).toBe(1);
    expect(fresh.nodes['build/work']!.recipe).toBe('w@2');
  });

  test('S1: an internal edge between two template nodes is re-pointed, not duplicated', () => {
    const twoNode = parseGraphDefinition({
      schemaVersion: 2, name: 'inner2',
      protocols: { j: { type: 'object' }, k: { type: 'object' } },
      nodes: {
        a: { recipe: 'a@1', task: 'a', inputs: { in: { protocol: 'j' } }, outputs: { out: { protocol: 'k' } }, submission: { required: ['out'] } },
        b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'k' } }, outputs: { out: { protocol: 'j' } }, submission: { required: ['out'] } },
      },
      modules: {}, edges: { ab: { from: 'a.out', to: 'b.in', enabled: true } },
      inputs: { j: { to: 'a.in', protocol: 'j' } }, outputs: { k: { from: 'b.out', protocol: 'j' } },
    });
    const expanded = expandSubgraph({ instance: 'inner', template: twoNode, templateVersion: 1 });
    expect(expanded.edges.ab).toEqual({ from: 'inner/a.out', to: 'inner/b.in', enabled: true });
    expect(expanded.inputs.j!.to).toBe('inner/a.in');
    expect(expanded.outputs.k!.from).toBe('inner/b.out');
  });
});


test('formal declaration compiles two pinned instances and parent connections without state aliasing', () => {
  const inner = template();
  inner.nodes.review = { ...structuredClone(inner.nodes.work!), inputs: { in: { protocol: 'done' } }, outputs: { out: { protocol: 'done' } } };
  inner.edges.review = { from: 'work.out', to: 'review.in', enabled: true };
  inner.outputs.result = { from: 'review.out', protocol: 'done' };
  const parent = parseGraphDefinition({ schemaVersion: 2, name: 'parent', protocols: {}, nodes: {}, modules: {},
    templates: { build: { version: 7, definition: inner } },
    instances: { first: { template: 'build', version: 7 }, second: { template: 'build', version: 7 } },
    edges: {}, inputs: { start: { to: 'first.job', protocol: 'job' } }, outputs: { end: { from: 'second.result', protocol: 'done' } } });
  expect(Object.keys(parent.nodes)).toEqual(['first/work', 'first/review', 'second/work', 'second/review']);
  expect(Object.keys(parent.edges)).toEqual(['first/review', 'second/review']);
  expect(parent.inputs.start?.to).toBe('first/work.in');
  expect(parent.outputs.end?.from).toBe('second/review.out');
  parent.nodes['first/work']!.task = 'modified';
  expect(parent.nodes['second/work']!.task).toBe('work');
  expect(inner.nodes.work!.task).toBe('work');
  expect(parseGraphDefinition(parent).subgraphInstances?.first?.version).toBe(7);
  expect(() => parseGraphDefinition({ ...parent, templates: { build: { version: 8, definition: inner } }, instances: { third: { template: 'build', version: 7 } } })).toThrow(/version/);
});

// Nested reusable definitions need the full instance hierarchy for ports and folding.
test('nested instances preserve their public interfaces and independent container paths', () => {
  const middle = { schemaVersion: 2, name: 'middle', protocols: {}, nodes: {}, modules: {}, edges: {},
    templates: { leaf: { version: 3, definition: template() } }, instances: { inner: { template: 'leaf', version: 3 } },
    inputs: { job: { to: 'inner.job', protocol: 'job' } }, outputs: { result: { from: 'inner.result', protocol: 'done' } } };
  const outer = parseGraphDefinition({ schemaVersion: 2, name: 'outer', protocols: {}, nodes: {}, modules: {}, edges: {},
    templates: { middle: { version: 2, definition: middle } }, instances: { first: { template: 'middle', version: 2 }, second: { template: 'middle', version: 2 } },
    inputs: { job: { to: 'first.job', protocol: 'job' } }, outputs: { result: { from: 'second.result', protocol: 'done' } } });
  expect(outer.subgraphInstances?.['first/inner']?.inputs.job?.to).toBe('first/inner/work.in');
  expect(outer.subgraphInstances?.['second/inner']?.outputs.result?.from).toBe('second/inner/work.out');
  expect(outer.inputs.job?.to).toBe('first/inner/work.in');
  expect(outer.outputs.result?.from).toBe('second/inner/work.out');
  expect(parseGraphDefinition(outer).subgraphs).toEqual(['first', 'first/inner', 'second', 'second/inner']);
});
