// The scripted solution of every frozen case, and the discipline it must show.
//
// A frozen case says what the task is and how the result is judged. This file
// says how a harness-obedient agent carries that task out: which tool it uses
// for which step, and which tool it must not use. The gate replays these steps
// against the harness that is actually installed, so the case fails when the
// harness can no longer carry the work the way it is supposed to.

/** The order the tools have to appear in, for a case to count as passed. */
const PRECISE_EDIT_DISCIPLINE = {
  expected: ['read', 'edit', 'read'],
  forbidden: ['write'],
};

export const behaviorCases = {
  parser: {
    ...PRECISE_EDIT_DISCIPLINE,
    steps: [
      { rule: 'read', tool: 'read', arguments: { path: 'config.js' } },
      {
        rule: 'edit',
        tool: 'edit',
        arguments: {
          path: 'config.js',
          edits: [{
            oldText: `text.split('\\n').map(line => line.split('='))`,
            newText: `text.split('\\n').filter(line => line.trim()).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; })`,
          }],
        },
      },
      { rule: 'evidence', tool: 'read', arguments: { path: 'config.js' } },
    ],
  },
  cli: {
    ...PRECISE_EDIT_DISCIPLINE,
    steps: [
      { rule: 'read', tool: 'read', arguments: { path: 'greet.mjs' } },
      {
        rule: 'edit',
        tool: 'edit',
        arguments: {
          path: 'greet.mjs',
          edits: [{
            oldText: `console.log('hello');`,
            newText: `const args = process.argv.slice(2);
let count = 1;
if (args.length) {
  count = Number(args[1]);
  if (args[0] !== '--count' || !args[1] || !Number.isInteger(count) || count < 1) { console.error('Invalid count'); process.exit(1); }
}
for (let index = 0; index < count; index++) console.log('hello');`,
          }],
        },
      },
      { rule: 'evidence', tool: 'read', arguments: { path: 'greet.mjs' } },
    ],
  },
  persistence: {
    ...PRECISE_EDIT_DISCIPLINE,
    steps: [
      { rule: 'read', tool: 'read', arguments: { path: 'counter.mjs' } },
      {
        rule: 'edit',
        tool: 'edit',
        arguments: {
          path: 'counter.mjs',
          edits: [{
            oldText: `const statePath = process.argv[2]; let count = 0; console.log(++count);`,
            newText: `import { readFileSync, writeFileSync } from 'node:fs';
const statePath = process.argv[2]; let count = 0;
try { count = Number(readFileSync(statePath, 'utf8')) || 0; } catch { count = 0; }
count += 1;
writeFileSync(statePath, String(count));
console.log(count);`,
          }],
        },
      },
      { rule: 'evidence', tool: 'read', arguments: { path: 'counter.mjs' } },
    ],
  },
  command: {
    ...PRECISE_EDIT_DISCIPLINE,
    steps: [
      { rule: 'read', tool: 'read', arguments: { path: 'settings.json' } },
      {
        rule: 'edit',
        tool: 'edit',
        arguments: {
          path: 'settings.json',
          edits: [{ oldText: `"mode":"slow"`, newText: `"mode":"fast"` }],
        },
      },
      { rule: 'evidence', tool: 'read', arguments: { path: 'settings.json' } },
    ],
  },
};
