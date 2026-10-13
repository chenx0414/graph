// Capability helper only: model execution and persistent history belong to durable.
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createEventBus, createExtensionRuntime } from '@earendil-works/pi-coding-agent';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { loadExtensions, loadExtensionFromFactory } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'core/extensions/loader.js')).href);
const bus = createEventBus();
const runtime = createExtensionRuntime();
const tools = new Map();
const unsupported = name => { throw new Error(`capability_unsupported: ${name}`); };
for (const name of ['sendMessage', 'sendUserMessage', 'appendEntry', 'setSessionName', 'getSessionName', 'setLabel', 'setModel', 'setThinkingLevel']) runtime[name] = () => unsupported(name);
let activeTools = [...config.allowedToolNames];
runtime.getActiveTools = () => [...activeTools];
runtime.getAllTools = () => [...tools.values()].map(({ definition }) => ({ name: definition.name, description: definition.description, parameters: definition.parameters }));
runtime.setActiveTools = names => {
  if (!Array.isArray(names) || names.some(name => !config.allowedToolNames.includes(name))) unsupported('setActiveTools: tool outside frozen capability');
  activeTools = [...new Set(names)];
};
const loaded = { extensions: [], errors: [], runtime };
if (config.resourcePaths?.length) {
  const requireSdk = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { createJiti } = await import(pathToFileURL(requireSdk.resolve('jiti')).href);
  const moduleRoots = [];
  for (const mapping of [...config.resourcePaths].sort((left, right) => left.source.length - right.source.length)) {
    if (!moduleRoots.some(root => mapping.source === root.source || mapping.source.startsWith(root.source + '/'))) moduleRoots.push(mapping);
  }
  const aliases = Object.fromEntries(moduleRoots.map(({ source, target }) => [source, target]));
  // Match the pinned SDK's extension compatibility surface. These are host
  // runtime modules, not a fallback to the mutable capability catalog.
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth', '@earendil-works/pi-ai/providers/all', 'typebox', 'typebox/compile', 'typebox/value']) {
    const target = name.startsWith('@earendil-works/') ? fileURLToPath(import.meta.resolve(name, import.meta.resolve('@earendil-works/pi-coding-agent'))) : requireSdk.resolve(name);
    aliases[name] = target;
    if (name.startsWith('@earendil-works/')) aliases[name.replace('@earendil-works/', '@mariozechner/')] = target;
    if (name.startsWith('typebox')) aliases[name.replace('typebox', '@sinclair/typebox')] = target;
  }
  aliases['@earendil-works/pi-ai'] = aliases['@earendil-works/pi-ai/compat'];
  aliases['@mariozechner/pi-ai'] = aliases['@earendil-works/pi-ai/compat'];
  for (const path of config.paths) {
    try {
      const jiti = createJiti(path, { fsCache: false, moduleCache: false, tryNative: false, alias: aliases });
      const factory = await jiti.import(path, { default: true });
      const result = await loadExtensionFromFactory(factory, config.workspace, bus, runtime, path);
      loaded.extensions.push(result);
    } catch (error) { loaded.errors.push({ path, error: error.message }); }
  }
} else Object.assign(loaded, await loadExtensions(config.paths, config.workspace, bus, runtime));
const supported = new Set(['resources_discover', 'session_tree', 'input', 'session_start', 'session_shutdown', 'before_agent_start', 'agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end', 'tool_call', 'tool_result']);
// The fork-only resident sleep hook may be registered by existing plugins.
// Durable never enters that lifecycle or interprets its sleepReady verdict.
const registrationOnlyLegacyHooks = new Set(['session_checkpoint']);
for (const extension of loaded.extensions) {
  for (const name of extension.handlers.keys()) if (!supported.has(name) && !registrationOnlyLegacyHooks.has(name)) loaded.errors.push({ path: extension.path, error: `capability_unsupported: hook ${name}` });
  for (const [name, registered] of extension.tools) {
    if (tools.has(name)) loaded.errors.push({ path: extension.path, error: `Duplicate plugin tool ${name}` });
    else tools.set(name, registered);
  }
}
if (runtime.pendingProviderRegistrations.length || runtime.pendingNativeProviderRegistrations.length) loaded.errors.push({ path: 'plugins', error: 'capability_unsupported: provider registration' });
let systemPrompt = config.systemPrompt;
let snapshot = config.context;
const readContext = key => { if (!snapshot) unsupported('session context unavailable'); return structuredClone(snapshot[key]); };
const sessionManager = new Proxy(Object.freeze({
  getEntries: () => readContext('entries'), getBranch: () => readContext('branch'),
  getSessionId: () => readContext('sessionId'), getLeafId: () => readContext('leafId'),
}), { get: (target, name) => Reflect.get(target, name) ?? (() => unsupported(`sessionManager.${String(name)}`)) });
const modelRegistry = new Proxy(Object.freeze({
  getAvailable: () => snapshot?.model ? [readContext('model')] : [],
  getAll: () => snapshot?.model ? [readContext('model')] : [],
}), { get: (target, name) => Reflect.get(target, name) ?? (() => unsupported(`modelRegistry.${String(name)}`)) });
// Status text is presentation-only. Headless durable sessions have no terminal
// footer; support the SDK's headless no-op without enabling interactive APIs.
const headlessUi = new Proxy(Object.freeze({ theme: undefined, setStatus: () => {}, notify: () => {} }), {
  get: (target, name) => Reflect.has(target, name) ? Reflect.get(target, name) : () => unsupported(`ui.${String(name)}`),
});
const context = (signal) => ({
  cwd: config.workspace, model: snapshot?.model ?? config.model, mode: 'rpc', hasUI: false,
  ui: headlessUi,
  sessionManager,
  modelRegistry,
  scopedModels: [], thinkingLevel: config.thinkingLevel, signal,
  isIdle: () => false, isProjectTrusted: () => true, hasPendingMessages: () => false,
  abort: () => unsupported('abort'), shutdown: () => unsupported('shutdown'), compact: () => unsupported('compact'),
  getContextUsage: () => snapshot ? readContext('contextUsage') : undefined, getSystemPrompt: () => systemPrompt,
});
async function emit(event, signal) {
  const results = [];
  for (const extension of loaded.extensions) for (const handler of extension.handlers.get(event.type) ?? []) results.push(await handler(event, context(signal)));
  return results;
}
const registrations = [];
const registeredServers = new Set();
function registerServers() {
  for (const server of config.servers) {
    if (registeredServers.has(server.name)) continue;
    const request = { version: 1, name: server.name, definition: server.definition };
    bus.emit('pi-mcp-adapter:runtime-register:v1', request);
    if (request.result?.ok) { registeredServers.add(server.name); registrations.push(request.result.registration); }
    else if (request.result && !request.result.ok) throw new Error(`MCP adapter refused ${server.name}: ${request.result.error?.message}`);
  }
}
const send = value => writeSync(3, `${JSON.stringify(value)}\n`);
const controllers = new Map();
async function handle(request) {
  if (request.method === 'setContext') { snapshot = request.snapshot; await emit({ type: 'session_tree' }); return null; }
  if (request.method === 'ready') {
    if (loaded.errors.length) throw new Error(loaded.errors.map(error => `${error.path}: ${error.error}`).join('\n'));
    const discovered = await emit({ type: 'resources_discover', cwd: config.workspace });
    await emit({ type: 'session_start' }); registerServers();
    return { loadedExtensions: loaded.extensions.map(extension => extension.path), extensionErrors: [], discoveredSkillPaths: [...new Set(discovered.flatMap(result => result?.skillPaths ?? []))], tools: [...tools.values()].map(({ definition: tool }) => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines })) };
  }
  if (request.method === 'event') { await emit(request.event); return null; }
  if (request.method === 'beforeTool') {
    for (const result of await emit({ type: 'tool_call', toolName: request.name, toolCallId: request.callId, input: request.args })) if (result?.block) return result;
    return null;
  }
  if (request.method === 'afterTool') {
    let result = request.result;
    for (const hook of await emit({ type: 'tool_result', toolName: request.name, toolCallId: request.callId, input: request.args, ...result })) if (hook) result = { ...result, ...hook };
    return result;
  }
  if (request.method === 'beforePrompt') {
    const inputs = await emit({ type: 'input', text: request.text, images: request.images, source: 'rpc' });
    for (const input of inputs) if (input && input.action && input.action !== 'continue') unsupported('input transformation');
    const messages = [];
    systemPrompt = request.systemPrompt;
    for (const extension of loaded.extensions) for (const handler of extension.handlers.get('before_agent_start') ?? []) {
      const result = await handler({ type: 'before_agent_start', prompt: request.text, images: request.images, systemPrompt }, context());
      if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
      if (result?.message) messages.push(result.message);
    }
    registerServers();
    return { systemPrompt, messages };
  }
  if (request.method === 'call') {
    const tool = tools.get(request.name)?.definition;
    if (!tool || !config.allowedToolNames.includes(request.name)) throw new Error(`Tool not granted: ${request.name}`);
    const controller = new AbortController(); controllers.set(request.id, controller);
    try {
      return await tool.execute(request.callId, request.args, controller.signal, update => send({ update: request.id, value: update }), context(controller.signal));
    } finally { controllers.delete(request.id); }
  }
  if (request.method === 'close') {
    await emit({ type: 'session_shutdown' });
    for (const registration of registrations) await registration.dispose();
    return null;
  }
  throw new Error(`Unknown plugin command ${request.method}`);
}
for await (const line of createInterface({ input: process.stdin })) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  if (request.method === 'cancel') { controllers.get(request.target)?.abort(); continue; }
  void handle(request).then(result => send({ id: request.id, result }), error => send({ id: request.id, error: error instanceof Error ? error.message : String(error) }));
}
