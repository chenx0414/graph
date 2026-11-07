import { api } from './api.ts';

export type ProviderCredentialNote = { needsRelogin?: boolean; credentialNote?: string };

export async function loadCredentialRelogin(): Promise<Record<string, string>> {
  const view = await api<{ credentials?: Record<string, ProviderCredentialNote> }>('/api/providers')
    .catch((): { credentials?: Record<string, ProviderCredentialNote> } => ({}));
  return Object.fromEntries(Object.entries(view.credentials ?? {})
    .filter(([, credential]) => credential.needsRelogin)
    .map(([id, credential]) => [id, credential.credentialNote ?? '需要重新登录']));
}
