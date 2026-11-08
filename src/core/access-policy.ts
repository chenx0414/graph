
export interface AccessPolicy {
  mode: 'full';
  autoApprove: { permission: boolean; systemChange: boolean };
  filesystem: { read: 'host'; write: 'host'; gitMetadata: 'writable'; credentialStores: 'readable' };
  network: 'unrestricted';
  commands: 'host';
  piExtensions: { runtime: 'host'; localBinding: boolean; unixSockets: 'all'; appleEvents: boolean };
}

export interface ResolvedAccessPolicy extends AccessPolicy {
  authorization: 'bypass';
  digest: string;
  protectedPaths: string[];
}

export interface AccessPolicyContext {
  home: string;
  stateDir: string;
  graphHome: string;
}

