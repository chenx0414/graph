import { DatabaseSync } from 'node:sqlite';

import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { join } from 'node:path';

import { expect } from 'vitest';

/**
 * The fixtures of the acceptance-limitation closure test: two graphs whose
 * acceptance cannot pass on its own, a scripted master Agent that drives them
 * through its own tools, and the shapes both sides read back.
 */

export const CLOSABLE_DEFINITION = {
  schemaVersion: 2,
  name: 'Closable with limitations',
  protocols: { data: { type: 'object' } },
  nodes: {},
  modules: {
    unrun: {
      type: 'operation', trigger: 'each',
      inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result', args: ['test/pass.js'] },
    },
  },
  edges: {}, inputs: {}, outputs: {},
  acceptance: [
    { id: 'unrun', description: 'The host check that never ran passed', kind: 'check', module: 'unrun' },
    { id: 'human', description: 'The user accepts the delivered result', kind: 'human' },
  ],
};

/** This graph really runs its check, and the check really fails. */
export const FAILING_DEFINITION = {
  schemaVersion: 2,
  name: 'A check that failed',
  protocols: { data: { type: 'object' } },
  nodes: {},
  modules: {
    failing: {
      type: 'operation', trigger: 'each',
      inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result', args: ['test/fails.js'] },
    },
  },
  edges: {}, inputs: {}, outputs: {},
  acceptance: [{ id: 'fails', description: 'The host check passes', kind: 'check', module: 'failing' }],
};

/**
 * Everything in this graph is proved except the human acceptance, so closing it
 * is only ever the user's decision.
 */
export const ACCEPTED_DEFINITION = {
  schemaVersion: 2,
  name: 'Only the user was left',
  protocols: { data: { type: 'object' } },
  nodes: {},
  modules: {
    check: {
      type: 'operation', trigger: 'each',
      inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result', args: ['test/pass.js'] },
    },
  },
  edges: {}, inputs: {}, outputs: {},
  acceptance: [
    { id: 'check', description: 'The host check passed', kind: 'check', module: 'check' },
    { id: 'human', description: 'The user accepts the delivered result', kind: 'human' },
  ],
};

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

export interface MasterCall {
  id: string;
  name: string;
  args: unknown;
  /** The host-side work this call depends on, done before the call goes out. */
  before?: () => Promise<void>;
  /** Ask again until the answer carries what the call was waiting for. */
  until?: (results: Map<string, string>) => boolean;
}

/**
 * The master Agent: it plays the plan in order and records what every call
 * answered. The plan is played once: a later turn - the master is woken about a
 * graph it already closed - answers in words, so the facts the test asserts are
 * the ones the steps really saw.
 */
export async function masterProvider(plan: () => MasterCall[]) {
  const results = new Map<string, string>();
  const repeats = new Map<string, number>();
  const served = new Map<string, string>();
  let played = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const base = served.get(message.tool_call_id ?? '') ?? message.tool_call_id ?? '';
      if (base) results.set(base, content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // A request without tools is not the master speaking.
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = played ? undefined : plan().find(call => !spoken.has(call.id) || (call.until && !call.until(results)));
    if (!next) {
      played = true;
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Both graphs are as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    await next.before?.();
    const repeat = repeats.get(next.id) ?? 0;
    const id = repeat === 0 ? next.id : `${next.id}-${repeat}`;
    if (next.until && !next.until(results)) repeats.set(next.id, repeat + 1);
    served.set(id, next.id);
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** The graph id a tool answered with, or nothing when that call has not happened yet. */
export function graphIdOf(raw: string | undefined): string {
  return /"graphId"\s*:\s*"([^"]+)"/.exec(raw ?? '')?.[1] ?? '';
}

/** Waits for the last step of the plan, naming what did arrive when it never does. */
export async function waitForStep(master: { results: Map<string, string> }, callId: string, timeout: number) {
  try {
    await expect.poll(() => master.results.get(callId), { timeout, interval: 250 }).toBeTruthy();
    return master.results.get(callId)!;
  } catch (error) {
    throw new Error(`The plan never reached ${callId}. It answered: ${[...master.results.keys()].join(', ') || 'nothing'}`, { cause: error });
  }
}

/** The graph id a call really answered with: a plan step built too early has none. */
export function answeredGraphId(master: { results: Map<string, string> }, callId: string): string {
  const found = graphIdOf(master.results.get(callId));
  expect(found, `${callId} answered with a graph id: ${master.results.get(callId)}`).not.toBe('');
  return found;
}

/** One human acceptance question as it really stands in the database. */
export interface HumanCheckRow { id: string; status: string; answer: string | null }

/** The human acceptance questions of one criterion, oldest first. */
export function humanChecks(root: string, graphId: string, acceptanceId: string): HumanCheckRow[] {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  try {
    return db.prepare(`SELECT id,status,answer FROM questions WHERE task_id=? AND kind='human_check'
      AND json_extract(data,'$.acceptanceId')=? ORDER BY rowid`).all(graphId, acceptanceId) as unknown as HumanCheckRow[];
  } finally {
    db.close();
  }
}

export interface AcceptanceItem {
  id: string; kind: string; status: string; reason: string; waived?: boolean;
  limitation?: { reason: string; evidence: string; commit: string | null; createdAt: number; actor: string };
}

export interface AcceptanceReport {
  ready: boolean; closable: boolean; drained: boolean; commit: string | null;
  items: AcceptanceItem[];
  human: { id: string }[];
  limitations: LimitationRecord[];
}

export interface LimitationRecord {
  acceptanceId: string; reason: string; evidence: string; actor: string;
  commit: string | null; revisionVersion: number; requestId: string | null; createdAt: number;
}

export interface ClosureResult {
  graphId: string; phase: string; replayed: boolean;
  limitations: LimitationRecord[]; acceptance: AcceptanceReport;
}

/** The limitation rows one graph really has on disk, oldest first. */
export function limitationRows(root: string, graphId: string): LimitationRecord[] {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  try {
    return db.prepare(`SELECT acceptance_id AS acceptanceId,reason,evidence,actor,commit_sha AS "commit",
      revision_version AS revisionVersion,request_id AS requestId FROM kernel_acceptance_limitations
      WHERE task_id=? ORDER BY seq`).all(graphId) as unknown as LimitationRecord[];
  } finally {
    db.close();
  }
}

/** The limitations the completion wake carried to the master. */
export function completionWakeLimitations(root: string, graphId: string): LimitationRecord[] {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  try {
    const wakes = db.prepare("SELECT data FROM wake_intents WHERE kind='task_completed' AND data LIKE ?").all(`%${graphId}%`) as { data: string }[];
    expect(wakes, `one completion wake names ${graphId}`).toHaveLength(1);
    return (JSON.parse(wakes[0]!.data) as { limitations?: LimitationRecord[] }).limitations ?? [];
  } finally {
    db.close();
  }
}
