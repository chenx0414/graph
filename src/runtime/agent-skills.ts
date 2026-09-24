import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { formatSkillsForPrompt, loadSkills, type Skill } from '@earendil-works/pi-coding-agent';

/**
 * Skills are loaded by the Pi SDK's own loader and rendered by its own formatter.
 *
 * Each Agent recipe owns exactly one skills folder — `<graph home>/agents/<recipeId>/skills`
 * — with no version in the path. Skills bound through a recipe are mirrored into it as
 * symlinks (one copy on disk, shared with the capability library), and anything the user
 * drops into that folder is loaded the same way. Skills inside the folder are described
 * once, by the SDK's `<available_skills>` block; Graph keeps its own record of what was
 * loaded as a capability fact.
 */

export interface BoundSkillLink {
  /** Folder entry name; also the capability id of a bound skill. */
  id: string;
  /** Absolute directory that contains this skill's SKILL.md. */
  target: string;
}

export function agentSkillsDir(agentId: string, home: string): string {
  return join(home, 'agents', agentId, 'skills');
}

/** The capability roots Graph owns, so it can tell its own links from hand-made ones. */
export function agentSkillOwnedRoots(input: { capabilityRoot?: string | undefined; stateDir: string }): string[] {
  return [input.capabilityRoot, join(input.stateDir, 'capabilities')]
    .filter((path): path is string => Boolean(path));
}

function linkTarget(path: string): string {
  return resolve(dirname(path), readlinkSync(path));
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A link Graph made itself: it points into one of the capability roots Graph owns. */
function ownedLink(path: string, ownedRoots: readonly string[]): boolean {
  try {
    const target = linkTarget(path);
    return ownedRoots.some(root => inside(root, target));
  } catch {
    return false;
  }
}

/**
 * Mirror the bound skills into the Agent's skills folder.
 *
 * Only Graph's own links are created, retargeted or removed: a hand-made folder, file or
 * link is never touched, and a hand-made entry that shadows a bound skill id wins (Graph
 * leaves it alone instead of clobbering it).
 */
export function syncAgentSkills(input: {
  dir: string;
  ownedRoots: readonly string[];
  links: readonly BoundSkillLink[];
}): void {
  mkdirSync(input.dir, { recursive: true });
  const wanted = new Map(input.links.map(link => [link.id, resolve(link.target)]));
  for (const entry of readdirSync(input.dir, { withFileTypes: true })) {
    const path = join(input.dir, entry.name);
    if (!entry.isSymbolicLink() || !ownedLink(path, input.ownedRoots)) continue;
    const target = wanted.get(entry.name);
    if (target && linkTarget(path) === target) {
      wanted.delete(entry.name);
      continue;
    }
    rmSync(path, { force: true });
    if (target) {
      symlinkSync(target, path);
      wanted.delete(entry.name);
    }
  }
  for (const [id, target] of wanted) {
    const path = join(input.dir, id);
    if (existsSync(path)) continue;
    symlinkSync(target, path);
  }
}

export interface AgentSkills {
  skills: Skill[];
  diagnostics: ReturnType<typeof loadSkills>['diagnostics'];
  /** The SDK's own prompt block; empty when the folder holds no skill. */
  block: string;
}

/** Load one folder with the SDK's loader and render it with the SDK's formatter. */
export function agentSkills(dir: string): AgentSkills {
  if (!existsSync(dir)) return { skills: [], diagnostics: [], block: '' };
  const loaded = loadSkills({ cwd: dir, agentDir: dir, skillPaths: [dir], includeDefaults: false });
  return { skills: loaded.skills, diagnostics: loaded.diagnostics, block: formatSkillsForPrompt(loaded.skills, 'read') };
}
