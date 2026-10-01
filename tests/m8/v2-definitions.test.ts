import { describe, expect, test } from 'vitest';
import { pipelineDefinition, reworkDefinition, dualReviewDefinition } from '../fixtures/v2-definitions.ts';
import { protocolReferenced } from '../../src/core/interface-spec.ts';

const at = <T,>(record: Record<string, T>, key: string): T => {
  const value = record[key];
  if (value === undefined) throw new Error(`missing key ${key}`);
  return value;
};

/**
 * Issue #1 §13.1: three executable definitions must parse and carry the structure
 * the later phases will run. These assertions are on the definition's own outward
 * shape, so they survive internal refactors of the parser.
 */
describe('executable definitions (Issue #1 §13.1)', () => {
  test('pipeline: one agent, one required output, completion on that output', () => {
    expect(pipelineDefinition.schemaVersion).toBe(2);
    expect(Object.keys(pipelineDefinition.nodes)).toEqual(['worker']);
    expect(at(pipelineDefinition.nodes, 'worker').submission.required).toEqual(['result']);
    expect(pipelineDefinition.completion?.on).toBe('result');
    expect(pipelineDefinition.completion?.drain).toBe(true);
  });

  test('rework: a router sends failed reviews back to the worker over an ordinary edge', () => {
    expect(Object.keys(reworkDefinition.edges).sort()).toEqual(['review-route', 'rework', 'worker-review']);
    expect(at(reworkDefinition.edges, 'rework').to).toBe('worker.rework');
    expect(at(reworkDefinition.modules, 'review-route').trigger).toBe('each');
    expect(at(reworkDefinition.modules, 'review-route').rules?.length).toBe(2);
    expect(protocolReferenced(reworkDefinition, 'review-result')).toBe(true);
  });

  test('dual review: two reviewers fan into one once-module with explicit required inputs', () => {
    expect(Object.keys(dualReviewDefinition.nodes).sort()).toEqual(['reviewer-a', 'reviewer-b', 'worker']);
    const fanIn = at(dualReviewDefinition.modules, 'fan-in');
    expect(fanIn.trigger).toBe('once');
    expect(fanIn.requiredInputs).toEqual(['a', 'b']);
    expect(at(dualReviewDefinition.edges, 'a-fanin').to).toBe('fan-in.a');
    expect(at(dualReviewDefinition.edges, 'b-fanin').to).toBe('fan-in.b');
  });

  test('no definition relies on the legacy dependsOn/when/loops scheduler fields', () => {
    for (const definition of [pipelineDefinition, reworkDefinition, dualReviewDefinition]) {
      const text = JSON.stringify(definition);
      expect(text).not.toContain('dependsOn');
      expect(text).not.toContain('loops');
      // The legacy node field was a `when: {node, case}` selector. Module rules use
      // `when` as an expression keyword, which is the new shape, not the old one.
      for (const node of Object.values(definition.nodes)) {
        expect(node).not.toHaveProperty('when');
        expect(node).not.toHaveProperty('dependsOn');
      }
    }
  });
});
