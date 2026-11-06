import { api } from './api.ts';

/** The credential facts the daemon knows and the config document cannot carry.
 *
 * A credential the vendor refused to renew stays configured, so the config document
 * says "ready" while every request fails. The provider view knows better, and this is
 * the one read that turns it into a line the settings page can show. */
export type ProviderCredentialNote = { needsRelogin?: boolean; credentialNote?: string };

/** Relogin notes keyed by credential id: empty when every credential is usable. */
export async function loadCredentialRelogin(): Promise<Record<string, string>> {
  const view = await api<{ credentials?: Record<string, ProviderCredentialNote> }>('/api/providers')
    .catch((): { credentials?: Record<string, ProviderCredentialNote> } => ({}));
  return Object.fromEntries(Object.entries(view.credentials ?? {})
    .filter(([, credential]) => credential.needsRelogin)
    .map(([id, credential]) => [id, credential.credentialNote ?? '需要重新登录']));
}
