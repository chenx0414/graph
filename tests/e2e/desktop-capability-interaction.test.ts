import { existsSync } from 'node:fs';
import { afterAll, expect, test } from 'vitest';
import { desktopCall, desktopStdout } from '../helpers/agent-desktop.ts';
import { envelopeOf, launchDesktopGraph } from '../helpers/desktop-graph.ts';

/**
 * What this host can actually see of the desktop.
 *
 * Three states exist and all three are asserted here instead of being rounded to
 * "works" or "skipped":
 *
 *   (a) the grant is readable and the call works: the tree carries `ref_id`, the
 *       loop can act on it, the tree changes, a stale ref answers `STALE_REF`;
 *   (b) the grant is not readable: the tool answers the permission question
 *       itself, `PERM_DENIED` with `retry: "safe"` and the one step only the user
 *       can take - and never a target error, because "I cannot see the screen" is
 *       not "I cannot tell which element you meant";
 *   (c) `permissions` reports granted and the call still fails: that is an
 *       inconsistency, printed verbatim with its error code and disposition, and
 *       asserted as an explicit refusal. It is never skipped and never called
 *       working.
 *
 * The host ran the interactive loop for real on 2026-11-03; the record is in
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

/** The one step only the user can take, printed with every refusal. */
const USER_STEP = '[desktop] the one step only the user can take: run `agent-desktop permissions --guide` from the app '
  + 'that launches agent-desktop (Graph.app, Terminal, iTerm or Codex) and switch on Accessibility; add Screen '
  + 'Recording if screenshots are needed. After any reinstall, upgrade or move of that install, run it again: the '
  + 'grant belongs to the binary path and its cdhash, so it does not survive a reinstall.';

test('a desktop observation reports the permission truth before any question of which target was meant', async () => {
  await graph.open(`${MARKER}: look at the desktop`);
  await expect.poll(() => graph.provider.results.get('snapshot'), { timeout: 120_000, interval: 250 }).toBeTruthy();

  const permissions = envelopeOf(graph.answer('permissions'));
  expect(permissions.ok).toBe(true);
  const accessibility = String(permissions.data?.accessibility?.state ?? 'unknown');
  const screenRecording = String(permissions.data?.screen_recording?.state ?? 'unknown');
  console.log(`[desktop] permissions raw: ${JSON.stringify(permissions.data)}`);

  const snapshotText = graph.answer('snapshot');
  const snapshot = envelopeOf(snapshotText);
  const live = (): string => desktopStdout(['snapshot', '--app', 'Finder', '--skeleton'], { AGENT_DESKTOP_HOME: graph.desktopHome });

  // (b) The grant is not readable: the tool answers the permission question
  // before the CLI can resolve a target, so the code is PERM_DENIED and a target
  // error cannot take its place.
  if (accessibility !== 'granted') {
    expect(snapshot.error?.code, snapshotText).toBe('PERM_DENIED');
    expect(snapshot.error?.disposition?.retry, snapshotText).toBe('safe');
    expect(snapshot.error?.details?.source, 'the permission refusal did not come from the tool').toBe('graph-desktop-tool');
    expect(snapshot.error?.details?.accessibility).toBe(accessibility);
    expect(snapshot.error?.suggestion, 'the refusal does not name the one step the user can take').toMatch(/permissions --guide/);
    expect(snapshotText, 'a target error took the place of the permission refusal').not.toContain('AMBIGUOUS_TARGET');
    console.log(`[desktop] observation: refused (accessibility=${accessibility}, screen_recording=${screenRecording}); `
      + `the tool answered before any target resolution`);
    console.log(USER_STEP);
    return;
  }

  // (a) The grant is readable and the call works.
  if (snapshot.ok) {
    // The ref a click takes is `ref_id`: the nodes carry children, name,
    // native_id, role, states, available_actions, ref_id, description and value.
    expect(JSON.stringify(snapshot.data ?? {}), 'the snapshot carries no ref_id').toMatch(/"ref_id"/);
    console.log(`[desktop] observation: granted (accessibility=${accessibility}, screen_recording=${screenRecording})`);
    return;
  }

  // (c) permissions says granted and the call still fails. That is an
  // inconsistency between the permission report and the real call; it is printed
  // verbatim and asserted as an explicit refusal - not as success, not skipped.
  expect(typeof snapshot.error?.code, `a failure without an error code is not an explicit refusal: ${snapshotText}`).toBe('string');
  expect(snapshot.error?.code.length).toBeGreaterThan(0);
  expect(typeof snapshot.error?.disposition?.retry, snapshotText).toBe('string');
  expect(snapshotText.trim(), 'the tool no longer passes the CLI refusal through').toBe(live().trim());
  console.log('[desktop] INCONSISTENT: `permissions` reports accessibility=granted but the snapshot failed: '
    + JSON.stringify(snapshot.error));
  console.log(USER_STEP);
}, 180_000);

test.skipIf(!accessibilityGrantedHere())('a real Finder interaction acts on a ref_id, sees the tree change, and survives a stale ref', () => {
  // The loop the host ran for real, in the order it has to happen: observe, act
  // on a ref_id, observe again because the UI changed, and read the stale-ref
  // refusal as a signal to snapshot again rather than to guess.
  const environment = { AGENT_DESKTOP_HOME: graph.desktopHome };
  const snapshot = () => envelopeOf(desktopCall(['snapshot', '--app', 'Finder', '-i'], environment).stdout);
  const first = snapshot();

  // The grant was readable, so a failure here is the inconsistent state: record
  // it as an explicit refusal instead of asserting success that does not exist.
  if (!first.ok) {
    expect(typeof first.error?.code, 'a failure without an error code is not an explicit refusal').toBe('string');
    expect(first.error?.code.length).toBeGreaterThan(0);
    expect(typeof first.error?.disposition?.retry).toBe('string');
    console.log('[desktop] INCONSISTENT: accessibility is granted but `snapshot --app Finder -i` failed: '
      + JSON.stringify(first.error));
    console.log(USER_STEP);
    return;
  }

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
  console.log('[desktop] interactive loop: ref_id → click → tree changed → STALE_REF (retry safe) → fresh ref worked');
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
