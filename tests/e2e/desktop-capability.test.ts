import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { desktopStdout } from '../helpers/agent-desktop.ts';
import {
  envelopeOf, filesMentioning, launchDesktopGraph, recordedInvocations, toolDescription, toolName,
} from '../helpers/desktop-graph.ts';

/**
 * The computer-use tool, end to end.
 *
 * The product exposes the desktop as ONE tool named `desktop` that wraps the
 * real `agent-desktop` CLI: `command` plus `args`, one JSON envelope back. This
 * file proves the parts of that contract that a real daemon, a real provider
 * boundary and the real CLI can prove on any machine:
 *
 *   - the envelope the CLI printed is the result the model reads, byte for byte
 *     (and a refused call keeps its `disposition`, the only thing that may
 *     authorize a repeat);
 *   - the invocation is headless unless `headed: true` was passed, because
 *     `--headed` steals focus and moves the physical cursor;
 *   - the payload is withheld unless the caller asks for it, and a withheld
 *     answer reaches neither the model nor Graph's own storage or log;
 *   - one tool was added and the provider-side schema budget still holds.
 *
 * What this host can actually see of the desktop is a separate file
 * (`desktop-capability-interaction.test.ts`), and so is the vendored upstream
 * skill (`desktop-capability-skill.test.ts`).
 */

const SENTINEL = 'GRAPH_SENTINEL_7d1c5b9e';
const MARKER = 'DESKTOP-MAIN';
const MARKER_OPT_IN = 'DESKTOP-OPT-IN';
const NO_SUCH_SESSION = 'graph-desktop-capability-no-such-session';

const graph = await launchDesktopGraph({
  sentinel: SENTINEL,
  plans: [
    {
      marker: MARKER,
      calls: [
        { id: 'version', args: { command: 'version', include: 'output' } },
        { id: 'status', args: { command: 'status' } },
        { id: 'headed', args: { command: 'session', args: ['start', '--name', 'capability-probe'], headed: true } },
        { id: 'smuggled', args: { command: 'version', args: ['--headed'] } },
        { id: 'retry', args: { command: 'session', args: ['end', '--session', NO_SUCH_SESSION, '--trace', '<tracePath>'] } },
        { id: 'withheld', args: { command: 'batch', args: ['[{"command":"status","args":{}}]'] } },
      ],
    },
    {
      marker: MARKER_OPT_IN,
      calls: [
        { id: 'opted-in', args: { command: 'batch', args: ['[{"command":"status","args":{}}]'], include: 'output' } },
      ],
    },
  ],
});

let conversationId = '';

afterAll(async () => { await graph.close(); });

test('the desktop tool runs the real CLI headless, returns its envelope, and keeps the payload out of Graph’s storage', async () => {
  conversationId = await graph.open(`${MARKER}: use the desktop`);
  await expect.poll(() => graph.provider.results.get('withheld'), { timeout: 120_000, interval: 250 }).toBeTruthy();
  const answer = graph.answer;

  // 1. The result is the envelope the CLI printed: same bytes as a live run.
  const liveVersion = desktopStdout(['version'], { AGENT_DESKTOP_HOME: graph.desktopHome });
  expect(answer('version').trim()).toBe(liveVersion);
  expect(envelopeOf(answer('version'))).toMatchObject({ ok: true, command: 'version' });

  // 2. The invocation is headless: the product passed no --headed of its own.
  const invocations = await recordedInvocations(graph.argvLog);
  expect(invocations[0], 'the first desktop call the product made').toEqual(['version']);

  // 3. The payload of an ordinary command is withheld by default, so the
  //    sentinel in the CLI's own answer reaches neither the model nor storage.
  const status = envelopeOf(answer('status'));
  expect(status.ok).toBe(true);
  expect(status.withheld).toBe('output');
  expect(answer('status'), 'the withheld payload reached the model').not.toContain(SENTINEL);
  const persisted = [
    ...await filesMentioning(join(graph.work, 'state'), SENTINEL),
    ...await filesMentioning(join(graph.work, 'graph-home'), SENTINEL),
  ];
  expect(persisted, 'the CLI output was written into Graph’s own state or artifact storage').toEqual([]);
  expect(graph.daemon.stderr, 'the CLI output was logged').not.toContain(SENTINEL);

  // 4. --headed is an explicit parameter, and it lands in the argv only then.
  const headedCall = invocations.find(argv => argv[0] === 'session' && argv[1] === 'start') ?? [];
  expect(headedCall, 'the headed call never reached the CLI').not.toEqual([]);
  expect(headedCall[headedCall.length - 1], '--headed was not passed when headed: true was asked for').toBe('--headed');
  expect(envelopeOf(answer('headed')).ok).toBe(true);

  // 5. A flag smuggled through args is refused, and the CLI is not run at all.
  const beforeSmuggle = (await recordedInvocations(graph.argvLog)).length;
  expect(answer('smuggled')).toMatch(/headed/);
  expect((await recordedInvocations(graph.argvLog)).length, 'the refused call still ran the CLI').toBe(beforeSmuggle);

  // 6. A refused call comes back verbatim, disposition included, and the host
  //    does not repeat it: a repeat is the caller's decision, and the field is
  //    the only thing that authorizes one.
  const liveRefusal = desktopStdout(['session', 'end', '--session', NO_SUCH_SESSION], { AGENT_DESKTOP_HOME: graph.desktopHome });
  const refusal = envelopeOf(answer('retry'));
  expect(refusal.error.code).toBe(JSON.parse(liveRefusal).error.code);
  expect(refusal.error.disposition.retry).toBe('safe');
  expect(answer('retry').trim()).toBe(liveRefusal);
  const trace = (await readFile(graph.tracePath, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, any>);
  expect(trace.filter(line => line.event === 'trace.meta'), 'the host ran the CLI more than once for one call').toHaveLength(1);
  expect(trace.find(line => line.event === 'command.end')?.ok).toBe(false);

  // 7. Screen and clipboard payloads are withheld unless the caller asks.
  const receipt = envelopeOf(answer('withheld'));
  expect(receipt).toMatchObject({ ok: true, command: 'batch', withheld: 'output' });
  expect(typeof receipt.sha256).toBe('string');
  expect(receipt.bytes).toBeGreaterThan(0);
  expect(answer('withheld'), 'the withheld payload still reached the model').not.toContain(SENTINEL);

  // 8. Asking for it is what returns it - the gate withholds, it does not break.
  //    A separate conversation keeps the opt-in payload out of the storage scan
  //    above, which is the whole point of the default.
  await graph.open(`${MARKER_OPT_IN}: read the payload`);
  await expect.poll(() => graph.provider.results.get('opted-in'), { timeout: 120_000, interval: 250 }).toBeTruthy();
  expect(graph.answer('opted-in')).toContain(SENTINEL);
  expect(envelopeOf(graph.answer('opted-in')).ok).toBe(true);

  // 9. One tool, and the provider-side schema budget still holds with it.
  const tools = graph.provider.tools;
  const names = tools.map(toolName);
  expect(names).toContain('desktop');
  const desktop = tools.find(tool => toolName(tool) === 'desktop')!;
  const description = toolDescription(desktop);
  expect(description, 'the desktop description does not say it runs headless').toMatch(/headless/i);
  expect(description, 'the desktop description does not warn about focus and the cursor').toMatch(/focus|cursor/i);
  expect(description, 'the desktop description does not say the output is withheld').toMatch(/withheld|include/i);
  expect(description, 'the desktop description does not name the retry signal').toMatch(/disposition\.retry/);
  const parameters = (desktop.function?.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  expect(Object.keys(parameters.properties ?? {}).sort()).toEqual(['args', 'command', 'headed', 'include']);
  expect(parameters.required).toEqual(['command']);

  const prose = tools.reduce((total, tool) => total + toolDescription(tool).length, 0);
  const average = prose / tools.length;
  console.log(`[desktop] schema: ${tools.length} tools, ${prose} description characters, ${Math.round(average)} average, `
    + `desktop=${description.length} characters`);
  expect(prose, `the tool schema spends ${prose} characters on ${tools.length} descriptions:\n`
    + tools.map(tool => `${toolName(tool)}: ${toolDescription(tool).length}`).join('\n')).toBeLessThanOrEqual(10400);
  expect(average, `the ${tools.length} tool descriptions average ${Math.round(average)} characters`).toBeLessThanOrEqual(200);
  expect(description.length, 'the new tool is longer than the per-tool average allows').toBeLessThanOrEqual(200);
  // Nothing was traded away for the new tool: the surface the agent had is intact.
  for (const kept of ['artifact_publish', 'artifact_read', 'propose_graph', 'git', 'graph_create', 'control_task', 'bash', 'read']) {
    expect(names, `${kept} disappeared from the tool surface`).toContain(kept);
  }
  expect(names.length, 'the surface shrank').toBeGreaterThanOrEqual(50);
  expect(conversationId).toBeTruthy();
}, 240_000);
