import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

// The rule layer is user-owned state: a file under <graph-home>/prompts/rules
// replaces the shipped text whole. A rule can therefore leave the live prompt
// with no commit and no failing test - which is how the graph shape rule went
// missing for months. The preview has to name that gap.

test('a shipped rule the live library drops is named, and restoring it clears the gap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-rule-seed-'));
  const stateDir = join(root, 'state');
  const graphHome = join(root, 'graph-home');
  const rules = join(graphHome, 'prompts', 'rules');
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><title>rule seed</title>');
  try {
    // A library that has never been edited carries every shipped rule.
    let daemon = await launchCli(root, { stateDir, graphHome });
    try {
      const preview = await (await daemon.request('/api/agent-context')).json() as { ruleSeedGaps?: string[] };
      expect(preview.ruleSeedGaps ?? []).toEqual([]);
    } finally { await daemon.close(); }

    // A user file that keeps only the oldest rule: the newer one is now gone
    // from the live prompt, and the preview says which one.
    await mkdir(rules, { recursive: true });
    await writeFile(join(rules, 'main.md'), '- R14 Stop the loop and take the work over yourself.\n');
    daemon = await launchCli(root, { stateDir, graphHome });
    try {
      const preview = await (await daemon.request('/api/agent-context')).json() as { ruleSeedGaps?: string[] };
      expect(preview.ruleSeedGaps ?? []).toContain('R15');
    } finally { await daemon.close(); }

    // Restoring the rule in the same file closes the gap.
    await writeFile(join(rules, 'main.md'), [
      '- R14 Stop the loop and take the work over yourself.',
      '- R15 Before you propose a graph, choose its shape and say why.',
      '',
    ].join('\n'));
    daemon = await launchCli(root, { stateDir, graphHome });
    try {
      const preview = await (await daemon.request('/api/agent-context')).json() as { ruleSeedGaps?: string[] };
      expect(preview.ruleSeedGaps ?? []).toEqual([]);
    } finally { await daemon.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
