/**
 * Promoting a project skill into the capability library.
 *
 * A skill that proved itself in one project is worth reusing elsewhere, but the library is a different
 * kind of store: entries are versioned by content digest, carry a manifest, and are only active once a
 * recipe references them. Promotion therefore copies and declares — it never binds, because binding is
 * the user's decision.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { RuntimeError } from '../core/types.ts';

const SKILLS_SEGMENTS = ['.agents', 'skills'];

/** A skill is its whole directory: SKILL.md and every reference that carries its depth. */
function digestSkill(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      hash.update(relative(dir, path));
      hash.update('\0');
      hash.update(readFileSync(path));
      hash.update('\0');
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

export interface PromotionResult {
  promoted: { id: string; version: string; path: string; replaced: boolean };
  bindHint: string;
}

export function promoteProjectSkill(input: {
  projectRoot: string;
  skillId: string;
  capabilityRoot: string;
}): PromotionResult {
  const source = join(input.projectRoot, ...SKILLS_SEGMENTS, input.skillId);
  const skillFile = join(source, 'SKILL.md');
  if (!existsSync(skillFile)) {
    throw new RuntimeError('invalid_input', `no project skill '${input.skillId}' at ${skillFile}`);
  }
  const text = readFileSync(skillFile, 'utf8');
  const name = /^name:\s*(.*)$/m.exec(text)?.[1]?.trim();
  const description = /^description:\s*(.*)$/m.exec(text)?.[1]?.trim();
  if (!name || !description) {
    throw new RuntimeError(
      'invalid_input',
      `project skill '${input.skillId}' needs both name and description in its front matter before it can be promoted`,
    );
  }

  const version = digestSkill(source);
  const target = join(input.capabilityRoot, 'skills', input.skillId);
  const manifestPath = join(target, 'capability.json');
  const existing = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
    : undefined;
  const replaced = existing !== undefined && existing.version !== version;

  // Same content is already in the library: a promotion is a declaration, not an event.
  if (existing?.version !== version) {
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify({
      id: input.skillId,
      kind: 'skill',
      version,
      name,
      description,
      source: 'graph:project',
      createdBy: 'graph-agent',
      promotedFrom: relative(input.projectRoot, source).split(sep).join('/'),
      promotedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  }

  return {
    promoted: { id: input.skillId, version, path: target, replaced },
    bindHint: `把它绑进配方：按 docs/agent/agent-recipes.md 在组合的 resources 里加 {resourceId:"${input.skillId}",role:"skill",required:true,version:"${version}"}；本接口不替你绑定。`,
  };
}

/** Promotion by id alone: whichever known project holds that skill is the source. */
export function promoteSkillFromProjects(input: {
  projectRoots: readonly string[];
  skillId: string;
  capabilityRoot: string;
}): PromotionResult {
  const holder = input.projectRoots
    .find(root => existsSync(join(root, ...SKILLS_SEGMENTS, input.skillId, 'SKILL.md')));
  if (!holder) {
    throw new RuntimeError('invalid_input', `no known project holds a skill named '${input.skillId}'`);
  }
  return promoteProjectSkill({ projectRoot: holder, skillId: input.skillId, capabilityRoot: input.capabilityRoot });
}
