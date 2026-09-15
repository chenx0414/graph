import { mkdtemp, mkdir, writeFile, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Mirrors the staging list in scripts/package-app.mjs as of the UC-R03 fix:
// desktop, src, build, presets and the built web output. The negative control
// reproduces the previous list (no presets) to show the difference.
const repo = process.argv[2] ?? '/Users/macmini/workspace/graph-unified-dev';
const root = await mkdtemp(join(tmpdir(), 'graph-uc-packaging-fixed-'));
const web = join(root, 'web');
await mkdir(web);
await writeFile(join(web, 'index.html'), '<div id="root"></div>');

async function layout(name, includePresets) {
  const packed = join(root, name);
  await mkdir(packed);
  await cp(join(repo, 'src'), join(packed, 'src'), { recursive: true });
  if (includePresets) await cp(join(repo, 'presets'), join(packed, 'presets'), { recursive: true });
  await writeFile(join(packed, 'package.json'), '{"type":"module"}');
  await symlink(join(repo, 'node_modules'), join(packed, 'node_modules'), 'dir');
  return packed;
}

const results = [];
for (const [name, includePresets] of [['fixed-staging-layout', true], ['old-layout-negative-control', false]]) {
  const packed = await layout(name, includePresets);
  const { startGraphDaemon } = await import(pathToFileURL(join(packed, 'src/server/start.ts')).href);
  const logs = [];
  const daemon = await startGraphDaemon({ configPath: null, stateDir: join(root, `${name}-state`), webDir: web, port: 0, mode: 'execute', dynamic: true, env: {}, log: (line) => logs.push(line) });
  try {
    results.push({
      scenario: name,
      capabilities: daemon.server.runtime.catalog.capabilities().length,
      definitions: daemon.server.runtime.catalog.definitions().length,
      missingPresetLog: logs.some(line => line.includes('Preset pack not available')),
    });
  } finally {
    await daemon.close();
  }
}
console.log(JSON.stringify({ results }, null, 2));
const fixed = results.find(result => result.scenario === 'fixed-staging-layout');
const old = results.find(result => result.scenario === 'old-layout-negative-control');
if (!fixed || fixed.capabilities < 5 || fixed.definitions < 4 || fixed.missingPresetLog) { console.error('fixed layout did not load the preset pack'); process.exit(1); }
if (!old || old.capabilities !== 0 || old.definitions !== 0) { console.error('negative control did not reproduce the missing-preset layout'); process.exit(1); }
console.log('PACKAGED_PRESETS_OK');
await rm(root, { recursive: true, force: true });
