import { expect, test } from 'vitest';
import {
  defaultAccessPolicy,
  fullAccessPolicy,
  parseAccessPolicy,
  resolveAccessPolicy,
} from '../../src/core/access-policy.ts';
import { parseGraphConfig } from '../../src/server/config.ts';
import { createLiveConfig } from '../../src/server/live-config.ts';

test('standard access preserves every existing bounded runtime', () => {
  const policy = resolveAccessPolicy(undefined, { home: '/Users/example', stateDir: '/var/lib/graph', graphHome: '/Users/example/.graph' });

  expect(policy).toMatchObject({
    mode: 'standard',
    authorization: 'standard',
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
  });
  expect(policy.protectedPaths).toEqual(expect.arrayContaining([
    '/Users/example/.ssh',
    '/Users/example/.aws',
    '/Users/example/.git-credentials',
    '/Users/example/.graph',
    '/var/lib/graph',
  ]));
});

test('full access preset opens host capabilities but keeps high-risk stores protected', () => {
  const policy = fullAccessPolicy();

  expect(policy).toEqual({
    mode: 'full',
    autoApprove: { permission: true, systemChange: true },
    filesystem: {
      read: 'host',
      write: 'host',
      gitMetadata: 'protected',
      credentialStores: 'protected',
    },
    network: 'unrestricted',
    commands: 'host',
    piExtensions: {
      runtime: 'host',
      localBinding: true,
      unixSockets: 'all',
      appleEvents: false,
    },
  });
});

test('access parsing accepts the versioned policy and rejects malformed values', () => {
  const parsed = parseAccessPolicy(fullAccessPolicy(), 'access');
  expect(parsed).toEqual(fullAccessPolicy());
  expect(defaultAccessPolicy()).toMatchObject({ mode: 'standard' });

  expect(() => parseAccessPolicy({ mode: 'sometimes' }, 'access')).toThrowError(/access.mode/);
  expect(() => parseAccessPolicy({ mode: 'full', network: 'everything' }, 'access')).toThrowError(/access.network/);
  expect(() => parseAccessPolicy({ mode: 'full', filesystem: { read: 'all' } }, 'access')).toThrowError(/access.filesystem.read/);
});

test('full mode alone expands to the complete full-access preset', () => {
  expect(parseAccessPolicy({ mode: 'full' }, 'access')).toEqual(fullAccessPolicy());
});

test('resolved policy is stable and digest changes with effective permissions', () => {
  const standard = resolveAccessPolicy(defaultAccessPolicy(), { home: '/Users/example', stateDir: '/state', graphHome: '/graph' });
  const same = resolveAccessPolicy(defaultAccessPolicy(), { home: '/Users/example', stateDir: '/state', graphHome: '/graph' });
  const full = resolveAccessPolicy(fullAccessPolicy(), { home: '/Users/example', stateDir: '/state', graphHome: '/graph' });

  expect(standard.digest).toBe(same.digest);
  expect(full.digest).not.toBe(standard.digest);
});

test('graph configuration defaults to standard and preserves an explicit full policy', () => {
  const standard = parseGraphConfig({ version: 1, projects: [] }, '/tmp/graph.config.json');
  expect(standard.access).toEqual(defaultAccessPolicy());

  const full = parseGraphConfig({
    version: 1,
    projects: [],
    access: fullAccessPolicy(),
  }, '/tmp/graph.config.json');
  expect(full.access).toEqual(fullAccessPolicy());
});

test('live configuration exposes access changes to the next dispatch', () => {
  const standard = parseGraphConfig({ version: 1, projects: [] }, '/tmp/graph.config.json');
  const live = createLiveConfig({ env: {}, initial: { config: standard, revision: 0 } });
  expect(live.access()).toEqual(defaultAccessPolicy());

  const next = parseGraphConfig({
    version: 1,
    revision: 1,
    projects: [],
    access: fullAccessPolicy(),
  }, '/tmp/graph.config.json');
  expect(live.apply(next, 1)).toEqual({ applied: true });
  expect(live.access()).toEqual(fullAccessPolicy());
});
