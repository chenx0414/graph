import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
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

const RETENTION_DAYS = 90;

/**
 * Which skills were actually read, and which never were.
 *
 * Read-only by construction: it derives from the tool calls the runtime already recorded, so it
 * needs no second write path of its own. A call counts for a skill when it touched a file inside
 * that skill's folder — the SKILL.md itself or a reference it pulled in.
 */
export function skillUsage(input: {
  store: TaskStore;
  projectRoot?: string;
  projectRoots?: readonly string[];
  agentSkillsDir?: string;
  capabilityRoot?: string;
  keepDays?: number;
  now?: number;
}): SkillUsageReport {
  const keepDays = input.keepDays ?? RETENTION_DAYS;
  const now = input.now ?? Date.now();
  const rows = input.store.db
    .prepare('SELECT target, created_at FROM tool_calls WHERE target IS NOT NULL AND created_at >= ?')
    .all(now - keepDays * 86_400_000) as { target: string; created_at: number }[];

  const groups: { base: string; source: SkillUsageEntry['source'] }[] = [];
  const projectRoots = [...(input.projectRoots ?? []), ...(input.projectRoot ? [input.projectRoot] : [])];
  for (const root of projectRoots) {
    groups.push({ base: join(root, '.agents', 'skills'), source: 'project' });
    groups.push({ base: join(root, '.pi', 'skills'), source: 'project' });
  }
  if (input.agentSkillsDir) groups.push({ base: input.agentSkillsDir, source: 'agent' });
  if (input.capabilityRoot) groups.push({ base: join(input.capabilityRoot, 'skills'), source: 'library' });

  const skills: SkillUsageEntry[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!existsSync(group.base)) continue;
    for (const entry of readdirSync(group.base, { withFileTypes: true })) {
      const dir = join(group.base, entry.name);
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      const prefix = `${dir}/`;
      let reads = 0;
      let lastReadAt: number | null = null;
      for (const row of rows) {
        if (row.target !== dir && !row.target.startsWith(prefix)) continue;
        reads += 1;
        if (lastReadAt === null || row.created_at > lastReadAt) lastReadAt = row.created_at;
      }
      // One skill can live in several folders (a project dir and the mirror); keep the first sighting
      // but let a used copy win over an identical unused one.
      const existing = skills.find(skill => skill.id === entry.name);
      if (existing) {
        if (reads > existing.reads) {
          existing.reads = reads;
          existing.lastReadAt = lastReadAt;
          existing.neverRead = reads === 0;
          existing.path = dir;
          existing.source = group.source;
        }
        continue;
      }
      seen.add(entry.name);
      skills.push({ id: entry.name, path: dir, source: group.source, reads, lastReadAt, neverRead: reads === 0 });
    }
  }
  skills.sort((left, right) => right.reads - left.reads || left.id.localeCompare(right.id));
  return {
    skills,
    summary: { skills: skills.length, neverRead: skills.filter(skill => skill.neverRead).length },
  };
}

/** Basename of a skill folder, for callers that only have a path. */
export function skillIdFromPath(path: string): string {
  return basename(path);
}
