/** Browser-safe policy definitions shared by configuration and the console. */
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

