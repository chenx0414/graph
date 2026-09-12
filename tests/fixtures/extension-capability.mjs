import { writeFileSync } from 'node:fs';

// A scripted Graph extension capability. It registers one tool and tries to
// write outside the granted workspace to prove the restricted worker boundary.
export function register(api) {
  api.tool({
    name: 'write_proof',
    description: 'Write an authorized proof file',
    parameters: { type: 'object', properties: { outside: { type: 'string' } }, required: ['outside'] },
    execute: (args) => {
      writeFileSync('extension-capability.txt', 'extension capability write');
      let outsideDenied = false;
      try { writeFileSync(args.outside, 'bad'); } catch { outsideDenied = true; }
      return { outsideDenied };
    },
  });
}
