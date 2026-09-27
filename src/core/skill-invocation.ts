import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `/skill:<name>` selects one skill that is bound to the Agent for this turn.
 *
 * It exists because a bound skill is knowledge, not a tool: the model cannot "call" it, and a
 * skill declared `disable-model-invocation` is deliberately kept out of the system prompt, so
 * without an explicit selection its body is unreachable. The console offers these names in the
 * `/` menu and the text keeps the token, so what the user typed stays exactly what the
 * transcript shows while the body travels with the turn.
 */
export const SKILL_TOKEN = /(?:^|\s)\/skill:([A-Za-z0-9._-]+)/g;

/** One body is capped so a single oversized skill cannot crowd out the rest of the turn. */
export const SKILL_BODY_LIMIT = 40_000;
/** All bodies injected into one turn are capped for the same reason. */
export const SKILL_TOTAL_LIMIT = 120_000;

export interface BoundSkill {
  name: string;
  /** The shipped folder, or the markdown file itself. */
  path: string;
  version?: string;
}

export interface SkillInjection {
  /** The original text with the requested bodies appended; untouched when nothing was asked for. */
  text: string;
  injected: string[];
  /** Every skill that was asked for but could not be injected, with the reason, never silently. */
  rejected: { name: string; reason: string }[];
}

/** The skills a resolved capability bundle actually bound, under the names the console offers. */
export function boundSkills(
  facts: readonly { id: string; version: string; kind: string; path: string }[],
  catalog: { capability(id: string, version?: string): { name?: string } | null | undefined },
): BoundSkill[] {
  return facts.filter(fact => fact.kind === 'skill').map(fact => ({
    name: catalog.capability(fact.id, fact.version)?.name ?? fact.id,
    path: fact.path,
    version: fact.version,
  }));
}

export function requestedSkillNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(SKILL_TOKEN)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function bodyPath(path: string): string {
  return path.endsWith('.md') ? path : join(path, 'SKILL.md');
}

/** The body without its front matter: the block is metadata, the prose is the instruction. */
function stripFrontMatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

async function readSkillBody(skill: BoundSkill, budget: number): Promise<string | null> {
  let body: string;
  try {
    body = stripFrontMatter(await readFile(bodyPath(skill.path), 'utf8'));
  } catch {
    return null;
  }
  const room = Math.min(SKILL_BODY_LIMIT, budget);
  if (body.length <= room) return body;
  return `${body.slice(0, room)}\n\n[truncated: the body is ${body.length.toLocaleString('en-US')} characters and only the first ${room.toLocaleString('en-US')} were injected]`;
}

/**
 * Append the bodies of the skills this turn asked for.
 *
 * `names` is what this turn's own messages asked for. The briefing is the fallback for a turn
 * that carries no messages of its own (a node dispatch), because a briefing keeps an earlier
 * turn's text as standing context: scanning it every time would re-inject a skill nobody asked
 * for again. Nothing is injected silently either - an unbound name, an unreadable body and a
 * clipped body are all reported in the same block.
 */
export async function injectRequestedSkills(text: string, skills: readonly BoundSkill[], names?: readonly string[]): Promise<SkillInjection> {
  const requested = names ?? requestedSkillNames(text);
  if (!requested.length) return { text, injected: [], rejected: [] };
  const byName = new Map(skills.map(skill => [skill.name, skill]));
  const injected: string[] = [];
  const rejected: SkillInjection['rejected'] = [];
  const blocks: string[] = [];
  let budget = SKILL_TOTAL_LIMIT;
  for (const name of requested) {
    const skill = byName.get(name);
    if (!skill) {
      rejected.push({ name, reason: 'not bound to this Agent' });
      continue;
    }
    const body = await readSkillBody(skill, budget);
    if (body === null) {
      rejected.push({ name, reason: `body unreadable at ${skill.path}` });
      continue;
    }
    budget -= body.length;
    injected.push(name);
    blocks.push([
      `<skill name="${name}"${skill.version ? ` version="${skill.version}"` : ''}>`,
      body.trimEnd(),
      '</skill>',
    ].join('\n'));
    if (budget <= 0) break;
  }
  if (!blocks.length && !rejected.length) return { text, injected, rejected };
  const lines = [
    '',
    'The user explicitly requested these skills for this turn with `/skill:<name>`.',
    'Their instructions are below and apply to this turn; do not claim a skill was followed without doing what it says.',
  ];
  if (rejected.length) lines.push(`Not injected: ${rejected.map(item => `\`${item.name}\` (${item.reason})`).join(', ')}.`);
  if (budget <= 0) lines.push(`Only the first ${SKILL_TOTAL_LIMIT.toLocaleString('en-US')} characters of requested skill bodies fit in one turn.`);
  return { text: `${text.trimEnd()}\n${lines.join('\n')}\n\n${blocks.join('\n\n')}\n`, injected, rejected };
}
