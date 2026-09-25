import { expect, test } from 'vitest';
import { MCP_RUNTIME_REGISTER_EVENT, mcpAdapterBridge } from '../../src/runtime/mcp-adapter-bridge.ts';

/**
 * The adapter only accepts a runtime server once its own session state exists,
 * and it is installed as a sibling extension, so the registration is an
 * ordering question between two extensions. An unanswered event means nobody
 * was listening yet: the bridge has to try again and say so when it fails,
 * because a dropped registration leaves an empty gateway with no trace.
 */
function stubPi(answer: (request: Record<string, unknown>) => void) {
  const handlers = new Map<string, (event?: unknown) => void>();
  const emitted: { name: string; request: Record<string, unknown> }[] = [];
  const pi = {
    on: (name: string, handler: (event?: unknown) => void) => { handlers.set(name, handler); },
    events: {
      emit: (name: string, request: Record<string, unknown>) => {
        emitted.push({ name, request });
        answer(request);
      },
    },
  };
  return { pi, handlers, emitted };
}

const servers = [{ name: 'context7', definition: { command: 'node', args: ['/abs/entry.js'] } }];

function bridge(pi: unknown) {
  const extension = mcpAdapterBridge(servers) as { factory: (pi: unknown) => void };
  extension.factory(pi);
  return extension;
}

test('a round nobody answers stays pending and is tried again before the next turn', () => {
  const { pi, handlers, emitted } = stubPi(() => undefined);
  bridge(pi);
  handlers.get('session_start')!();
  expect(emitted).toHaveLength(1);
  handlers.get('before_agent_start')!();
  expect(emitted).toHaveLength(2);
  expect(emitted.every(entry => entry.name === MCP_RUNTIME_REGISTER_EVENT)).toBe(true);
  expect(emitted[1]!.request.name).toBe('context7');
});

test('a registered server is not registered twice on the following turn', () => {
  const { pi, handlers, emitted } = stubPi(request => {
    request.result = { ok: true, registration: { dispose: async () => undefined } };
  });
  bridge(pi);
  handlers.get('session_start')!();
  expect(emitted).toHaveLength(1);
  handlers.get('before_agent_start')!();
  expect(emitted).toHaveLength(1);
});

test('a refused registration is reported and retried instead of silently dropped', () => {
  const reported: string[] = [];
  const { pi, handlers, emitted } = stubPi(request => {
    request.result = { ok: false, error: new Error('adapter has no active state') };
  });
  const extension = mcpAdapterBridge(servers, message => reported.push(message)) as { factory: (pi: unknown) => void };
  extension.factory(pi);
  handlers.get('session_start')!();
  expect(emitted).toHaveLength(1);
  expect(reported.join('\n')).toContain('adapter has no active state');
  handlers.get('before_agent_start')!();
  expect(emitted).toHaveLength(2);
  // The same refusal is not repeated on every turn.
  expect(reported).toHaveLength(1);
});
