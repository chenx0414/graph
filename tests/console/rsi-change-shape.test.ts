import { expect, test } from 'vitest';
import { describeAgentTools } from '../../src/runtime/agent-tool-definitions.ts';

/**
 * The model sees whatever `apply_rsi_change` answers, so a mis-nested call has to be answered in the
 * model's own terms - "you nested one level too deep" - instead of in schema terms: the SDK's
 * validation already prints every schema fact (`changes.2.path: must have required properties path`),
 * and that sentence never names the mistake that produced it.
 */
const prepare = (payload: unknown) => {
  const tool = describeAgentTools({ rsi: { apply: true }, role: 'master' }).find(candidate => candidate.name === 'apply_rsi_change');
  expect(tool?.prepareArguments).toBeTypeOf('function');
  return tool!.prepareArguments!(payload);
};

test('a top-level field nested inside a change is named instead of only failing the schema', () => {
  expect(() => prepare({
    title: 't',
    problem: 'p',
    changes: [{ path: 'a.ts', action: 'write', content: 'x', checks: [{ command: 'node', args: ['--run', 'check'] }] }],
  })).toThrow(/changes\[0\][^]*"checks"[^]*nested one level too deep/);
});

test('a change nested inside another change edits array is named as the nesting it is', () => {
  expect(() => prepare({
    title: 't',
    problem: 'p',
    changes: [{
      path: 'a.ts',
      action: 'replace',
      edits: [{ oldText: 'a', newText: 'b' }, { path: 'b.ts', action: 'write', content: 'y' }],
    }],
  })).toThrow(/changes\[0\]\.edits\[1\][^]*belongs in changes\[\][^]*nested inside another/);
});

test('a file change that landed in checks is named too', () => {
  expect(() => prepare({
    title: 't',
    problem: 'p',
    changes: [],
    checks: [{ path: 'a.ts', action: 'write', content: 'x' }],
  })).toThrow(/checks\[0\][^]*belongs in changes\[\]/);
});

test('a change that forgot its path is named, instead of only "must have required properties path"', () => {
  // Measured shape mistake: a "replace" entry carries edits and drops `path`. The SDK answers
  // `changes[0].path: must have required properties path`, which never says which entry or where
  // to put it, and the same call is then repeated.
  expect(() => prepare({
    title: 't',
    problem: 'p',
    changes: [{ action: 'replace', edits: [{ oldText: 'a', newText: 'b' }] }],
  })).toThrow(/changes\[0\][^]*is missing "path"[^]*one path per file[^]*\{path, action/);

  // The index has to name the entry that actually lost it, not the first one.
  expect(() => prepare({
    title: 't',
    problem: 'p',
    changes: [{ path: 'a.ts', action: 'write', content: 'x' }, { action: 'write', content: 'y' }],
  })).toThrow(/changes\[1\][^]*is missing "path"/);
});

test('an array where one object belongs is named, and a well-formed call passes through untouched', () => {
  expect(() => prepare({ title: 't', problem: 'p', changes: [[{ path: 'a.ts', action: 'write', content: 'x' }]] }))
    .toThrow(/changes\[0\] is an array/);

  const good = {
    title: 't',
    problem: 'p',
    changes: [{ path: 'a.ts', action: 'replace', edits: [{ oldText: 'a', newText: 'b' }] }, { path: 'b.ts', action: 'delete' }],
    checks: [{ command: 'node', args: ['--run', 'check'] }],
    activate: false,
  };
  // Anything that is not one of the known nesting mistakes stays the SDK's business: the hint must
  // never reject or rewrite a call that the real schema accepts.
  expect(prepare(good)).toEqual(good);
  // A path that is present but blank is a different mistake from a missing one, and still the
  // schema's business: the hint must not claim an entry "is missing path" when the key is there.
  const blank = { title: 't', problem: 'p', changes: [{ path: '', action: 'delete' }] };
  expect(prepare(blank)).toEqual(blank);
  expect(prepare({ title: 't', problem: 'p', changes: [] })).toEqual({ title: 't', problem: 'p', changes: [] });
  expect(prepare('not an object')).toBe('not an object');
});
