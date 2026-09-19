import type { AccessPolicy } from '../core/access-policy.ts';

export const STANDARD_ACCESS: AccessPolicy = {
  mode: 'standard',
  autoApprove: { permission: false, systemChange: false },
  filesystem: { read: 'workspace-and-bound', write: 'workspace-and-bound', gitMetadata: 'protected', credentialStores: 'protected' },
  network: 'declared',
  commands: 'allowlisted',
  piExtensions: { runtime: 'declared', localBinding: false, unixSockets: 'declared', appleEvents: false },
};

export const FULL_ACCESS: AccessPolicy = {
  mode: 'full',
  autoApprove: { permission: true, systemChange: true },
  filesystem: { read: 'host', write: 'host', gitMetadata: 'protected', credentialStores: 'protected' },
  network: 'unrestricted',
  commands: 'host',
  piExtensions: { runtime: 'host', localBinding: true, unixSockets: 'all', appleEvents: false },
};
