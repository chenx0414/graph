import { pathToFileURL } from 'node:url';
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { unlink, chmod } from 'node:fs/promises';
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageFrame } from '@earendil-works/pi-ai';
import { Type } from '@earendil-works/pi-ai';
import { TaskStore } from '../core/store.ts';
import { createDurableSessionTransport } from './durable-session.ts';
import { importMainHistories } from './durable-migration.ts';
import { replayAssistantStream } from './assistant-stream-frames.ts';
import { workerModelOptions } from './worker-model-options.ts';
import { restoreDurableResources } from './durable-freeze.ts';
import { externallyGated } from './tool-gating.ts';
import type { AgentSession, AgentSessionRequest } from './agent-session.ts';

/** Private SDK host. Go retains business state, credentials and every send gate. */
export async function runDurableService() {
const [database, address, instancesDir] = process.argv.slice(2);
if (!database || !address || !instancesDir) throw new Error('database, socket and instances directory are required');
const store = new TaskStore(database);
const transport = await createDurableSessionTransport(store);
await importMainHistories(store, transport.host, instancesDir);
const connections = new Set<Socket>();
let closing = false;
const server = createServer(socket => {
  connections.add(socket);
  const callbacks = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  let session: AgentSession | undefined;
  const send = (value: unknown) => { if (socket.destroyed) throw new Error('Go session owner disconnected'); socket.write(JSON.stringify(value) + '\n'); };
  const call = (kind: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const callId = randomUUID(); callbacks.set(callId, { resolve, reject });
    try { send({ callId, kind, params }); } catch (error) { callbacks.delete(callId); reject(error); }
  });
  const notifications = new Set<Promise<unknown>>();
  let notificationError: unknown;
  const drainNotifications = async () => { while (notifications.size) await Promise.allSettled([...notifications]); if (notificationError) { const error = notificationError; notificationError = undefined; throw error; } };
  const notify = (kind: string, params: unknown) => {
    const pending = call(kind, params); notifications.add(pending);
    void pending.catch(error => { if (kind !== 'telemetry') notificationError ??= error; }).finally(() => notifications.delete(pending));
  };
  socket.on('close', () => {
    connections.delete(socket);
    for (const pending of callbacks.values()) pending.reject(new Error('Go session owner disconnected'));
    callbacks.clear();
    void session?.stop().finally(() => session?.close()).catch(error => process.stderr.write(String(error) + '\n'));
  });
  type GoConfig = Omit<AgentSessionRequest, 'tools' | 'stream' | 'broker' | 'onEvent'> & { tools: { name: string; label: string; description: string; parameters: unknown }[] };
  const assemble = (config: GoConfig): AgentSessionRequest => {
    const invoke = (kind: string, params: object) => call(kind, { ...params, executionId: config.executionId });
    const observe = (kind: string, params: object) => notify(kind, { ...params, executionId: config.executionId });
      return {
        ...config,
        tools: config.tools.map(tool => externallyGated({ ...tool, parameters: Type.Unsafe(tool.parameters as never), execute: async (id, args, signal) => {
          const cancel = () => observe('cancel', { target: id });
          signal?.addEventListener('abort', cancel, { once: true });
          try { return await invoke('tool', { id, name: tool.name, args }); }
          finally { signal?.removeEventListener('abort', cancel); }
        } })),
        stream: async (_model, context, options) => {
          const target = randomUUID();
          const cancel = () => observe('cancel', { target });
          options?.signal?.addEventListener('abort', cancel, { once: true });
          try {
            const reply = await invoke('model', { target, context, options: workerModelOptions(options), events: true }) as { frames: AssistantMessageFrame[]; settlement: AssistantMessage };
            const output = createAssistantMessageEventStream();
            for (const event of replayAssistantStream(reply.frames, reply.settlement)) output.push(event);
            return output;
          } finally { options?.signal?.removeEventListener('abort', cancel); }
        },
        broker: {
          dispatch: <T>(id: string, _reservation: number, effect: () => T): T => (async () => { await invoke('native_gate', { id, name: id.split(':')[1] }); return await effect(); })() as T,
          settle: id => observe('native_settle', { id, name: id.split(':')[1] }),
        },
        onEvent: event => observe('event', event),
        onToolCall: event => observe('telemetry', event),
      };
  };
  const frozenExecution = async (identity: string, executionId: string) => {
    const frozen = await transport.host.frozenExecution(identity, executionId);
    if (!frozen) return null;
    const resources = await restoreDurableResources(frozen.snapshot.configuration);
    const roots = [...frozen.snapshot.configuration.directories, ...frozen.snapshot.configuration.resources.map(resource => resource.path), ...frozen.snapshot.configuration.aliases.map(alias => alias.path)].sort((a,b) => b.length-a.length);
    const remap = (path: string) => roots.some(root => path === root || path.startsWith(root + '/')) ? resources.pathFor(path) : path;
    const project = (value: unknown): any => typeof value === 'string' ? remap(value) : Array.isArray(value) ? value.map(project) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key,project(item)])) : value;
    const policy = frozen.snapshot.configuration.policy;
    return { ...frozen, restoredPolicy: { ...project(policy), workspace: policy.workspace, stateDir: policy.stateDir, readRoots: [...policy.readRoots, resources.directory], writeRoots: policy.writeRoots, protectedPaths: [...policy.protectedPaths, resources.directory] }, restoredDescriptor: project(frozen.snapshot.configuration.descriptor) };
  };
  const handle = async (method: string, params: any) => {
    if (closing) throw new Error('Durable service is closing');
    if (method === 'completed') return transport.host.pendingAdmissions();
    if (method === 'frozenExecution') return frozenExecution(params.identity, params.executionId);
    if (method === 'recoverableInput') return await transport.recoverableInput!(params.identity, params.executionId) ?? null;
    if (method === 'recover') {
      transport.registerRecoveryFactory!(async snapshot => {
        const frozen = await frozenExecution(snapshot.identity, snapshot.executionId);
        if (!frozen) throw new Error('Original durable execution is missing');
        const config = await call('restore_admission', frozen);
        if (!config) return undefined;
        const request = assemble(config);
        if (snapshot.configuration.executionConfiguration) {
          request.onRecoveryComplete = turn => call('recovery_complete', { executionId: snapshot.executionId, turn });
          request.onRecoveryClose = () => call('recovery_close', { executionId: snapshot.executionId });
        }
        return request;
      });
      await transport.bootstrapRecovery!();
      return null;
    }
    if (method === 'open') {
      if (session) throw new Error('Connection already has a session');
      session = await transport.open(assemble(params as GoConfig));
      return session.inspect();
    }
    if (!session) throw new Error('Session has not been opened');
    if (method === 'prompt') { const result = await session.prompt(params.text, params.images); await drainNotifications(); return result; }
    if (method === 'inspect') return session.inspect();
    if (method === 'compact') { await session.compact(params.text); await drainNotifications(); return session.inspect(); }
    if (method === 'steer') return session.steer(params.text);
    if (method === 'interrupt') return session.interrupt(params.text);
    if (method === 'stop') return session.stop();
    if (method === 'close') { await session.close(); return null; }
    throw new Error('Unsupported durable command');
  };
  const lines = createInterface({ input: socket });
  lines.on('line', line => {
    void (async () => {
      const message = JSON.parse(line);
      if (message.replyTo) {
        const pending = callbacks.get(message.replyTo); callbacks.delete(message.replyTo);
        if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.value);
        return;
      }
      try { send({ replyTo: message.id, value: await handle(message.method, message.params ?? {}) }); }
      catch (error) { send({ replyTo: message.id, error: error instanceof Error ? error.message : String(error) }); }
    })().catch(error => { process.stderr.write(String(error) + '\n'); socket.destroy(); });
  });
});
await unlink(address).catch(error => { if (error.code !== 'ENOENT') throw error; });
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
await chmod(address, 0o600);
process.stdout.write('durable ready\n');
const shutdown = async () => {
  if (closing) return; closing = true;
  server.close();
  for (const connection of connections) connection.destroy();
  await transport.close();
  store.close();
  await unlink(address).catch(() => undefined);
};
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0), error => { process.stderr.write(String(error)); process.exit(1); }); });
process.once('SIGINT', () => process.emit('SIGTERM'));

process.stdin.resume();
process.stdin.once('end', () => process.emit('SIGTERM'));

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runDurableService();
