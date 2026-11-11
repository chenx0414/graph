export interface SigningIdentity {
  identity: string;
  keychain: string;
}

export interface SigningOptions {
  identifier?: string | false;
  deep?: boolean;
}

export declare const signingIdentity: string;
export declare const codeIdentifier: string;
export declare function signingDirectory(): string;
export declare function keychainPath(): string;
export declare function identityPresent(): boolean;
export declare function ensureSigningIdentity(): SigningIdentity;
export declare function signCode(target: string, options?: SigningOptions): void;
export declare function designatedRequirement(target: string): string;
export declare function signatureIsStable(target: string): boolean;
export declare function installBundleSigning(bundle: string, binary: string): string;
