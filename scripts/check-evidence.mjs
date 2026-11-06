import { execFileSync } from 'node:child_process';

if (process.env.GRAPH_UPDATE_EVIDENCE === '1') {
  console.log('Acceptance evidence updates explicitly enabled; check skipped.');
  process.exit(0);
}

const output = execFileSync('git', [
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
  '--',
  'acceptance-evidence',
], { encoding: 'utf8' }).trim();

if (!output) {
  console.log('Acceptance evidence is unchanged.');
  process.exit(0);
}

console.error('Tracked acceptance evidence changed during a normal run:');
for (const file of output.split('\n')) console.error(`- ${file}`);
console.error('Set GRAPH_UPDATE_EVIDENCE=1 only when intentionally updating evidence.');
process.exit(1);
