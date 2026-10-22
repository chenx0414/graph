import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { ensureBackendBinary } from '../helpers/backend-binary.ts';

/**
 * A team is a set of role recipes and the graph that runs them.
 *
 * The roles are not written by hand: each one is published into the
 * capability library as a recipe, and the definition that runs the team is an
 * ordinary graph definition built from those published recipes. The team is
 * only as good as the library it came from - a role whose skill is missing
 * stops the whole assembly, with the missing skills named.
 *
 * The proof is a real console with a real capability library, the real
 * command line and the real files it writes: the published recipes are in the
 * console's catalog afterwards, the definition names them, and a definition
 * that is already there is never overwritten.
 */

const run = promisify(execFile);

/** The skills the roles are built from. */
const SKILLS = ['codebase-design', 'tdd', 'code-review'];

const OPTIONS = {
  name: 'Ticket 12 team',
  task: 'Implement the search fix',
  spec: 'Search folds case.',
  ticket: 12,
  baseRef: 'abc1234',
  check: { command: 'node', args: ['--version'] },
  recipePrefix: 'matt-team',
};

test('a team is assembled from the running console library and its recipes are published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-assemble-team-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // A real capability library with the skills the roles are built from.
  const graphHome = join(root, 'graph-home');
  for (const skill of SKILLS) {
    const directory = join(graphHome, 'capabilities', `mattpocock-skills-skills-engineering-${skill}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'capability.json'), JSON.stringify({
      id: `mattpocock-skills-skills-engineering-${skill}`, kind: 'skill', version: '1.0.0',
      name: skill, description: `The ${skill} skill`,
    }));
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${skill}\ndescription: The ${skill} skill\n---\n\n${skill}\n`);
  }
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }] }));
  const optionsPath = join(root, 'team.json');
  await writeFile(optionsPath, JSON.stringify(OPTIONS));
  const definitionPath = join(root, 'team-definition.json');
  const binary = ensureBackendBinary();

  const daemon = await launchCli(root, { configPath, graphHome, webDir: join(root, 'web') });
  try {
    // An earlier worker recipe: the new one is a new version of it, not a
    // replacement of the published definition.
    const earlier = await daemon.request('/api/catalog/combinations', {
      method: 'POST', body: JSON.stringify({ combination: {
        id: 'matt-team-worker', name: 'Earlier worker', description: 'Old role',
        recommendedGrade: 'medium', review: false, tags: [], resources: [], systemPrompt: 'Old instructions',
      } }),
    });
    expect(earlier.status).toBe(200);

    const assembled = await run(binary, ['assemble-team', '--url', daemon.url, '--config', optionsPath, '--out', definitionPath], { cwd: root });
    expect(assembled.stdout).toContain('Published recipes:');
    for (const role of ['planner', 'worker', 'standards', 'spec']) {
      expect(assembled.stdout).toContain(`matt-team-${role}@`);
    }

    // The definition is an ordinary v2 graph definition naming the published recipes.
    const definition = JSON.parse(await readFile(definitionPath, 'utf8')) as {
      schemaVersion: number; name: string;
      nodes: Record<string, { recipe: string; task: string }>;
      modules: Record<string, { type: string }>;
      edges: Record<string, { from: string; to: string }>;
      acceptance: { id: string; kind: string }[];
    };
    expect(definition.schemaVersion).toBe(2);
    expect(definition.name).toBe('Ticket 12 team');
    expect(Object.keys(definition.nodes).sort()).toEqual(['planner', 'spec', 'standards', 'worker']);
    expect(definition.nodes.planner?.recipe).toBe('matt-team-planner@1');
    expect(definition.nodes.worker?.recipe).toBe('matt-team-worker@2');
    expect(definition.nodes.standards?.recipe).toBe('matt-team-standards@1');
    expect(definition.nodes.spec?.recipe).toBe('matt-team-spec@1');
    expect(definition.modules.decision?.type).toBe('router');
    expect(definition.modules.check?.type).toBe('operation');
    // The review peers read the same subject and the same plan.
    expect(Object.values(definition.edges).map(edge => edge.from + ' -> ' + edge.to)).toEqual(expect.arrayContaining([
      'worker.result -> standards.job',
      'worker.result -> spec.job',
    ]));
    expect(definition.acceptance.map(item => item.id).sort()).toEqual(['check', 'spec', 'standards']);

    // The role recipes really are in the console's catalog now.
    const catalog = await (await daemon.request('/api/catalog')).json() as {
      agentCombinations: { id: string; name: string }[];
    };
    expect(catalog.agentCombinations.map(item => item.id)).toEqual(expect.arrayContaining([
      'matt-team-planner', 'matt-team-spec', 'matt-team-standards', 'matt-team-worker',
    ]));

    // A definition that is already there is never overwritten.
    const again = await run(binary, ['assemble-team', '--url', daemon.url, '--config', optionsPath, '--out', definitionPath], { cwd: root })
      .then(() => null, error => error as { code: number; stderr: string });
    expect(again, 'the command overwrote an existing definition').not.toBeNull();
    expect(again?.code).not.toBe(0);
    expect(again?.stderr).toContain('already exists');
    expect(existsSync(definitionPath)).toBe(true);
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test('a team whose skills are missing is refused and the missing skills are named', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-assemble-team-missing-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const graphHome = join(root, 'graph-home');
  await mkdir(graphHome, { recursive: true });
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }] }));
  const optionsPath = join(root, 'team.json');
  await writeFile(optionsPath, JSON.stringify(OPTIONS));
  const definitionPath = join(root, 'team-definition.json');
  const binary = ensureBackendBinary();

  const daemon = await launchCli(root, { configPath, graphHome, webDir: join(root, 'web') });
  try {
    const refused = await run(binary, ['assemble-team', '--url', daemon.url, '--config', optionsPath, '--out', definitionPath], { cwd: root })
      .then(() => null, error => error as { code: number; stderr: string });
    expect(refused, 'the command assembled a team without its skills').not.toBeNull();
    expect(refused?.code).not.toBe(0);
    // Every missing role is named before anything is saved.
    expect(refused?.stderr).toMatch(/planner.*codebase-design[\s\S]*worker.*tdd[\s\S]*standards.*code-review[\s\S]*spec.*code-review/);
    // Nothing was published and nothing was written.
    const catalog = await (await daemon.request('/api/catalog')).json() as { agentCombinations: { id: string }[] };
    expect(catalog.agentCombinations.map(item => item.id)).not.toContain('matt-team-planner');
    expect(catalog.agentCombinations.map(item => item.id)).not.toContain('matt-team-worker');
    expect(existsSync(definitionPath)).toBe(false);
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
