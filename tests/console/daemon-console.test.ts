import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

async function testSources(dir: string): Promise<{ path: string; source: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testSources(path);
    return entry.name.endsWith('.test.ts') ? [{ path, source: await readFile(path, 'utf8') }] : [];
  }));
  return nested.flat();
}

test('a daemon test owns the console it serves, so the suite needs no prebuilt dist/web', async () => {
  const offenders: string[] = [];
  for (const { path, source } of await testSources(join(process.cwd(), 'tests'))) {
    // This guard is the one file that names the pattern it forbids, so it is not a subject.
    if (path.endsWith('daemon-console.test.ts')) continue;
    if (!source.includes('startGraphDaemon')) continue;
    // Pointing webDir at the repository itself makes the whole suite depend on
    // `node --run build:web` having run first. On a fresh checkout the daemon then refuses to
    // start and the failure says nothing about the change under test. A daemon test builds
    // the console into its own temp directory, or writes a stub index.html for a console it
    // never opens.
    if (/webDir:[^\n]*process\.cwd\(\)/.test(source)) offenders.push(path.replace(`${process.cwd()}/`, ''));
  }
  expect(offenders).toEqual([]);
});
