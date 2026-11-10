import { join } from 'node:path';
import { expect } from 'vitest';
import { launchCli } from './cli-daemon.ts';

/** Read the shipped rules from the real daemon's public prompt library. */
export async function defaultCommonRules(root: string): Promise<string> {
  const daemon = await launchCli(root, { stateDir: join(root, 'rules-state'), graphHome: join(root, 'rules-home') });
  try {
    const response = await daemon.request('/api/agent-context');
    expect(response.status).toBe(200);
    const preview: { prompts: { key: string; defaultContent: string }[] } = await response.json();
    const rules = preview.prompts.find(prompt => prompt.key === 'rules/common.md');
    if (!rules) throw new Error('The daemon did not publish its common rules');
    return rules.defaultContent;
  } finally { await daemon.close(); }
}
