import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { reviewPolicyCode, reviewPolicyInputs, type ReviewPolicy } from '../src/core/review-policy.ts';

// An on-demand authoring command, not an always-exposed main-agent tool.
try {
  const [configPath, entryPath, versionText = '1', protocol = 'data'] = process.argv.slice(2);
  if (!configPath || !entryPath) throw new Error('Usage: node scripts/create-review-module.ts <policy.json> <new-entry.mjs> [version] [protocol]');
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Module version must be a positive integer');
  if (!protocol.trim()) throw new Error('Protocol must be nonempty');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as ReviewPolicy;
  const inputs = reviewPolicyInputs(config); const code = reviewPolicyCode(config);
  const entry = resolve(entryPath);
  // A published code entry is not overwritten; main uses another path/version for a revision.
  await writeFile(entry, code, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ type: 'command', trigger: 'each', requiredInputs: inputs,
    inputs: Object.fromEntries(inputs.map(input => [input, { protocol }])), outputs: { approved: { protocol }, rework: { protocol } }, code: { entry, version } }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`create-review-module: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
