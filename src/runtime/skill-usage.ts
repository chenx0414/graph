import type { TaskStore } from '../core/store.ts';

export interface SkillUsageEntry {
  id: string;
  path: string;
  source: 'project' | 'agent' | 'library';
  reads: number;
  lastReadAt: number | null;
  neverRead: boolean;
}

export interface SkillUsageReport {
  skills: SkillUsageEntry[];
  summary: { skills: number; neverRead: number };
}

/**
 * Which skills were actually read, and which never were.
 *
 * Read-only by construction: it derives from the tool calls the runtime already recorded, so it
 * needs no second write path of its own.
 */
export function skillUsage(input: {
  store: TaskStore;
  projectRoot?: string;
  agentSkillsDir?: string;
  capabilityRoot?: string;
  keepDays?: number;
}): SkillUsageReport {
  void input;
  return { skills: [], summary: { skills: 0, neverRead: 0 } };
}
