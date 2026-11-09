export interface DesktopBridge {
  isDesktop: boolean;
  setDrawer?(input: { open: boolean; width: number; route?: string }): Promise<{ detached?: boolean; expanded?: boolean }>;
  pickDirectory(): Promise<string | null>;
  openResource(kind: 'skills' | 'mcp' | 'pi-extensions' | 'agent-md' | 'prompts'): Promise<{ opened: boolean; path?: string; message?: string }>;
  saveSecret(ref: string, value: string | null): Promise<{ stored: boolean; applied?: boolean; message?: string }>;
  secretStatus(refs: string[]): Promise<Record<string, boolean>>;
  relaunch(): Promise<{ url: string }>;
}

declare global {
  interface Window {
    graph?: DesktopBridge;
  }
}

export interface TemplateSetupModel { id: string; contextWindow: number; maxTokens: number }
export interface TemplateSetupInput {
  providerId: string;
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  baseUrl: string;
  credentialId: string;
  secretRef: string;
  models: TemplateSetupModel[];
}

function uniqueModelId(entries: Record<string, unknown>[], base: string, providerId: string) {
  const taken = new Set(entries.map(item => String(item?.id ?? '')));
  const stem = `${base}-${providerId}`;
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function buildTemplateConfigDocument(existing: unknown, input: TemplateSetupInput, templateModels: TemplateSetupModel[] = []): Record<string, unknown> {
  const base = existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {};
  const document: Record<string, unknown> = { ...base, version: 1 };
  const models = (base.models && typeof base.models === 'object' ? base.models : {}) as Record<string, unknown>;
  const entries = Array.isArray(models.entries) ? [...models.entries as Record<string, unknown>[]] : [];
  for (const model of input.models) {
    const preset = templateModels.find(item => item.id === model.id);
    const merged = preset ? { ...preset, ...model } : model;
    const index = entries.findIndex(item => (item as { id?: unknown }).id === merged.id);
    const existing = index >= 0 ? entries[index] as Record<string, unknown> : undefined;
    const sameConnection = existing
      && existing.provider === input.providerId
      && existing.baseUrl === input.baseUrl
      && existing.credentialId === input.credentialId;
    const id = existing && !sameConnection ? uniqueModelId(entries, merged.id, input.providerId) : merged.id;
    const entry = {
      id,
      modelId: merged.id,
      provider: input.providerId,
      api: input.api,
      baseUrl: input.baseUrl,
      contextWindow: merged.contextWindow,
      maxTokens: merged.maxTokens,
      credentialId: input.credentialId,
    };
    if (existing && !sameConnection) entries.push(entry);
    else if (index >= 0) entries[index] = entry;
    else entries.push(entry);
  }
  document.models = { ...models, entries };
  const credentials = (base.credentials && typeof base.credentials === 'object' ? base.credentials : {}) as Record<string, unknown>;
  const previous = (credentials[input.credentialId] && typeof credentials[input.credentialId] === 'object' ? credentials[input.credentialId] : {}) as Record<string, unknown>;
  document.credentials = { ...credentials, [input.credentialId]: { ...previous, secretRef: input.secretRef } };
  return document;
}
