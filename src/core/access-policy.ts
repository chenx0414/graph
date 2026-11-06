import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import { RuntimeError } from './types.ts';

import { standardAccessPolicy, fullAccessPolicy, type AccessPolicy } from './access-policy-presets.ts';
export * from './access-policy-presets.ts';

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
