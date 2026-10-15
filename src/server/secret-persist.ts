/**
 * Secrets the Agent wrote through the app bridge, waiting for durable storage.
 *
 * The daemon applies a pushed secret immediately, but it cannot store one: the
 * only durable store is the desktop app's keychain, whose codec the daemon does
 * not have. So the daemon keeps the request here and the desktop — which is
 * only ever a client of this daemon — asks for it on a short interval, saves it
 * with the same code `graph:save-secret` uses, and confirms it. That keeps one
 * transport (the desktop always calls in) and one writer per secret.
 */

export interface SecretPersistRequest {
  ref: string;
  /** `null` is an explicit revocation and must delete the stored entry. */
  value: string | null;
}

export interface SecretPersist {
  /** Record that this ref has a value the keychain does not hold yet. */
  mark(ref: string, value: string | null): void;
  /** The desktop stored (or deleted) the ref; nothing is pending for it. */
  confirmed(ref: string): void;
  list(): SecretPersistRequest[];
}

export function createSecretPersist(): SecretPersist {
  const pending = new Map<string, string | null>();
  return {
    mark(ref, value) { pending.set(ref, value); },
    confirmed(ref) { pending.delete(ref); },
    list: () => [...pending].map(([ref, value]) => ({ ref, value })),
  };
}
