#!/usr/bin/env node
/**
 * Advisory linter for the skills Graph writes itself.
 *
 * It warns; it never blocks. A skill's shape is a judgement call, and a hard gate on judgement
 * would either be gamed or would freeze the library — so this stays advisory and `--strict`
 * exists only for callers that want the exit code (the fixture check does).
 *
 * Scope is the important part: only skills whose front matter declares `created-by: graph-agent`
 * are linted by default, because the rules encode how WE want to write a skill. Imported and
 * upstream skills are somebody else's text — measured on this repository, 15 of 22 existing
 * project skills would trip a rule we invented, and rewriting them would be overreach.
 *
 * Usage:
 *   node scripts/skills-lint.mjs [--root <dir>] [--skills <dir>] [--capabilities <dir>] [--all] [--strict] [--json]
 *
 * `--root` is a project root (skills come from its `.agents/skills` and `.pi/skills`); `--skills`
 * points at a skills container directly, which is how a fixture that does not pretend to be a
 * project is linted. Both can be given at once.
 *
 * @typedef {{ rule: string, message: string }} Warning
 * @typedef {{ id: string, path: string, warnings: Warning[] }} SkillReport
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const AUTHORED_BY = 'graph-agent';
const DESCRIPTION_LIMIT = 300;
const BODY_LIMIT = 24_000;
const REFERENCES_LIMIT = 60;
const INCIDENT_LIMIT = 3;

/** A skill description must say when to reach for it, or the model cannot decide. */
const TRIGGER = /use when|use for|use before|use this when|use this skill when|when the user|when you|何时|当你|适用于/i;
const INCIDENT_REFERENCE = /^\d{4}-\d{2}-\d{2}|-incident-|-session-/;
const PR_OR_ISSUE = /#\d{3,}/g;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;

function parseArgs(argv) {
  const options = { root: process.cwd(), skills: null, capabilities: null, all: false, strict: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--root') { options.root = argv[index + 1] ?? ''; index += 1; }
    else if (flag === '--skills') { options.skills = argv[index + 1] ?? null; index += 1; }
    else if (flag === '--capabilities') { options.capabilities = argv[index + 1] ?? null; index += 1; }
    else if (flag === '--all') options.all = true;
    else if (flag === '--strict') options.strict = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--help' || flag === '-h') { printUsage(); process.exit(0); }
    else { console.error(`skills-lint: unknown argument ${flag}`); printUsage(); process.exit(2); }
  }
  return options;
}

function printUsage() {
  console.log('usage: node scripts/skills-lint.mjs [--root <dir>] [--skills <dir>] [--capabilities <dir>] [--all] [--strict] [--json]');
}

/** Only the keys this linter needs: a full YAML parser is not the point. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { values: {}, body: text, hasFrontmatter: false };
  const values = {};
  for (const line of match[1].split('\n')) {
    const key = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (key) values[key[1]] = key[2].trim().replace(/^["']|["']$/g, '').trim();
  }
  return { values, body: text.slice(match[0].length), hasFrontmatter: true };
}

async function findSkills(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => join(dir, entry.name));
}

async function inspectSkill(dir) {
  const path = join(dir, 'SKILL.md');
  if (!existsSync(path)) return null;
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  const id = basename(dir);
  const { values, body, hasFrontmatter } = parseFrontmatter(text);
  const name = values['name'];
  const description = values['description'];
  const authored = values['created-by'] === AUTHORED_BY;

  const references = existsSync(join(dir, 'references'))
    ? await readdir(join(dir, 'references')).catch(() => [])
    : [];
  const incidents = (body.match(PR_OR_ISSUE) ?? []).length + (body.match(ISO_DATE) ?? []).length;
  return { id, path, name, description, authored, hasFrontmatter, body, references, incidents };
}

function lintSkill(skill, { all }) {
  if (!skill.authored && !all) return [];
  const warnings = [];
  if (!skill.name || !skill.description) {
    warnings.push({ rule: 'missing-frontmatter', message: 'SKILL.md needs both `name` and `description` in its front matter' });
  }
  if (skill.name && skill.name !== skill.id) {
    warnings.push({ rule: 'name-mismatch', message: `front matter name \`${skill.name}\` does not match the folder \`${skill.id}\`` });
  }
  if (skill.description && skill.description.length > DESCRIPTION_LIMIT) {
    warnings.push({ rule: 'description-too-long', message: `description is ${skill.description.length} characters; keep it under ${DESCRIPTION_LIMIT} so the whole trigger fits` });
  }
  if (skill.body.length > BODY_LIMIT) {
    warnings.push({ rule: 'oversized-body', message: `body is ${skill.body.length} characters; \`read\` loads all of it into context for the rest of the session — move depth into references/` });
  }
  if (skill.references.length > REFERENCES_LIMIT) {
    warnings.push({ rule: 'references-sprawl', message: `${skill.references.length} reference files; extend a topical file instead of adding one per session` });
  }
  for (const reference of skill.references) {
    if (INCIDENT_REFERENCE.test(reference)) {
      warnings.push({ rule: 'references-incident-named', message: `references/${reference} is named after an incident or a date; name it by topic` });
    }
  }
  // Advisory rules encode taste, so they never apply to text somebody else wrote.
  if (skill.authored) {
    if (skill.description && !TRIGGER.test(skill.description)) {
      warnings.push({ rule: 'description-not-triggering', message: 'description never says when to use the skill; a model picks skills by that sentence' });
    }
    if (skill.incidents > INCIDENT_LIMIT) {
      warnings.push({ rule: 'incident-log-shape', message: `${skill.incidents} issue numbers or dates in the body; a skill states rules, not the story behind them` });
    }
  }
  return warnings;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.root);
  const dirs = [
    ...await findSkills(join(root, '.agents', 'skills')),
    ...await findSkills(join(root, '.pi', 'skills')),
    ...(options.skills ? await findSkills(resolve(options.skills)) : []),
    ...(options.capabilities ? await findSkills(join(resolve(options.capabilities), 'skills')) : []),
  ];

  /** @type {SkillReport[]} */
  const skills = [];
  for (const dir of dirs) {
    const skill = await inspectSkill(dir);
    if (!skill) continue;
    const warnings = lintSkill(skill, options);
    if (warnings.length || (skill.authored || options.all)) {
      skills.push({ id: skill.id, path: skill.path, warnings });
    }
  }
  const total = skills.reduce((sum, skill) => sum + skill.warnings.length, 0);

  if (options.json) {
    console.log(JSON.stringify({
      root,
      mode: options.all ? 'all' : 'authored',
      skills,
      summary: { skills: skills.length, warnings: total },
    }, null, 2));
  } else {
    for (const skill of skills) {
      for (const warning of skill.warnings) console.log(`warn  ${warning.rule}  ${skill.path}: ${warning.message}`);
    }
    console.log(total === 0
      ? `skills-lint: ${skills.length} skill(s) checked, no warnings (${options.all ? 'all skills' : 'authored only'})`
      : `skills-lint: ${skills.length} skill(s) checked, ${total} warning(s) (advisory)`);
  }
  process.exit(options.strict && total > 0 ? 1 : 0);
}

await main();
