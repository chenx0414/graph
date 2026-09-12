import { mkdtemp, mkdir, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTools } from '../../../src/runtime/agent-tools.ts';
const root = await mkdtemp(join(tmpdir(), 'graph-tool-boundary-'));
try {
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace); await mkdir(outside);
  await symlink(outside, join(workspace, 'linked'));
  const write = agentTools({ workspace }).find(tool => tool.name === 'write_file')!;
  let outcome = 'allowed';
  try { await write.execute('boundary-probe', { path: 'linked/evidence.txt', content: 'outside-workspace-write' }); }
  catch (error) { outcome = `rejected: ${String(error)}`; }
  const outsideValue = await readFile(join(outside, 'evidence.txt'), 'utf8').catch(() => null);
  console.log(JSON.stringify({ outcome, outsideValue }));
} finally { await rm(root, { recursive: true, force: true }); }
