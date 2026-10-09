import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { canonicalJson } from './store.ts';
import { RuntimeError } from './types.ts';

export type AccessMode = 'standard' | 'full';
export type AccessRead = 'workspace-and-bound' | 'host';
export type AccessWrite = 'workspace-and-bound' | 'host';
export type AccessNetwork = 'declared' | 'unrestricted';
export type AccessCommands = 'allowlisted' | 'host';
export type ExtensionRuntime = 'declared' | 'host';
export type UnixSocketAccess = 'declared' | 'all';
export type ProtectedStoreAccess = 'protected' | 'readable';
export type GitMetadataAccess = 'protected' | 'writable';

export interface AccessPolicy {
  mode: AccessMode;
  autoApprove: {
    permission: boolean;
    systemChange: boolean;
  };
  filesystem: {
    read: AccessRead;
    write: AccessWrite;
    gitMetadata: GitMetadataAccess;
    credentialStores: ProtectedStoreAccess;
  };
  network: AccessNetwork;
  commands: AccessCommands;
  piExtensions: {
    runtime: ExtensionRuntime;
    localBinding: boolean;
    unixSockets: UnixSocketAccess;
    appleEvents: boolean;
  };
}

export interface ResolvedAccessPolicy extends AccessPolicy {
  authorization: 'standard' | 'bypass';
  digest: string;
  protectedPaths: string[];
}

export interface AccessPolicyContext {
  home: string;
  stateDir: string;
  graphHome: string;
}

export function standardAccessPolicy(): AccessPolicy {
  return {
    mode: 'standard',
    autoApprove: { permission: false, systemChange: false },
    filesystem: {
      read: 'workspace-and-bound',
      write: 'workspace-and-bound',
      gitMetadata: 'protected',
      credentialStores: 'protected',
    },
    network: 'declared',
    commands: 'allowlisted',
    piExtensions: {
      runtime: 'declared',
      localBinding: false,
      unixSockets: 'declared',
      appleEvents: false,
    },
  };
}

export function fullAccessPolicy(): AccessPolicy {
  return {
    mode: 'full',
    autoApprove: { permission: true, systemChange: true },
    filesystem: {
      read: 'host',
      write: 'host',
      gitMetadata: 'writable',
      credentialStores: 'readable',
    },
    network: 'unrestricted',
    commands: 'host',
    piExtensions: {
      runtime: 'host',
      localBinding: true,
      unixSockets: 'all',
      appleEvents: true,
    },
  };
}

export function defaultAccessPolicy(): AccessPolicy {
  return fullAccessPolicy();
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError('invalid_config', `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new RuntimeError('invalid_config', `${path} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function booleanValue(value: unknown, path: string) {
  if (typeof value !== 'boolean') throw new RuntimeError('invalid_config', `${path} must be a boolean`);
  return value;
}

/** Parse one optional access document. Missing fields inherit full access. */
export function parseAccessPolicy(value: unknown, path = 'access'): AccessPolicy {
  if (value === undefined) return defaultAccessPolicy();
  const raw = object(value, path);
  const mode = raw.mode === undefined
    ? 'full'
    : enumValue(raw.mode, ['standard', 'full'] as const, `${path}.mode`);
  const defaults = mode === 'full' ? fullAccessPolicy() : standardAccessPolicy();
  const auto = raw.autoApprove === undefined ? defaults.autoApprove : object(raw.autoApprove, `${path}.autoApprove`);
  const filesystem = raw.filesystem === undefined ? defaults.filesystem : object(raw.filesystem, `${path}.filesystem`);
  const extensions = raw.piExtensions === undefined ? defaults.piExtensions : object(raw.piExtensions, `${path}.piExtensions`);
  return {
    mode,
    autoApprove: {
      permission: auto.permission === undefined
        ? defaults.autoApprove.permission
        : booleanValue(auto.permission, `${path}.autoApprove.permission`),
      systemChange: auto.systemChange === undefined
        ? defaults.autoApprove.systemChange
        : booleanValue(auto.systemChange, `${path}.autoApprove.systemChange`),
    },
    filesystem: {
      read: filesystem.read === undefined
        ? defaults.filesystem.read
        : enumValue(filesystem.read, ['workspace-and-bound', 'host'] as const, `${path}.filesystem.read`),
      write: filesystem.write === undefined
        ? defaults.filesystem.write
        : enumValue(filesystem.write, ['workspace-and-bound', 'host'] as const, `${path}.filesystem.write`),
      gitMetadata: filesystem.gitMetadata === undefined
        ? defaults.filesystem.gitMetadata
        : enumValue(filesystem.gitMetadata, ['protected', 'writable'] as const, `${path}.filesystem.gitMetadata`),
      credentialStores: filesystem.credentialStores === undefined
        ? defaults.filesystem.credentialStores
        : enumValue(filesystem.credentialStores, ['protected', 'readable'] as const, `${path}.filesystem.credentialStores`),
    },
    network: raw.network === undefined
      ? defaults.network
      : enumValue(raw.network, ['declared', 'unrestricted'] as const, `${path}.network`),
    commands: raw.commands === undefined
      ? defaults.commands
      : enumValue(raw.commands, ['allowlisted', 'host'] as const, `${path}.commands`),
    piExtensions: {
      runtime: extensions.runtime === undefined
        ? defaults.piExtensions.runtime
        : enumValue(extensions.runtime, ['declared', 'host'] as const, `${path}.piExtensions.runtime`),
      localBinding: extensions.localBinding === undefined
        ? defaults.piExtensions.localBinding
        : booleanValue(extensions.localBinding, `${path}.piExtensions.localBinding`),
      unixSockets: extensions.unixSockets === undefined
        ? defaults.piExtensions.unixSockets
        : enumValue(extensions.unixSockets, ['declared', 'all'] as const, `${path}.piExtensions.unixSockets`),
      appleEvents: extensions.appleEvents === undefined
        ? defaults.piExtensions.appleEvents
        : booleanValue(extensions.appleEvents, `${path}.piExtensions.appleEvents`),
    },
  };
}

export function credentialProtectPaths(home: string): string[] {
  return [
    '.ssh',
    '.aws',
    '.azure',
    '.config/gh',
    '.config/gcloud',
    '.docker/config.json',
    '.git-credentials',
    '.netrc',
    '.npmrc',
    '.pypirc',
  ].map(path => resolve(home, path));
}

export function resolveAccessPolicy(
  value: AccessPolicy | undefined,
  context: Partial<AccessPolicyContext> = {},
): ResolvedAccessPolicy {
  const policy = value ?? defaultAccessPolicy();
  const home = context.home ?? homedir();
  const protectedPaths = policy.mode === 'full'
    ? []
    : [
        ...(policy.filesystem.credentialStores === 'protected' ? credentialProtectPaths(home) : []),
        context.graphHome ?? resolve(home, '.graph'),
        context.stateDir ?? resolve(home, '.local', 'state', 'graph'),
      ];
  const resolved: Omit<ResolvedAccessPolicy, 'digest'> = {
    ...structuredClone(policy),
    authorization: policy.autoApprove.permission ? 'bypass' : 'standard',
    protectedPaths: [...new Set(protectedPaths.map(path => resolve(path)))].sort(),
  };
  return {
    ...resolved,
    digest: createHash('sha256').update(canonicalJson(resolved)).digest('hex'),
  };
}

export function isHostRead(policy: ResolvedAccessPolicy | undefined) {
  return policy?.filesystem.read === 'host';
}

export function isHostWrite(policy: ResolvedAccessPolicy | undefined) {
  return policy?.filesystem.write === 'host';
}

export function isFullAccess(policy: ResolvedAccessPolicy | undefined) {
  return policy?.mode === 'full';
}

/** A node may select its own policy only within the already authorized host policy. */
export function nodeAccessPolicy(value: unknown, ceiling: ResolvedAccessPolicy, context: Partial<AccessPolicyContext> = {}): ResolvedAccessPolicy {
  if (value === undefined) return ceiling;
  const requested = parseAccessPolicy(value, 'node.access');
  const wider = (candidate: unknown, allowed: unknown, path: string) => {
    if (candidate && typeof candidate === 'object') {
      for (const [key, field] of Object.entries(candidate)) wider(field, (allowed as Record<string, unknown>)[key], `${path}.${key}`);
    } else if (candidate !== allowed && (candidate === true || ['full', 'host', 'unrestricted', 'writable', 'readable', 'all'].includes(String(candidate)))) {
      throw new RuntimeError('permission', `${path} exceeds the host authorization (${String(allowed)})`);
    }
  };
  wider(requested, ceiling, 'node.access');
  const resolved = resolveAccessPolicy(requested, context);
  const protectedPaths = [...new Set([...resolved.protectedPaths, ...ceiling.protectedPaths])].sort();
  const effective = { ...resolved, protectedPaths };
  return { ...effective, digest: createHash('sha256').update(canonicalJson({ ...requested, authorization: effective.authorization, protectedPaths })).digest('hex') };
}
