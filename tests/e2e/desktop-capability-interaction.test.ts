import { existsSync } from 'node:fs';
import { afterAll, expect, test } from 'vitest';
import { desktopCall, desktopStdout } from '../helpers/agent-desktop.ts';
import { envelopeOf, launchDesktopGraph } from '../helpers/desktop-graph.ts';

/**
 * What this host can actually see of the desktop.
 *
 * Two facts decide this file: the permission grant is macOS state, and a
 * sandboxed caller reads `denied` even after the user granted it (macOS decides
 * from the launcher's identity and sandbox state). So the observation test runs
 * everywhere and reports the refusal it really got, while the interactive loop
 * runs only from a context that can see the grant - Graph's own host-side runner
 * or a terminal - and says out loud when it did not run. Nothing here may call a
 * refused interaction supported.
 *
 * The host ran the loop for real on 2026-11-03 and the record is in
 * `.agents/skills/agent-desktop/`: 836 elements with `ref_id`, a click, a second
 * snapshot of 108 elements, `STALE_REF` with `retry: "safe"` for the old ref,
 * then a fresh ref that worked.
 */

const MARKER = 'DESKTOP-A3';

/**
 * The capability install this machine has: the app's own library, which is also
 * what `agent-desktop permissions --guide` talked the user through authorising.
 */
const INSTALL = '/Users/macmini/Library/Application Support/Graph/capabilities/agent-desktop';
if (!existsSync(INSTALL)) {
  console.log('[desktop] the capability-library test is skipped here: this machine has no install at ' + INSTALL);
}
const graph = await launchDesktopGraph({
  plans: [{
    marker: MARKER,
    calls: [
      { id: 'permissions', args: { command: 'permissions', include: 'output' } },
      { id: 'snapshot', args: { command: 'snapshot', args: ['--app', 'Finder', '--skeleton'], include: 'output' } },
    ],
  }],
});

afterAll(async () => { await graph.close(); });

/** What this executor can see of the grant. It may deny; it never claims a grant. */
function accessibilityGrantedHere(): boolean {
  try {
    return envelopeOf(desktopStdout(['permissions'])).data?.accessibility?.state === 'granted';
  } catch {
    return false;
  }
}

if (!accessibilityGrantedHere()) {
  console.log('[desktop] the interactive Finder loop is skipped here on purpose: this executor reports '
    + 'accessibility=denied, which is a documented false negative of a sandboxed caller. It runs from the host '
    + '(Graph’s check runner or a terminal).');
}

test('a desktop observation reports the permission truth and the tree shape a click needs', async () => {
  await graph.open(`${MARKER}: look at the desktop`);
  await expect.poll(() => graph.provider.results.get('snapshot'), { timeout: 120_000, interval: 250 }).toBeTruthy();

  const permissions = envelopeOf(graph.answer('permissions'));
  expect(permissions.ok).toBe(true);
  const accessibility = String(permissions.data?.accessibility?.state ?? 'unknown');
  const screenRecording = String(permissions.data?.screen_recording?.state ?? 'unknown');
  const snapshotText = graph.answer('snapshot');
  const snapshot = envelopeOf(snapshotText);

  if (snapshot.ok) {
    // The ref a click takes is `ref_id`: the nodes carry children, name,
    // native_id, role, states, available_actions, ref_id, description and value.
    expect(JSON.stringify(snapshot.data ?? {}), 'the snapshot carries no ref_id').toMatch(/"ref_id"/);
    console.log(`[desktop] observation: granted (accessibility=${accessibility}, screen_recording=${screenRecording})`);
    return;
  }
  // A refusal is reported as a refusal, never softened into "supported".
  expect(snapshot.error?.code).toBe('PERM_DENIED');
  expect(snapshot.error?.disposition?.retry).toBe('safe');
  const liveRefusal = desktopStdout(['snapshot', '--app', 'Finder', '--skeleton'], { AGENT_DESKTOP_HOME: graph.desktopHome });
  expect(snapshotText.trim(), 'the refusal is not the CLI’s own words').toBe(liveRefusal);
  console.log(`[desktop] observation: refused by this executor (accessibility=${accessibility}, screen_recording=${screenRecording})`);
  console.log(`[desktop] permissions raw: ${JSON.stringify(permissions.data)}`);
  console.log('[desktop] the one step only the user can take: run `agent-desktop permissions --guide` from the app that '
    + 'launches agent-desktop (Graph.app, Terminal, iTerm or Codex) and switch on Accessibility; add Screen Recording too '
    + 'if screenshots are needed. Until then a sandboxed caller reads denied even when the host granted it.');
}, 180_000);

test.skipIf(!accessibilityGrantedHere())('a real Finder interaction acts on a ref_id, sees the tree change, and survives a stale ref', () => {
  // The loop the host ran for real, in the order it has to happen: observe, act
  // on a ref_id, observe again because the UI changed, and read the stale-ref
  // refusal as a signal to snapshot again rather than to guess.
  const environment = { AGENT_DESKTOP_HOME: graph.desktopHome };
  const snapshot = () => envelopeOf(desktopCall(['snapshot', '--app', 'Finder', '-i'], environment).stdout);
  const first = snapshot();
  expect(first.ok, 'the interactive loop needs the accessibility grant').toBe(true);
  const refs = collectRefIds(first.data);
  expect(refs.length, 'the Finder snapshot carries no ref_id nodes').toBeGreaterThan(10);
  const target = refs[0]!;
  expect(envelopeOf(desktopCall(['click', target], environment).stdout).ok, 'the click on a ref_id failed').toBe(true);
  const second = snapshot();
  expect(second.ok).toBe(true);
  expect(JSON.stringify(second.data), 'the UI did not change after the click').not.toBe(JSON.stringify(first.data));
  const stale = envelopeOf(desktopCall(['click', target], environment).stdout);
  expect(stale.ok, 'a stale ref_id was accepted').toBe(false);
  expect(stale.error?.code).toBe('STALE_REF');
  expect(stale.error?.disposition?.delivery).toBe('not_delivered');
  expect(stale.error?.disposition?.retry).toBe('safe');
  const fresh = collectRefIds(second.data)[0]!;
  expect(envelopeOf(desktopCall(['click', fresh], environment).stdout).ok, 'a fresh ref_id did not work after re-snapshotting').toBe(true);
}, 180_000);

test.skipIf(!existsSync(INSTALL))('the host capability library resolves the installed CLI with no environment hint', async () => {
  // The app installs the capability into <graph home>/capabilities; the tool has
  // to find it there, because that path is the one the macOS grant belongs to.
  const library = await launchDesktopGraph({
    capabilityInstall: INSTALL,
    plans: [{ marker: 'DESKTOP-LIBRARY', calls: [{ id: 'version', args: { command: 'version', include: 'output' } }] }],
  });
  try {
    await library.open('DESKTOP-LIBRARY: use the installed CLI');
    await expect.poll(() => library.provider.results.get('version'), { timeout: 120_000, interval: 250 }).toBeTruthy();
    const envelope = envelopeOf(library.answer('version'));
    expect(envelope.ok, library.answer('version')).toBe(true);
    expect(envelope.command).toBe('version');
    expect(String(envelope.version), 'the installed CLI was not the one that answered').toMatch(/^2\./);
    // The main Agent's surface carries the tool it just used.
    expect(library.provider.tools.map(tool => tool.function?.name ?? tool.name)).toContain('desktop');
    console.log(`[desktop] capability library: the installed agent-desktop ${envelope.data?.version} answered through the tool`);
  } finally {
    await library.close();
  }
}, 180_000);

/** Every ref_id in one accessibility tree, in depth-first order. */
function collectRefIds(value: any): string[] {
  const found: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.ref_id === 'string') found.push(node.ref_id);
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child);
  };
  if (Array.isArray(value)) value.forEach(walk); else walk(value);
  return found;
}
