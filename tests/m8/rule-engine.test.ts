import { describe, expect, test } from 'vitest';
import {
  parseRule, evaluateRule, mergeRuleOutputs, parseEmit, RuleError, type RuleEnvironment,
} from '../../src/core/rule-engine.ts';

/**
 * Issue #1 §4, §6 — the module rule expression language.
 *
 * Failure modes first (R24):
 *   R1  an unknown identifier in an expression        -> readable as a reference, never a call
 *   R2  a rule string is `eval`ed                     -> impossible; this is a parser, never eval
 *   R3  two rules emit the same output                -> refused at definition time
 *   R4  multiple matching rules                       -> outputs merged in declaration order
 *   R5  comparison / boolean / existence forms        -> all supported, no arbitrary code
 *   R6  object construction and input forwarding      -> supported ($port references)
 */

const env = (inputs: Record<string, unknown>, state: unknown = null): RuleEnvironment => ({ inputs: inputs as never, state: state as never });

describe('parseRule — a small, safe expression language', () => {
  test('R2: the parser has no eval — a call is a parse error and a dotted path reads only plain data', () => {
    // A rule is data, never code. Any call form is a parse error.
    expect(() => parseRule('process.exit(1)')).toThrow(RuleError);
    expect(() => parseRule('(() => 1)()')).toThrow(RuleError);
    // A dotted word is only a path read. `this.constructor` is not a real object
    // here: it resolves to nothing, so no prototype or function can leak through.
    const rule = parseRule('this.constructor');
    expect(evaluateRule(rule, env({}))).toBe(false);
    expect(evaluateRule(rule, env({ this: { constructor: 'anything' } }))).toBe(true);
  });

  test('R1: an unknown identifier in an expression is surfaced as a reference', () => {
    const rule = parseRule('ghost.field == 1');
    expect(rule.referencedInputs).toEqual(['ghost']);
  });
});

describe('evaluateRule — existence, fields, booleans, comparison (§4)', () => {
  test('existence and non-existence', () => {
    expect(evaluateRule(parseRule('$exists(review)'), env({ review: { passed: true } }))).toBe(true);
    expect(evaluateRule(parseRule('$exists(review)'), env({}))).toBe(false);
    expect(evaluateRule(parseRule('$missing(review)'), env({}))).toBe(true);
  });

  test('field equality and comparison', () => {
    const rule = parseRule('review.passed == false');
    expect(evaluateRule(rule, env({ review: { passed: false } }))).toBe(true);
    expect(evaluateRule(rule, env({ review: { passed: true } }))).toBe(false);
    expect(evaluateRule(parseRule('count > 3'), env({ count: 5 }))).toBe(true);
    expect(evaluateRule(parseRule('count >= 5'), env({ count: 5 }))).toBe(true);
    expect(evaluateRule(parseRule('name == "ok"'), env({ name: 'ok' }))).toBe(true);
  });

  test('boolean and/or/not with parentheses', () => {
    const rule = parseRule('$exists(a) && ($missing(b) || b.ok == true)');
    expect(evaluateRule(rule, env({ a: 1, b: { ok: true } }))).toBe(true);
    expect(evaluateRule(rule, env({ a: 1 }))).toBe(true);
    expect(evaluateRule(rule, env({ b: { ok: true } }))).toBe(false);
    expect(evaluateRule(parseRule('!$missing(a)'), env({ a: 1 }))).toBe(true);
  });

  test('R7: a missing input is not false and not null', () => {
    // `review.passed == false` must NOT be true when review was never delivered.
    const rule = parseRule('review.passed == false');
    expect(evaluateRule(rule, env({}))).toBe(false);
    // But an explicitly delivered false IS false.
    expect(evaluateRule(rule, env({ review: { passed: false } }))).toBe(true);
    // And `$missing` distinguishes the two.
    expect(evaluateRule(parseRule('$missing(review)'), env({ review: false }))).toBe(false);
  });
});

describe('emit — object construction and input forwarding (§4)', () => {
  test('R6: an emit forwards a whole input', () => {
    const review = { passed: false, reason: 'nope', reviewedCommit: 'abc' };
    const out = mergeRuleOutputs([
      { when: parseRule('review.passed == false'), emit: parseEmit({ rework: '$review' }) },
    ], env({ review }));
    expect(out.outputs.rework).toEqual(review);
    expect(out.emitted).toBe(true);
  });

  test('a forwarded field extracts one value', () => {
    const out = mergeRuleOutputs([
      { when: parseRule('review.passed == false'), emit: parseEmit({ reason: 'review.reason' }) },
    ], env({ review: { passed: false, reason: 'nope' } }));
    expect(out.outputs.reason).toBe('nope');
  });

  test('R4: multiple matching rules merge their outputs in declaration order', () => {
    const out = mergeRuleOutputs([
      { when: parseRule('$exists(a)'), emit: parseEmit({ first: '$a' }) },
      { when: parseRule('$exists(b)'), emit: parseEmit({ second: '$b' }) },
      { when: parseRule('a == 1'), emit: parseEmit({ third: 3 }) },
    ], env({ a: 1, b: 2 }));
    expect(out.outputs).toEqual({ first: 1, second: 2, third: 3 });
    expect(out.reasons).toEqual(['$exists(a)', '$exists(b)', 'a == 1']);
  });
});

describe('mergeRuleOutputs — R3: two rules emitting the same output is refused', () => {
  test('a definition with a conflicting output is refused before it runs', () => {
    expect(() => mergeRuleOutputs([
      { when: parseRule('$exists(a)'), emit: parseEmit({ same: '$a' }) },
      { when: parseRule('$exists(b)'), emit: parseEmit({ same: '$b' }) },
    ], env({ a: 1, b: 2 }))).toThrow(/same/);
  });
});

describe('once / reopen latches live in the module definition, checked at parse time (§4)', () => {
  test('R8: a once-module with several inputs can be expressed', () => {
    expect(() => mergeRuleOutputs([
      { when: parseRule('$exists(a) && $exists(b)'), emit: parseEmit({ pair: 1 }) },
    ], env({ a: 1, b: 2 }))).not.toThrow();
  });
});
