import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { desktopSkill, desktopStdout } from '../helpers/agent-desktop.ts';
import { envelopeOf } from '../helpers/desktop-graph.ts';

/**
 * The vendored upstream skill, and the notice only the user can act on.
 *
 * The capability ships as one tool plus the upstream guide vendored into this
 * repository, and a vendored copy is only worth having if it is provably the
 * text the installed binary compiles in: the lock names both digests and this
 * recomputes them from the CLI. When upstream moves, the digests stop matching
 * instead of the two quietly drifting apart.
 *
 * The authorisation section is prose, and prose is what a reader follows, so its
 * facts are asserted too: both signed binaries, the launcher, the warning that a
 * grant dies with the cdhash, and the difference between a sandboxed reading and
 * the host's.
 */

const repository = process.cwd();
const skillDir = join(repository, '.agents', 'skills', 'agent-desktop');

test('the vendored agent-desktop skill keeps its provenance and matches the installed CLI', async () => {
  const lock = JSON.parse(await readFile(join(repository, '.agents', 'agent-desktop-skills-lock.json'), 'utf8')) as {
    repository?: string; version?: string; protocol?: string; license?: string; license_file?: string;
    files?: { path: string; source: string; sha256: string; bytes: number; upstream_sha256: string }[];
  };
  expect(lock.repository).toContain('vercel-labs/agent-desktop');
  expect(lock.license).toBe('Apache-2.0');
  const installed = envelopeOf(desktopStdout(['version']));
  expect(lock.version, 'the lock names a version the installed CLI is not').toBe(String(installed.data?.version));
  expect(lock.protocol).toBe(String(installed.version));

  const license = await readFile(join(repository, lock.license_file ?? ''), 'utf8');
  expect(license).toContain('Apache License');
  expect(license).toContain('Version 2.0');

  const strip = (markdown: string) => markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const file of lock.files ?? []) {
    expect(file.source, `the lock names an unknown source: ${file.source}`).toMatch(/^skills get /);
    const upstream = desktopSkill(file.source.split(' ').pop()!);
    expect(createHash('sha256').update(upstream).digest('hex'), `${file.source} is not the text the CLI compiles in`)
      .toBe(file.upstream_sha256);
    const body = strip(upstream);
    expect(createHash('sha256').update(body).digest('hex'), `${file.path} is not the digest the lock records`).toBe(file.sha256);
    expect(file.bytes).toBe(Buffer.byteLength(body));
    const vendored = await readFile(join(repository, file.path), 'utf8');
    expect(vendored, `${file.path} does not contain the upstream text verbatim`).toContain(body);
  }
  expect((await stat(join(skillDir, 'references', 'platform-macos.md'))).isFile()).toBe(true);
}, 120_000);

test('the skill a model reads carries the provenance, the host findings and the authorisation notice', async () => {
  const lock = JSON.parse(await readFile(join(repository, '.agents', 'agent-desktop-skills-lock.json'), 'utf8')) as { version?: string };
  const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
  // Prose wraps, so the sentences are matched on the flattened text.
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  expect(skill, 'the skill name no longer matches its folder').toMatch(/^name: agent-desktop$/m);
  expect(skill).toContain('vercel-labs/agent-desktop');
  expect(skill).toContain(`source_version: ${lock.version}`);
  expect(skill).toContain('Apache-2.0');
  expect(skill).toContain('skills get desktop');

  // The Graph contract the model has to know.
  expect(flat(skill)).toMatch(/headless by default/i);
  expect(skill).toMatch(/include: "output"/);
  expect(skill).toMatch(/disposition\.retry/);

  // The two facts the host run paid for: the ref field and the screenshot path.
  expect(skill, 'the ref field is not named').toContain('ref_id');
  expect(skill, 'the screenshot TIMEOUT is not recorded').toContain('TIMEOUT');
  expect(skill).toContain('/usr/sbin/screencapture');

  // The authorisation notice: both binaries, the launcher, and the two traps.
  expect(skill).toContain('agent-desktop-darwin-arm64');
  expect(skill).toContain('agent-desktop-macos-helper-darwin-arm64');
  expect(skill).toContain('/Applications/Graph.app');
  expect(flat(skill), 'the notice does not say the grant can silently disappear').toMatch(/not a permanent state/i);
  expect(flat(skill)).toMatch(/cdhash/);
  expect(flat(skill), 'the notice does not separate a sandboxed reading from the host truth').toMatch(/false negative/i);

  // The host-verified interaction record, with its numbers.
  expect(skill).toContain('836');
  expect(skill).toContain('108');
  expect(skill).toContain('STALE_REF');
}, 60_000);

test('the capability README repeats the authorisation notice for a human reader', async () => {
  const readme = await readFile(join(skillDir, 'README.md'), 'utf8');
  const flat = (text: string) => text.replace(/\s+/g, ' ');
  expect(flat(readme), 'the README does not carry the authorisation notice').toMatch(/not a permanent state/i);
  expect(readme).toContain('agent-desktop-darwin-arm64');
  expect(readme).toContain('agent-desktop-macos-helper-darwin-arm64');
  expect(readme).toContain('/Applications/Graph.app');
  expect(flat(readme)).toMatch(/false negative/i);
  expect(flat(readme)).toMatch(/permissions --guide/);

  // The root README points a reader at this notice instead of hiding it.
  const root = await readFile(join(repository, 'README.md'), 'utf8');
  expect(root).toContain('.agents/skills/agent-desktop/README.md');
  expect(root, 'the root README does not repeat the warning that a grant expires').toContain('授权不是永久状态');
  expect(root).toContain('disposition.retry');
}, 60_000);
