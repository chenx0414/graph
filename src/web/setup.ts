import type { ModelGrade } from '../catalog/models.ts';
/** First-run wizard logic; the component in Setup.tsx stays presentational. */

export type SetupTemplate = 'local' | 'custom';

export interface SetupForm {
  projectId: string;
  projectRoot: string;
  template: SetupTemplate;
  modelId: string;
  provider: string;
  baseUrl: string;
  grade: ModelGrade;
  contextWindow: number;
  maxTokens: number;
  credentialId: string;
  secretRef: string;
}

export interface DesktopBridge {
  isDesktop: boolean;
  setDrawer?(input: { open: boolean; width: number }): Promise<{ expanded: boolean }>;
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

export const SETUP_TEMPLATES: Record<SetupTemplate, Omit<SetupForm, 'projectId' | 'projectRoot' | 'template' | 'credentialId' | 'secretRef'>> = {
  local: {
    modelId: 'local-model', provider: 'local', grade: 'medium',
    baseUrl: 'http://127.0.0.1:8080/v1', contextWindow: 32_768, maxTokens: 4_096,
  },
  custom: {
    modelId: 'remote-model', provider: 'openai', grade: 'high',
    baseUrl: 'https://api.openai.com/v1', contextWindow: 128_000, maxTokens: 8_192,
  },
};

/** `local` -> GRAPH_LOCAL_KEY; the daemon only ever sees this name. */
export function defaultSecretRef(credentialId: string): string {
  const token = credentialId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'MODEL';
  return `GRAPH_${token}_KEY`;
}

export function defaultSetupForm(): SetupForm {
  return {
    projectId: 'demo', projectRoot: '', template: 'local',
    credentialId: 'local', secretRef: defaultSecretRef('local'),
    ...SETUP_TEMPLATES.local,
  };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const SECRET_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Field-keyed messages for the wizard; the API remains the authority. */
export function validateSetup(form: SetupForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!ID_PATTERN.test(form.projectId)) errors.projectId = '项目 id 需以小写字母或数字开头，仅含小写字母、数字、- 和 _';
  if (!form.projectRoot.trim()) errors.projectRoot = '需要项目路径';
  if (!form.modelId.trim()) errors.modelId = '需要模型 id';
  if (!form.provider.trim()) errors.provider = '需要 provider 标签';
  try {
    const url = new URL(form.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) errors.baseUrl = '端点需为 http(s) URL';
  } catch {
    errors.baseUrl = '端点需为 http(s) URL';
  }
  if (!Number.isInteger(form.contextWindow) || form.contextWindow < 1_024) errors.contextWindow = '上下文窗口需为不小于 1024 的整数';
  if (!Number.isInteger(form.maxTokens) || form.maxTokens < 1 || form.maxTokens >= form.contextWindow) {
    errors.maxTokens = '最大输出需为正整数且小于上下文窗口';
  }
  if (!ID_PATTERN.test(form.credentialId)) errors.credentialId = '凭据 id 规则同项目 id';
  if (!SECRET_PATTERN.test(form.secretRef)) errors.secretRef = '凭据引用需为合法环境变量名';
  return errors;
}

function upsertById(list: unknown, id: string, value: Record<string, unknown>): Record<string, unknown>[] {
  const entries = Array.isArray(list) ? list.filter(entry => (entry as { id?: unknown } | null)?.id !== id) : [];
  return [...entries as Record<string, unknown>[], value];
}

/** Merge the wizard form into an existing config document without dropping
 * unrelated projects, models or credentials. */
export function buildConfigDocument(existing: unknown, form: SetupForm): Record<string, unknown> {
  const base = existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {};
  const document: Record<string, unknown> = { ...base, version: 1 };
  document.projects = upsertById(base.projects, form.projectId, { id: form.projectId, root: form.projectRoot.trim() });
  const models = (base.models && typeof base.models === 'object' ? base.models : {}) as Record<string, unknown>;
  const entry: Record<string, unknown> = {
    id: form.modelId.trim(), modelId: form.modelId.trim(), provider: form.provider.trim(), grade: form.grade,
    api: 'openai-completions', baseUrl: form.baseUrl.trim(),
    contextWindow: form.contextWindow, maxTokens: form.maxTokens,
    credentialId: form.credentialId,
  };
  document.models = { ...models, entries: upsertById(models.entries, form.modelId.trim(), entry) };
  const credentials = (base.credentials && typeof base.credentials === 'object' ? base.credentials : {}) as Record<string, unknown>;
  const existingCredential = (credentials[form.credentialId] && typeof credentials[form.credentialId] === 'object' ? credentials[form.credentialId] : {}) as Record<string, unknown>;
  document.credentials = { ...credentials, [form.credentialId]: { ...existingCredential, secretRef: form.secretRef } };
  return document;
}

export interface TemplateSetupModel { id: string; grade: ModelGrade; contextWindow: number; maxTokens: number }
export interface TemplateSetupInput {
  providerId: string;
  api: 'openai-completions' | 'anthropic-messages';
  baseUrl: string;
  credentialId: string;
  secretRef: string;
  /** Template-provided model ids and/or explicitly typed custom models. */
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

/** One-action provider connection: merge the chosen transport, credential and
 * models into the current document without dropping other platforms. */
export function buildTemplateConfigDocument(existing: unknown, input: TemplateSetupInput, templateModels: TemplateSetupModel[] = []): Record<string, unknown> {
  const base = existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {};
  const document: Record<string, unknown> = { ...base, version: 1 };
  const models = (base.models && typeof base.models === 'object' ? base.models : {}) as Record<string, unknown>;
  const entries = Array.isArray(models.entries) ? [...models.entries as Record<string, unknown>[]] : [];
  for (const model of input.models) {
    const preset = templateModels.find(item => item.id === model.id);
    const merged = preset ? { ...preset, ...model } : model;
    // The upstream model id is the provider identity; the config id is the
    // connection identity. A second platform exposing the same upstream id
    // must get its own entry instead of overwriting the first connection.
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
      grade: merged.grade,
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

/** Map an API field path (for example credentials.local.secretRef) onto the form. */
export function setupFieldFor(field: string | undefined): keyof SetupForm | undefined {
  if (!field) return undefined;
  if (field.startsWith('projects')) return field.endsWith('.root') ? 'projectRoot' : 'projectId';
  if (field.startsWith('models')) {
    if (field.includes('.baseUrl')) return 'baseUrl';
    if (field.includes('.contextWindow')) return 'contextWindow';
    if (field.includes('.maxTokens')) return 'maxTokens';
    if (field.includes('.provider')) return 'provider';
    return 'modelId';
  }
  if (field.startsWith('credentials')) return field.endsWith('.secretRef') ? 'secretRef' : 'credentialId';
  return undefined;
}
