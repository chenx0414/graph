import { createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition, loadSkills, formatSkillsForPrompt, type GrepToolInput, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { mkdir, stat, realpath } from 'node:fs/promises';
import { join, resolve, relative, sep, matchesGlob } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSessionRequest } from './agent-session.ts';
import { isExternallyGated } from './pi-instance.ts';
import { listBounded, listHost, readBoundedBytes, readHostBytes, writeBounded, writeHost, resolveBounded } from './bounded-path.ts';
import { acquireRestrictedExecutor } from './restricted-process.ts';
import { developerPath } from './developer-path.ts';
import { openDurablePlugins, type DurablePluginContext } from './durable-plugin.ts';
import { selectAgentToolSurface } from './pi-native-tools.ts';

/** Capability handlers are called under their existing gate; native shell is
 * executed by the OS policy executor, never by the model host's shell. */
export async function openDurableTools(request: AgentSessionRequest, options: { context?: DurablePluginContext; refreshContext?: () => Promise<DurablePluginContext> } = {}) {
  const roots = [...new Set([request.workspace, ...request.readRoots ?? [], ...request.writeRoots ?? []])];
  const pathOptions = { protectedPaths: request.protectedPaths ?? [], allowGitMetadata: request.allowGitMetadataWritesAll ?? false, allowSymlinks: true };
  const boundedRoot = (path: string, write = false) => {
    const approved = write ? [request.workspace, ...request.writeRoots ?? []] : roots;
    const root = approved.find(root => path === root || path.startsWith(root + sep));
    if (!root) throw new Error('Path is outside the workspace and granted roots');
    return root;
  };
  const checkWrite = () => { if (request.readOnly) throw new Error('This agent workspace is read-only'); };
  const read = async (path: string) => request.filesystemAccess === 'host' ? readHostBytes(path, pathOptions) : readBoundedBytes(boundedRoot(path), relative(boundedRoot(path), path) || '.');
  const write = async (path: string, content: string) => {
    checkWrite();
    if (request.filesystemAccess === 'host') await writeHost(path, content, pathOptions);
    else { const root = boundedRoot(path, true); await writeBounded(root, relative(root, path), content); }
  };
  const list = async (path: string) => request.filesystemAccess === 'host' ? listHost(path, pathOptions) : listBounded(boundedRoot(path), relative(boundedRoot(path), path) || '.');
  const shell = async (command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }) => {
    const scratch = join(request.stateDir, 'durable-tools-scratch');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const acquired = await acquireRestrictedExecutor();
    try {
      const result = await acquired.executor.run({ broker: { dispatch: (_id, _reservation, send) => send(), settle: () => {} },
        cwd, scratchDir: scratch, executable: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash', args: process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command],
        readPaths: request.readOnly && request.filesystemAccess === 'host' ? ['/', ...roots] : roots, writePaths: request.readOnly ? [scratch] : [request.workspace, scratch, ...request.writeRoots ?? []],
        ...(request.filesystemAccess === 'host' && !request.readOnly ? { filesystem: 'host' as const, ...(!request.readOnly ? { unsandboxed: true } : {}), protectedPathExceptions: [request.stateDir] } : {}),
        protectedPaths: request.protectedPaths ?? [], denyWrite: request.readOnly ? [request.workspace] : [], allowGitMetadataWritesAll: request.allowGitMetadataWritesAll ?? false,
        env: { ...request.env, PATH: developerPath(request.env?.PATH ?? process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin') }, networkDomains: request.networkDomains ?? [],
        allowUnrestrictedNetwork: request.allowUnrestrictedNetwork ?? false, allowLocalBinding: request.allowLocalBinding ?? false,
        unixSockets: request.unixSockets ?? [], allowAllUnixSockets: request.allowAllUnixSockets ?? false, allowAppleEvents: request.allowAppleEvents ?? false,
        ...(options.signal ? { signal: options.signal } : {}), ...(options.timeout ? { timeoutMs: options.timeout * 1000 } : {}),
        onStdout: text => options.onData(Buffer.from(text)),
      });
      if (result.stderr) options.onData(Buffer.from(result.stderr));
      return { exitCode: result.code };
    } finally { acquired.release(); }
  };
  const native: ToolDefinition<any, any>[] = [
    createReadToolDefinition(request.workspace, { autoResizeImages: false, operations: { readFile: read, access: async path => { await read(path); }, detectImageMimeType: async path => {
      const bytes = await read(path);
      if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
      if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
      if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
      if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
      if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
      return null;
    } } }),
    createWriteToolDefinition(request.workspace, { operations: { writeFile: write, mkdir: async path => { checkWrite(); if (request.filesystemAccess !== 'host') { const root = boundedRoot(path, true); if (path !== root) await resolveBounded(root, relative(root, path), 'write'); } } } }),
    createEditToolDefinition(request.workspace, { operations: { readFile: read, writeFile: write, access: async path => { checkWrite(); await read(path); } } }),
    createLsToolDefinition(request.workspace, { operations: { readdir: async path => await list(path), exists: async path => { await list(path); return true; }, stat: async path => { if (request.filesystemAccess === 'host') { try { await list(path); } catch { await read(path); } } else { const root = boundedRoot(path); await resolveBounded(root, relative(root, path) || '.', 'read'); } return stat(path); } } }),
    createBashToolDefinition(request.workspace, { exposeSessionEnvironment: false, operations: { exec: shell } }),
  ];
  const walk = async function* (path: string): AsyncGenerator<string> {
    for (const name of await list(path)) {
      if (name === '.git') continue;
      const child = join(path, name);
      try { await list(child); yield* walk(child); }
      catch (error) { try { await read(child); yield child; } catch { if (!(error instanceof Error)) throw error; } }
    }
  };
  native.push(createFindToolDefinition(request.workspace, { operations: {
    exists: async path => { await list(path); return true; },
    glob: async (pattern, cwd, options) => { const files: string[] = []; for await (const file of walk(cwd)) { if (matchesGlob(relative(cwd, file), pattern)) files.push(relative(cwd, file)); if (files.length >= options.limit) break; } return files; },
  } }));
  const grep = createGrepToolDefinition(request.workspace);
  native.push({ name: grep.name, label: grep.label, description: grep.description, parameters: grep.parameters, async execute(_id: string, args: GrepToolInput) {
    const path = resolve(request.workspace, args.path ?? '.');
    const matcher = args.literal ? null : new RegExp(args.pattern, args.ignoreCase ? 'i' : '');
    const found: string[] = [];
    const scan = async (file: string) => {
      if (args.glob && !matchesGlob(relative(path, file), args.glob)) return;
      const lines = (await read(file)).toString('utf8').split('\n');
      for (let i = 0; i < lines.length && found.length < (args.limit ?? 100); i++) {
        const line = lines[i]!;
        const match = matcher ? matcher.test(line) : (args.ignoreCase ? line.toLowerCase().includes(args.pattern.toLowerCase()) : line.includes(args.pattern));
        if (match) { for (let j = Math.max(0, i - (args.context ?? 0)); j <= Math.min(lines.length - 1, i + (args.context ?? 0)); j++) found.push(`${relative(request.workspace, file)}:${j + 1}:${lines[j]}`); }
      }
    };
    let directory = false; try { await list(path); directory = true; } catch { await scan(path); }
    if (directory) for await (const file of walk(path)) { await scan(file); if (found.length >= (args.limit ?? 100)) break; }
    return { content: [{ type: 'text', text: found.join('\n') || 'No matches found' }], details: {} };
  } });
  const enabled = new Set(request.nativeTools ?? []);
  const surface = selectAgentToolSurface({ nativeTools: [...enabled], tools: request.tools ?? [] });
  const plugins = await openDurablePlugins(request, options.context ? { context: options.context } : {});
  const definitions = [...native.filter(tool => enabled.has(tool.name)), ...surface.tools, ...plugins.tools];
  const unsupported = [...enabled].filter(name => !definitions.some(tool => tool.name === name));
  if (unsupported.length) throw new Error(`Durable native tools not installed: ${unsupported.join(', ')}`);
  const discoveredSkills = await Promise.all(plugins.discoveredSkillPaths.map(async path => { const approved = await realpath(path); boundedRoot(approved); return approved; }));
  const skills = loadSkills({ cwd: request.workspace, agentDir: request.stateDir, includeDefaults: false, skillPaths: [...discoveredSkills, ...request.skillPaths ?? [], ...request.skillFolder ? [request.skillFolder] : []] });
  let stopping = false;
  let runningTools = 0;
  const tools: ToolRegistration[] = definitions.map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters,
    replay: 'unsafe', executionMode: 'sequential',
    async execute(args, api, context) {
      if (stopping) return { content: [{ type: 'text', text: 'Stopped before tool execution' }], control: { terminate: true } };
      runningTools += 1;
      const started = Date.now();
      const id = randomUUID();
      let isError = false;
      try {
        const execute = () => Reflect.apply(tool.execute, tool, [api.callId, args, context.abortSignal, (update: { content: { type: string; text?: string }[] }) => {
          for (const part of update.content) if (part.type === 'text') api.output(part.text ?? '');
        }, undefined]);
        if (options.refreshContext) await plugins.setContext(await options.refreshContext());
        const block = await plugins.beforeTool(tool.name, api.callId, args);
        if (block?.block) throw new Error(block.reason ?? 'Plugin blocked tool call');
        const original = await (isExternallyGated(tool) ? execute() : request.broker.dispatch(id, 0, execute));
        const result = await plugins.afterTool(tool.name, api.callId, args, original);
        if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) throw new Error('Tool returned an invalid content result');
        isError = 'isError' in result && Boolean(result.isError);
        if ('terminate' in result && result.terminate) stopping = true;
        return { content: result.content, ...('details' in result && result.details !== undefined ? { details: JSON.parse(JSON.stringify(result.details)) } : {}), isError, ...(stopping || ('terminate' in result && result.terminate) ? { control: { terminate: true as const } } : {}) };
      } catch (error) { isError = true; throw error; }
      finally {
        runningTools -= 1;
        if (!isExternallyGated(tool)) request.broker.settle(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        try { request.onToolCall?.({ tool: tool.name, ms: Date.now() - started, isError, target: null }); } catch { /* telemetry cannot replace tool result */ }
      }
    },
  }));
  return { stop: () => { stopping = true; }, get runningTools() { return runningTools; }, get stopped() { return stopping; }, tools, skillsPrompt: formatSkillsForPrompt(skills.skills), activeTools: definitions.map(tool => tool.name), loadedExtensions: plugins.loadedExtensions, extensionErrors: plugins.extensionErrors, beforePrompt: async (...args: Parameters<typeof plugins.beforePrompt>) => { if (options.refreshContext) await plugins.setContext(await options.refreshContext()); return plugins.beforePrompt(...args); }, onEvent: plugins.onEvent, close: plugins.close };
}
