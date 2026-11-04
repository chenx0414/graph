import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { chromium, type Browser } from 'playwright';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * ESC stops a turn that is in the middle of a tool call.
 *
 * Measured 2026-11-04 against a real daemon and a real `sleep 300`: the console's
 * interrupt request did not return for 90 seconds, the operation was still
 * `dispatched`, the tool message was still `pending`, and the command ran to its
 * own end. Three causes, pinned down here:
 *
 *   1. `pigkernel.Session.Interrupt` committed the kernel abort and then waited
 *      for the conversation to go idle. A turn only leaves the kernel after its
 *      running tool returned, so the request could not answer before that tool
 *      finished (`PauseForReload` already states the opposite contract where it
 *      calls the same method: "Signal, do not wait").
 *   2. Nothing killed the child. The kernel can only mark the tool task aborted;
 *      the process belongs to the daemon's command runner, and the `bash` tool
 *      handed that runner a nil abort signal, so the interrupt could not reach
 *      the process group at all.
 *   3. Because the tool never returned, the turn never ended and the operation
 *      never settled: `dispatched` and `worker_active=1` were the durable state
 *      of an interrupt that had already been accepted.
 *
 * Every flow runs against a real daemon, a real scripted provider (the one
 * external service a test may replace) and the real console that daemon serves.
 */

const INTERRUPT_BUDGET_MS = 1_000;
// Give up long before a blocked tool could finish, so a daemon that waits for
// the tool fails here instead of minutes from now.
const REQUEST_CAP_MS = 5_000;

async function projectFixture(root: string): Promise<{ root: string; project: string }> {
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Interrupt project\n');
  execFileSync('git', ['-C', project, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', project, 'config', 'user.email', 'graph@example.invalid']);
  execFileSync('git', ['-C', project, 'config', 'user.name', 'Graph Test']);
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', ['-C', project, 'commit', '-q', '-m', 'baseline']);
  return { root, project };
}

/** The pid the command recorded, or 0 before it started. */
async function recordedPid(pidFile: string): Promise<number> {
  const text = await readFile(pidFile, 'utf8').catch(() => '');
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isFinite(pid) ? pid : 0;
}

/** Whether the OS still has this process. */
function processExists(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (reason) {
    return (reason as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The size a file had reached. */
async function fileBytes(path: string): Promise<number> {
  return (await stat(path).catch(() => ({ size: 0 }))).size;
}

/** One table read from the daemon's own database. */
function query<T>(database: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

interface OperationRow {
  id: string;
  state: string;
  worker_active: number;
}

function masterOperation(database: string, taskId: string): OperationRow | undefined {
  return query<OperationRow>(
    database,
    "SELECT id,state,worker_active FROM operations WHERE task_id=? AND node_id='master' ORDER BY rowid DESC LIMIT 1",
    taskId,
  )[0];
}

/** One operation row by id: the turn that was interrupted, not the one after it. */
function operationById(database: string, operationId: string): OperationRow | undefined {
  return query<OperationRow>(database, 'SELECT id,state,worker_active FROM operations WHERE id=?', operationId)[0];
}

interface ConversationView {
  anchorTaskId?: string;
  master?: { status?: string };
  messages?: { role?: string; kind?: string; state?: string }[];
}

/** Starts the daemon a test drives, with one scripted provider as its model. */
async function startDaemon(root: string, fixture: { project: string }, baseUrl: string, requestId: string) {
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: fixture.project }],
    credentials: { local: { secretRef: 'GRAPH_INTERRUPT_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high',
      api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_INTERRUPT_KEY: 'synthetic-interrupt-key' }, extraArgs: ['--execute'] });
  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Run the tool and wait for it.', requestId }),
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const conversationId = (await created.json()).conversationId as string;
  const conversation = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
  return { daemon, conversationId, taskId: conversation.anchorTaskId ?? '' };
}

/** Sends the console's own interrupt request against a real daemon. */
async function interrupt(daemon: { url: string }, conversationId: string, cookie: string) {
  const startedAt = Date.now();
  let reply: Response;
  try {
    reply = await fetch(`${daemon.url}/api/conversations/${conversationId}/interrupt`, {
      method: 'POST',
      headers: { origin: daemon.url, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: `interrupt-${conversationId}` }),
      signal: AbortSignal.timeout(REQUEST_CAP_MS),
    });
  } catch (reason) {
    throw new Error(`the interrupt request was still open after ${REQUEST_CAP_MS}ms: ${String(reason)}`);
  }
  return { elapsed: Date.now() - startedAt, reply };
}

/** The cookie the daemon's browser session uses. */
async function sessionCookie(url: string): Promise<string> {
  return (await fetch(url)).headers.get('set-cookie') ?? '';
}

/**
 * Why this host cannot run a sandboxed command, or null when it can.
 *
 * The daemon runs every tool command inside a macOS seatbelt profile, and a
 * profile cannot be applied from inside another one. A test process that is
 * itself sandboxed (an Agent session, for one) therefore has no way to reach
 * the real behaviour; the host gate runs the same test outside that sandbox.
 */
function sandboxBlocker(): string | null {
  if (process.platform !== 'darwin') return `tool commands need the macOS seatbelt, and this host is ${process.platform}`;
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8' });
  if (probe.status === 0) return null;
  const detail = (probe.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  return `sandbox-exec cannot be applied from this process (exit ${probe.status ?? probe.signal}): ${detail}`;
}

const SANDBOX_BLOCKER = sandboxBlocker();

/** A server that accepts the request and never answers it. */
async function neverAnsweringServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(() => {
    // The response is held open on purpose: the fetch tool stays in flight.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/never`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

test('an interrupt answers at once while a tool call is still in flight and settles the operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-interrupt-inflight-'));
  const fixture = await projectFixture(root);
  // A fetch of a server that never answers keeps a real tool call in flight
  // inside the daemon without a child process, so this half proves the stall
  // the user hit on any host.
  const slow = await neverAnsweringServer();
  const provider = await openaiServer([
    { tools: [{ id: 'call-1', name: 'fetch', arguments: JSON.stringify({ url: slow.url }) }] },
    { text: '已停止。' },
  ]);
  const { daemon, conversationId, taskId } = await startDaemon(root, fixture, provider.model.baseUrl, 'interrupt-inflight-1');
  const database = join(root, 'state', 'tasks.sqlite');
  try {
    // The tool really is running: its message is pending and the operation is
    // dispatched, the state the report describes.
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
      return (view.messages ?? []).some(message => message.role === 'tool' && message.state === 'pending');
    }, { timeout: 60_000, interval: 100 }).toBe(true);
    await expect.poll(() => masterOperation(database, taskId)?.state, { timeout: 30_000, interval: 100 }).toBe('dispatched');
    const interrupted = masterOperation(database, taskId);
    const operationId = interrupted?.id ?? '';
    expect(operationId, 'the dispatched master operation has no id').not.toBe('');

    const { elapsed, reply } = await interrupt(daemon, conversationId, await sessionCookie(daemon.url));
    const body = await reply.json().catch(() => ({}));
    expect(reply.status, JSON.stringify(body)).toBe(200);
    expect(body.state, 'the daemon did not accept the interrupt').toBe('interrupted');
    expect(elapsed, `the interrupt took ${elapsed}ms while a tool was running; it must answer without the tool`).toBeLessThan(INTERRUPT_BUDGET_MS);

    // The interrupted turn reaches a terminal state of its own.
    await expect.poll(() => operationById(database, operationId)?.state, { timeout: 30_000, interval: 100 }).toBe('interrupted');
    expect(operationById(database, operationId)?.worker_active, 'the interrupted operation still holds a worker').toBe(0);
    const pending = (view: ConversationView) => (view.messages ?? []).filter(message => message.role === 'tool' && message.state === 'pending');
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
      const running = view.master?.status === 'running' || view.master?.status === 'preparing';
      return `${running ? 'busy' : 'rest'}/${pending(view).length}`;
    }, { timeout: 30_000, interval: 100 }).toBe('rest/0');
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
    expect(pending(view).length, `a tool message is still pending: ${JSON.stringify(pending(view))}`).toBe(0);
  } finally {
    await slow.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
    await provider.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 180_000);

test('an interrupt kills the running command and no output arrives after it', async ({ skip }) => {
  if (SANDBOX_BLOCKER) {
    // Loud, not silent: an unverified half is not a passing half.
    console.log(`[interrupt-cancel] cannot start a real command from this process: ${SANDBOX_BLOCKER}`);
    skip(`tool commands are unverified here: ${SANDBOX_BLOCKER}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'graph-interrupt-kill-'));
  const fixture = await projectFixture(root);
  const pidFile = join(fixture.project, 'command.pid');
  const heartbeat = join(fixture.project, 'command-heartbeat.txt');
  // The command names its own pid and keeps writing: a file that stops growing
  // proves the process is gone, not that it was asked to stop.
  const command = `echo $$ > '${pidFile}'; while : ; do printf . >> '${heartbeat}'; sleep 0.2; done`;
  const provider = await openaiServer([
    { tools: [{ id: 'call-1', name: 'bash', arguments: JSON.stringify({ command, timeout: 600_000 }) }] },
    { text: '已停止。' },
  ]);
  const { daemon, conversationId, taskId } = await startDaemon(root, fixture, provider.model.baseUrl, 'interrupt-kill-1');
  const database = join(root, 'state', 'tasks.sqlite');
  try {
    await expect.poll(() => recordedPid(pidFile), { timeout: 60_000, interval: 100 }).toBeGreaterThan(0);
    await expect.poll(() => fileBytes(heartbeat), { timeout: 30_000, interval: 100 }).toBeGreaterThan(0);
    const pid = await recordedPid(pidFile);
    expect(processExists(pid), `the command pid ${pid} is not running, so nothing was interrupted\nstderr: ${daemon.stderr}`).toBe(true);
    await expect.poll(() => masterOperation(database, taskId)?.state, { timeout: 30_000, interval: 100 }).toBe('dispatched');
    const operationId = masterOperation(database, taskId)?.id ?? '';
    expect(operationId, 'the dispatched master operation has no id').not.toBe('');

    const { elapsed, reply } = await interrupt(daemon, conversationId, await sessionCookie(daemon.url));
    const body = await reply.json().catch(() => ({}));
    expect(reply.status, JSON.stringify(body)).toBe(200);
    expect(elapsed, `the interrupt request took ${elapsed}ms; it must answer without waiting for the command`).toBeLessThan(INTERRUPT_BUDGET_MS);

    // The child is killed, not asked to stop: the operating system no longer
    // has the pid the command recorded.
    await expect.poll(() => processExists(pid), { timeout: 15_000, interval: 100 }).toBe(false);
    // Nothing the command would have produced arrives after the interrupt.
    const stoppedAt = await fileBytes(heartbeat);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(await fileBytes(heartbeat), 'the command kept writing after the interrupt').toBe(stoppedAt);
    // The operation reached a terminal state instead of staying dispatched.
    await expect.poll(() => operationById(database, operationId)?.state, { timeout: 30_000, interval: 100 }).toBe('interrupted');
    expect(operationById(database, operationId)?.worker_active, 'the interrupted operation still holds a worker').toBe(0);
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
    const pending = (view.messages ?? []).filter(message => message.role === 'tool' && message.state === 'pending');
    expect(pending.length, `a tool message is still pending: ${JSON.stringify(pending)}`).toBe(0);
    // The interrupt did not start another tool call.
    const toolMessages = query<{ n: number }>(database, "SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='tool'", conversationId);
    expect(toolMessages[0]?.n, 'the interrupt started another tool call').toBe(1);
  } finally {
    await daemon.close().catch(() => undefined);
    await provider.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 180_000);

test('the console says 打断中 first and 已打断 when the turn is gone', async ({ skip }) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-interrupt-console-'));
  const fixture = await projectFixture(root);
  const slow = await neverAnsweringServer();
  const provider = await openaiServer([
    { tools: [{ id: 'call-1', name: 'fetch', arguments: JSON.stringify({ url: slow.url }) }] },
    { text: '已停止。' },
  ]);
  // The console is built the way the daemon serves it.
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: join(root, 'web'), emptyOutDir: true } });
  const { daemon, conversationId, taskId } = await startDaemon(root, fixture, provider.model.baseUrl, 'interrupt-console-1');
  const database = join(root, 'state', 'tasks.sqlite');
  let browser: Browser | undefined;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (reason) {
      // The window service decides whether a browser can run here; without it
      // this half is unverified rather than silently passing.
      const detail = String(reason).split('\n')[0];
      console.log(`[interrupt-cancel] cannot launch a browser here: ${detail}`);
      skip(`the console is unverified here: chromium cannot launch: ${detail}`);
      return;
    }
    const page = await browser.newPage();
    await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
    const status = page.getByTestId('master-status');
    await status.waitFor({ timeout: 60_000 });
    await expect.poll(() => status.textContent(), { timeout: 60_000, interval: 100 }).toContain('正在处理');
    const operationId = masterOperation(database, taskId)?.id ?? '';
    expect(operationId, 'the console is over no running operation').not.toBe('');
    // Every label the toolbar shows, in the order it shows them, so the
    // sequence is read from the DOM instead of sampled.
    await page.evaluate(() => {
      const holder = window as unknown as { __masterStatus: string[] };
      holder.__masterStatus = [];
      const record = () => {
        const text = document.querySelector('[data-testid="master-status"]')?.textContent?.trim() ?? '';
        if (text && holder.__masterStatus[holder.__masterStatus.length - 1] !== text) holder.__masterStatus.push(text);
      };
      record();
      new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true });
    });

    await page.keyboard.press('Escape');

    await expect.poll(async () => page.evaluate(() => (window as unknown as { __masterStatus: string[] }).__masterStatus.join('|')), {
      timeout: 30_000, interval: 100,
    }).toContain('已打断');
    const seen = await page.evaluate(() => (window as unknown as { __masterStatus: string[] }).__masterStatus as string[]);
    const interrupting = seen.findIndex(label => label.includes('打断中'));
    const interrupted = seen.findIndex(label => label.includes('已打断'));
    expect(interrupting, `the console never said 打断中: ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(0);
    expect(interrupted, `the console never said 已打断: ${JSON.stringify(seen)}`).toBeGreaterThan(interrupting);
    // The label was not a spinner: the turn the reader interrupted is over.
    await expect.poll(() => operationById(database, operationId)?.state, { timeout: 30_000, interval: 100 }).toBe('interrupted');
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
    const pending = (view.messages ?? []).filter(message => message.role === 'tool' && message.state === 'pending');
    expect(pending.length, `a tool message is still pending: ${JSON.stringify(pending)}`).toBe(0);
  } finally {
    await browser?.close().catch(() => undefined);
    await slow.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
    await provider.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 240_000);
