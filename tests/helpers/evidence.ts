import { join } from 'node:path';

/** Keep normal test runs out of tracked acceptance evidence. */
export function evidenceDir(root: string, relative = '') {
  return process.env.GRAPH_UPDATE_EVIDENCE === '1'
    ? join(process.cwd(), 'docs', 'planning', 'acceptance-evidence', relative)
    : join(root, 'test-evidence', relative);
}
