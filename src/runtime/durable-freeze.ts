import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, lstat, writeFile, symlink } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { graphApplicationRoot } from './graph-root.ts';
import type { AgentSessionRequest } from './agent-session.ts';

/** Header credentials are late-bound references, never durable plaintext. */
export function freezeDurableModel(model: AgentSessionRequest['model']) {
  const frozen: AgentSessionRequest['model'] = JSON.parse(JSON.stringify(model));
  const headerCredentials: string[] = [];
  for (const name of Object.keys(frozen.headers ?? {})) {
    if (/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$|(?:token|secret|password)$/i.test(name)) {
      headerCredentials.push(name);
      delete frozen.headers![name];
    }
  }
  return { model: frozen, headerCredentials: headerCredentials.sort() };
}

/** Immutable capability bytes live beside the original instance, independent of
 * catalog edits and symlinks. Credentials remain owned by Graph's live binding. */
export async function freezeDurableResources(request: AgentSessionRequest) {
  const archive = join(request.stateDir, 'durable-frozen-resources');
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const resources: { path: string; digest: string; archive: string }[] = [];
  const directories: string[] = [];
  const aliases: { path: string; target: string }[] = [];
  const visited = new Set<string>();
  const packages = new Map<string, { root: string; name: string; version: string; dependencies: Record<string, string> }>();
  const incomplete: string[] = [];
  const declaredRoots = request.capabilityDescriptor?.facts.filter(fact => ['pi-extension', 'extension', 'mcp'].includes(fact.kind)).map(fact => fact.path) ?? [];
  const packageRoot = async (entry: string) => {
    const source = await realpath(entry);
    const normalized = source.replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('/node_modules/');
    if (marker >= 0) {
      const parts = normalized.slice(marker + '/node_modules/'.length).split('/');
      const name = parts[0]!.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
      const root = normalized.slice(0, marker + '/node_modules/'.length) + name;
      try { await readFile(join(root, 'package.json')); return root; } catch { return undefined; }
    }
    // Never climb from a loose extension into an unrelated project's package.
    const root = declaredRoots.find(root => source === root || source.startsWith(root + '/'));
    if (!root) return undefined;
    try { await readFile(join(root, 'package.json')); return root; } catch { return undefined; }
  };
  const capture = async (path: string, roots?: string[]) => {
    const source = await realpath(path);
    const allowed = roots ?? [((await stat(source)).isDirectory() ? source : dirname(source)), ...await Promise.all((request.readRoots ?? []).map(root => realpath(root)))];
    if (request.filesystemAccess !== 'host' && !allowed.some(root => source === root || source.startsWith(root + '/'))) throw new Error(`Frozen capability resource escapes its read permissions: ${path}`);
    if (source !== path && !aliases.some(alias => alias.path === path)) aliases.push({ path, target: source });
    if (visited.has(source)) return;
    visited.add(source);
    if ((await stat(source)).isDirectory()) {
      directories.push(source);
      for (const name of (await readdir(source)).sort()) {
        if (['node_modules', '.git', 'durable-frozen-resources'].includes(name)) continue;
        if (name === '.env' || name.startsWith('.env.') || name === '.npmrc') { incomplete.push(join(source, name)); continue; }
        const child = join(source, name);
        try { await capture(child, allowed); }
        catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && (await lstat(child)).isSymbolicLink())) throw error; }
      }
      return;
    }
    const bytes = await readFile(source);
    if (/\.[cm]?[jt]sx?$/.test(source)) {
      const code = bytes.toString('utf8');
      if (/\b(?:import|require)\s*\((?!\s*['"])/.test(code) && ![...packages.keys()].some(root => source === root || source.startsWith(root + '/'))) incomplete.push(`${source}:opaque module resolution`);

    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const destination = join(archive, digest);
    try { await writeFile(destination, bytes, { flag: 'wx', mode: 0o400 }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (createHash('sha256').update(await readFile(destination)).digest('hex') !== digest) throw new Error('Frozen capability archive is corrupt');
    }
    resources.push({ path: source, digest, archive: destination });
  };
  const capturePackage = async (root: string, approvedRoots?: string[]): Promise<void> => {
    const source = await realpath(root);
    const allowed = approvedRoots ?? [source, ...await Promise.all([graphApplicationRoot(), request.workspace, request.stateDir, ...request.readRoots ?? [], ...request.writeRoots ?? [], ...declaredRoots].map(path => realpath(path)))];
    if (request.filesystemAccess !== 'host' && !allowed.some(path => source === path || source.startsWith(path + '/'))) throw new Error(`Frozen package escapes its read permissions: ${root}`);
    if (packages.has(source)) return;
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { name?: string; version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };
    const record = { root: source, name: manifest.name ?? '', version: manifest.version ?? '', dependencies: {} as Record<string, string> };
    packages.set(source, record);
    await capture(source, allowed);
    const resolveModule = createRequire(join(source, 'package.json'));
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }).sort()) {
      let target: string | undefined;
      // Export maps may intentionally expose only subpaths, not package.json
      // or a root entry. Resolve the installed package directory itself.
      for (const search of resolveModule.resolve.paths(dependency) ?? []) {
        try { const candidate = await realpath(join(search, dependency)); if (request.filesystemAccess !== 'host' && !allowed.some(path => candidate === path || candidate.startsWith(path + '/'))) { incomplete.push(`${source}:${dependency}:read permissions`); continue; } await readFile(join(candidate, 'package.json')); target = candidate; break; } catch { /* next module search path */ }
      }
      if (!target) {
        if (manifest.optionalDependencies?.[dependency] || manifest.peerDependenciesMeta?.[dependency]?.optional) continue;
        incomplete.push(`${source}:${dependency}`); continue;
      }
      record.dependencies[dependency] = await realpath(target);
      await capturePackage(target, allowed);
    }
  };
  for (const fact of request.capabilityDescriptor?.facts ?? []) await capture(['skill', 'prompt'].includes(fact.kind) ? dirname(fact.path) : fact.path);
  for (const path of [...request.skillPaths ?? [], ...request.skillFolder ? [request.skillFolder] : []]) await capture(path);
  for (const path of request.piExtensionPaths ?? []) {
    const source = await realpath(path);
    const root = await packageRoot(source);
    if (root) await capturePackage(root);
    else {
      // Loose extensions are supported resources; capture their directory so
      // static sibling imports and import.meta.url assets retain relative paths.
      let extensionRoot = dirname(source);
      const boundedRoots = await Promise.all([dirname(source), await graphApplicationRoot(), request.stateDir, request.workspace, ...request.readRoots ?? [], ...request.writeRoots ?? [], ...declaredRoots].map(root => realpath(root)));
      for (let parent = dirname(source); boundedRoots.some(root => parent === root || parent.startsWith(root + '/')); parent = dirname(parent)) {
        try { await readFile(join(parent, 'capability.json')); extensionRoot = parent; break; } catch { /* no declared capability at this ancestor */ }
        if (parent === dirname(parent)) break;
      }
      let declaredCapability = false;
      try { await readFile(join(extensionRoot, 'capability.json')); declaredCapability = true; } catch { /* loose entry */ }
      await capture(declaredCapability ? extensionRoot : source, boundedRoots);

      const record = { root: extensionRoot, name: 'graph-loose-extension', version: '1', dependencies: {} as Record<string, string> };
      packages.set(extensionRoot, record);
      const codeFiles = resources.filter(resource => resource.path.startsWith(extensionRoot + '/') && /\.[cm]?[jt]sx?$/.test(resource.path));
      for (const file of codeFiles) {
        const code = await readFile(file.archive, 'utf8');
        for (const asset of code.matchAll(/new\s+URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) await capture(resolve(dirname(file.path), asset[1]!), boundedRoots);
        for (const match of code.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]/g)) {
          const dependency = match[1] ?? match[2]!;
          if (isBuiltin(dependency)) continue;
          if (dependency.startsWith('.')) {
            const path = resolve(dirname(file.path), dependency);
            if (!boundedRoots.some(root => path === root || path.startsWith(root + '/'))) { incomplete.push(`${file.path}:${dependency}`); continue; }
            const prior = resources.length;
            try { await capture(path, boundedRoots); } catch { incomplete.push(`${file.path}:${dependency}`); continue; }
            codeFiles.push(...resources.slice(prior).filter(resource => /\.[cm]?[jt]sx?$/.test(resource.path)));
            continue;
          }
          let entry: string;
          try { entry = isAbsolute(dependency) ? dependency : createRequire(file.path).resolve(dependency); }
          catch { incomplete.push(`${file.path}:${dependency}`); continue; }
          if (request.filesystemAccess !== 'host') {
            const actual = await realpath(entry);
            if (!boundedRoots.some(root => actual === root || actual.startsWith(root + '/'))) { incomplete.push(`${file.path}:${dependency}:read permissions`); continue; }
          }
          const target = await packageRoot(entry);
          if (!target) { incomplete.push(`${file.path}:${dependency}`); continue; }
          if (!isAbsolute(dependency)) record.dependencies[dependency] = await realpath(target);
          await capturePackage(target, boundedRoots);
        }
      }
    }
  }
  const nodeExecutionConfiguration = request.nodeExecutionConfiguration ? structuredClone(request.nodeExecutionConfiguration) : null;
  if (nodeExecutionConfiguration) { delete nodeExecutionConfiguration.model.headers; const headers = freezeDurableModel(request.model).model.headers; if (headers) nodeExecutionConfiguration.model.headers = headers; }
  const executionConfiguration = request.executionConfiguration ? structuredClone(request.executionConfiguration) : null;
  if (executionConfiguration) { delete executionConfiguration.model.headers; const headers = freezeDurableModel(request.model).model.headers; if (headers) executionConfiguration.model.headers = headers; }
  return {
    nodeExecutionConfiguration,
    executionConfiguration,
    credentialReference: request.credentialReference ?? { modelId: request.model.id, provider: request.model.provider },
    headerCredentials: [...new Set([...freezeDurableModel(request.model).headerCredentials, ...request.credentialReference?.headerCredentials ?? []])].sort(),
    descriptor: request.capabilityDescriptor ?? null,
    resources, directories, aliases, packages: [...packages.values()], incomplete,
    // Keep the exact non-secret execution rights. An environment or MCP binding
    // must be reconstituted from its original Graph credential reference; it is
    // never copied as plaintext into this receipt or substituted with latest.
    policy: {
      deferredCatalogTools: request.deferredCatalogTools ?? null, deferredBrowserTools: request.deferredBrowserTools ?? null, compactShellResults: request.compactShellResults ?? null,
      binding: request.binding, workspace: request.workspace, stateDir: request.stateDir,
      thinkingLevel: request.thinkingLevel ?? null, compaction: request.compaction ?? null,
      skillPaths: request.skillPaths ?? [], skillFolder: request.skillFolder ?? null, piExtensionPaths: request.piExtensionPaths ?? [], piExtensionTools: request.piExtensionTools ?? [],
      nativeTools: request.nativeTools ?? [], allowedToolNames: request.allowedToolNames ?? [],
      readOnly: request.readOnly ?? false, filesystemAccess: request.filesystemAccess ?? 'bounded',
      readRoots: request.readRoots ?? [], writeRoots: request.writeRoots ?? [], protectedPaths: request.protectedPaths ?? [],
      allowGitMetadataWritesAll: request.allowGitMetadataWritesAll ?? false, networkDomains: request.networkDomains ?? [],
      allowUnrestrictedNetwork: request.allowUnrestrictedNetwork ?? false, allowLocalBinding: request.allowLocalBinding ?? false,
      unixSockets: request.unixSockets ?? [], allowAllUnixSockets: request.allowAllUnixSockets ?? false, allowAppleEvents: request.allowAppleEvents ?? false,
      bundleDigest: request.bundleDigest, toolPolicyDigest: request.toolPolicyDigest, runtimePolicyDigest: request.runtimePolicyDigest,
      environmentKeys: Object.keys(request.env ?? {}).sort(), mcpServerNames: request.mcpAdapterServers?.map(server => server.name) ?? [],
    },
  };
}

/** Reconstruct captured bytes and the exact original package dependency edges.
 * Sources and the live capability catalog are never read by this operation. */
export async function restoreDurableResources(configuration: Awaited<ReturnType<typeof freezeDurableResources>>) {
  if (configuration.incomplete.length) throw new Error(`Frozen capability resource closure is incomplete: ${configuration.incomplete.join(', ')}`);
  const digest = createHash('sha256').update(JSON.stringify([configuration.resources, configuration.directories, configuration.aliases, configuration.packages])).digest('hex');
  const directory = join(configuration.policy.stateDir, 'durable-frozen-resources', 'trees', digest);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pathFor = (path: string) => {
    if (!isAbsolute(path)) throw new Error('Frozen resource path must be absolute');
    return join(directory, 'filesystem', path.slice(1));
  };
  for (const path of configuration.directories ?? []) await mkdir(pathFor(path), { recursive: true, mode: 0o700 });
  for (const resource of configuration.resources) {
    const bytes = await readFile(resource.archive);
    if (createHash('sha256').update(bytes).digest('hex') !== resource.digest) throw new Error('Frozen capability archive is corrupt');
    const destination = pathFor(resource.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try { await writeFile(destination, bytes, { flag: 'wx', mode: 0o400 }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (createHash('sha256').update(await readFile(destination)).digest('hex') !== resource.digest) throw new Error('Restored capability bytes are corrupt');
    }
  }
  const link = async (source: string, target: string) => {
    const destination = pathFor(source);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try { await symlink(relative(dirname(destination), pathFor(target)), destination); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (await realpath(destination) !== await realpath(pathFor(target))) throw new Error('Restored capability dependency changed');
    }
  };
  for (const alias of configuration.aliases ?? []) await link(alias.path, alias.target);
  for (const dependency of configuration.packages) for (const [name, target] of Object.entries(dependency.dependencies)) await link(join(dependency.root, 'node_modules', name), target);
  return { directory, pathFor };
}
