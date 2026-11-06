import type { AccessPolicy } from './access-policy-presets.ts';

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

/**
 * Only the wire types live here. Parsing, resolution, the protected paths and the
 * digest belong to the backend (`core_access_policy.go`): a second implementation
 * on this side could accept a document the backend reads differently, and nothing
 * in the console called these. The presets stay, because the console has to build
 * a document before it can save one - `tests/m8/settings-ui.test.ts` proves the
 * pair still agrees with what the backend reads back.
 */
