import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { RuntimeError } from '../core/types.ts';
import type { ModelApi, ModelCost, ModelEntry, ModelGrade, ModelPricing } from '../catalog/models.ts';

/** Versioned on-disk configuration. Secrets are never stored here; a credential
 * keeps a `secretRef` naming the environment variable that holds the key. */
export interface CredentialConfig {
  displayName?: string;
  secretRef: string;
  sharedLimitGroupId?: string;
}

export interface LimitsConfig {
  credentials: Record<string, number>;
  sharedGroups: Record<string, number>;
  /** Default cumulative token cap for new instances; null means unlimited. */
  defaultBudgetTokens: number | null;
}

export interface ConfiguredModel extends ModelEntry {
  credentialId: string;
}

export interface GraphConfig {
  path: string | null;
  configured: boolean;
  projects: { id: string; root: string; grants?: string[] }[];
  models: { entries: ConfiguredModel[]; preferences: Partial<Record<ModelGrade, string[]>> } | null;
  credentials: Record<string, CredentialConfig>;
  limits: LimitsConfig;
}

const GRADES: ModelGrade[] = ['low', 'medium', 'high', 'highest'];
const SECRET_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function emptyGraphConfig(): GraphConfig {
  return { path: null, configured: false, projects: [], models: null, credentials: {}, limits: { credentials: {}, sharedGroups: {}, defaultBudgetTokens: null } };
}

export function defaultConfigPath(cwd: string) {
  return join(cwd, 'graph.config.json');
}

export function defaultStateDir(env: Record<string, string | undefined>) {
  const home = env.HOME?.trim() || homedir();
  const base = env.XDG_STATE_HOME?.trim() || join(home, '.local', 'state');
  return join(base, 'graph');
}

function invalid(message: string): never {
  const error = new RuntimeError('invalid_config', message) as RuntimeError & { field?: string };
  // The leading path token (for example models.entries[0].grade) lets the
  // settings page point at the offending field.
  error.field = /^[A-Za-z0-9_$.[\]-]+/.exec(message)?.[0] ?? message;
  throw error;
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${path} must be a nonempty string`);
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, path);
}

function positiveInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) invalid(`${path} must be a positive integer`);
  return value;
}

function asCost(value: unknown, path: string): ModelCost {
  const raw = asObject(value, path);
  const field = (name: keyof ModelCost) => {
    const current = raw[name];
    if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) invalid(`${path}.${name} must be a nonnegative number`);
    return current;
  };
  return { input: field('input'), output: field('output'), cacheRead: field('cacheRead'), cacheWrite: field('cacheWrite') };
}

function asPricing(value: unknown, path: string): ModelPricing {
  const raw = asObject(value, path);
  const status = raw.status === undefined ? 'known' : asString(raw.status, `${path}.status`);
  if (!['known', 'stale', 'unknown'].includes(status)) invalid(`${path}.status must be known, stale or unknown`);
  if (raw.unit !== 'per_million_tokens') invalid(`${path}.unit must be "per_million_tokens"`);
  return {
    currency: asString(raw.currency, `${path}.currency`),
    unit: 'per_million_tokens',
    ...(optionalString(raw.sourceUrl, `${path}.sourceUrl`) ? { sourceUrl: asString(raw.sourceUrl, `${path}.sourceUrl`) } : {}),
    ...(optionalString(raw.retrievedAt, `${path}.retrievedAt`) ? { retrievedAt: asString(raw.retrievedAt, `${path}.retrievedAt`) } : {}),
    ...(optionalString(raw.catalogRevision, `${path}.catalogRevision`) ? { catalogRevision: asString(raw.catalogRevision, `${path}.catalogRevision`) } : {}),
    status: status as ModelPricing['status'],
  };
}

function asHeaders(value: unknown, path: string): Record<string, string> {
  const entries = Object.entries(asObject(value, path));
  if (entries.length > 20) invalid(`${path} must declare at most 20 headers`);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) invalid(`${path}.${name} is not a valid header name`);
    if (typeof headerValue !== 'string' || headerValue.length === 0 || headerValue.length > 512) {
      invalid(`${path}.${name} must be a non-empty string of at most 512 characters`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

function parseModel(raw: unknown, path: string, credentials: Record<string, CredentialConfig>): ConfiguredModel {
  const entry = asObject(raw, path);
  const grade = asString(entry.grade, `${path}.grade`);
  if (!GRADES.includes(grade as ModelGrade)) invalid(`${path}.grade must be one of ${GRADES.join(', ')}`);
  if (entry.api !== 'openai-completions' && entry.api !== 'anthropic-messages') invalid(`${path}.api must be "openai-completions" or "anthropic-messages"`);
  const credentialId = asString(entry.credentialId, `${path}.credentialId`);
  if (!credentials[credentialId]) invalid(`${path}.credentialId references unknown credential "${credentialId}"`);
  return {
    id: asString(entry.id, `${path}.id`),
    provider: asString(entry.provider, `${path}.provider`),
    grade: grade as ModelGrade,
    api: entry.api as ModelApi,
    baseUrl: asString(entry.baseUrl, `${path}.baseUrl`),
    contextWindow: positiveInt(entry.contextWindow, `${path}.contextWindow`),
    maxTokens: positiveInt(entry.maxTokens, `${path}.maxTokens`),
    credentialId,
    ...(entry.cost !== undefined ? { cost: asCost(entry.cost, `${path}.cost`) } : {}),
    ...(entry.pricing !== undefined ? { pricing: asPricing(entry.pricing, `${path}.pricing`) } : {}),
    ...(entry.headers !== undefined ? { headers: asHeaders(entry.headers, `${path}.headers`) } : {}),
  };
}

/** Parse a version 1 config document. Relative project roots resolve against
 * the config file directory so the same file means the same projects from any cwd. */
export function parseGraphConfig(raw: unknown, configPath: string): GraphConfig {
  const root = asObject(raw, configPath);
  if (root.version !== 1) invalid(`${configPath}: version must be 1`);
  const dir = dirname(configPath);

  const credentials: Record<string, CredentialConfig> = {};
  if (root.credentials !== undefined) {
    for (const [id, value] of Object.entries(asObject(root.credentials, 'credentials'))) {
      const path = `credentials.${id}`;
      const entry = asObject(value, path);
      const secretRef = asString(entry.secretRef, `${path}.secretRef`);
      if (!SECRET_REF.test(secretRef)) invalid(`${path}.secretRef must be an environment variable name`);
      credentials[id] = {
        secretRef,
        ...(entry.displayName !== undefined ? { displayName: asString(entry.displayName, `${path}.displayName`) } : {}),
        ...(entry.sharedLimitGroupId !== undefined ? { sharedLimitGroupId: asString(entry.sharedLimitGroupId, `${path}.sharedLimitGroupId`) } : {}),
      };
    }
  }

  const limits: LimitsConfig = { credentials: {}, sharedGroups: {}, defaultBudgetTokens: null };
  if (root.limits !== undefined) {
    const rawLimits = asObject(root.limits, 'limits');
    for (const [id, value] of Object.entries(rawLimits.credentials !== undefined ? asObject(rawLimits.credentials, 'limits.credentials') : {})) {
      if (!credentials[id]) invalid(`limits.credentials.${id} references unknown credential "${id}"`);
      limits.credentials[id] = positiveInt(value, `limits.credentials.${id}`);
    }
    for (const [id, value] of Object.entries(rawLimits.sharedGroups !== undefined ? asObject(rawLimits.sharedGroups, 'limits.sharedGroups') : {})) {
      limits.sharedGroups[id] = positiveInt(value, `limits.sharedGroups.${id}`);
    }
    if (rawLimits.defaultBudgetTokens !== undefined && rawLimits.defaultBudgetTokens !== null) {
      limits.defaultBudgetTokens = positiveInt(rawLimits.defaultBudgetTokens, 'limits.defaultBudgetTokens');
    }
  }

  const projects: GraphConfig['projects'] = [];
  if (root.projects !== undefined) {
    const seen = new Set<string>();
    for (const [index, value] of asArray(root.projects, 'projects').entries()) {
      const path = `projects[${index}]`;
      const entry = asObject(value, path);
      const id = asString(entry.id, `${path}.id`);
      if (seen.has(id)) invalid(`duplicate project id "${id}"`);
      seen.add(id);
      const rawRoot = asString(entry.root, `${path}.root`);
      const grants = entry.grants === undefined ? undefined : asArray(entry.grants, `${path}.grants`).map((grant, position) => asString(grant, `${path}.grants[${position}]`));
      projects.push({ id, root: isAbsolute(rawRoot) ? resolve(rawRoot) : resolve(dir, rawRoot), ...(grants ? { grants } : {}) });
    }
  }

  let models: GraphConfig['models'] = null;
  if (root.models !== undefined) {
    const rawModels = asObject(root.models, 'models');
    const seen = new Set<string>();
    const entries = asArray(rawModels.entries, 'models.entries').map((value, index) => {
      const parsed = parseModel(value, `models.entries[${index}]`, credentials);
      if (seen.has(parsed.id)) invalid(`duplicate model id "${parsed.id}"`);
      seen.add(parsed.id);
      return parsed;
    });
    if (!entries.length) invalid('models.entries must not be empty');
    // One provider label is one registered transport, so every model under it
    // must agree on endpoint and credential; use distinct labels otherwise.
    const byProvider = new Map<string, { credentialId: string; baseUrl: string }>();
    entries.forEach((entry, index) => {
      const existing = byProvider.get(entry.provider);
      if (!existing) { byProvider.set(entry.provider, { credentialId: entry.credentialId, baseUrl: entry.baseUrl }); return; }
      if (existing.credentialId !== entry.credentialId) invalid(`models.entries[${index}].credentialId: provider "${entry.provider}" must use one credentialId across its models`);
      if (existing.baseUrl !== entry.baseUrl) invalid(`models.entries[${index}].baseUrl: provider "${entry.provider}" must use one baseUrl across its models`);
    });
    const preferences: Partial<Record<ModelGrade, string[]>> = {};
    if (rawModels.preferences !== undefined) {
      for (const [grade, ids] of Object.entries(asObject(rawModels.preferences, 'models.preferences'))) {
        if (!GRADES.includes(grade as ModelGrade)) invalid(`models.preferences.${grade} is not a model grade`);
        preferences[grade as ModelGrade] = asArray(ids, `models.preferences.${grade}`).map((id, index) => {
          const value = asString(id, `models.preferences.${grade}[${index}]`);
          if (!seen.has(value)) invalid(`models.preferences.${grade} references unknown model "${value}"`);
          return value;
        });
      }
    }
    models = { entries, preferences };
  }

  return { path: configPath, configured: true, projects, models, credentials, limits };
}

export async function loadGraphConfig(configPath: string): Promise<GraphConfig> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') invalid(`Config file not found: ${configPath}`);
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    invalid(`${configPath} is not valid JSON: ${(error as Error).message}`);
  }
  return parseGraphConfig(raw, configPath);
}

/** Aliases that resolve to one actual key must not declare conflicting shared
 * groups; used by both config saving and daemon startup. */
export function assertCredentialGroups(config: GraphConfig, env: Record<string, string | undefined>) {
  const byValue = new Map<string, string[]>();
  for (const id of Object.keys(config.credentials)) {
    const secret = resolveCredentialSecret(config, id, env);
    if (!secret.configured || !secret.value) continue;
    byValue.set(secret.value, [...(byValue.get(secret.value) ?? []), id]);
  }
  for (const aliases of byValue.values()) {
    if (aliases.length < 2) continue;
    const sorted = [...aliases].sort();
    const groups = [...new Set(sorted.map(id => config.credentials[id]?.sharedLimitGroupId).filter((value): value is string => Boolean(value)))];
    if (groups.length > 1) invalid(`credentials.${sorted[0]}.sharedLimitGroupId: aliases resolving to one key must share one sharedLimitGroupId (${sorted.join(', ')})`);
  }
}

/** Resolve the environment variable named by a credential, if the credential exists. */
export function resolveCredentialSecret(config: GraphConfig, credentialId: string, env: Record<string, string | undefined>): { configured: boolean; secretRef: string | null; value?: string } {
  const credential = config.credentials[credentialId];
  if (!credential) return { configured: false, secretRef: null };
  const value = env[credential.secretRef]?.trim();
  return { configured: Boolean(value), secretRef: credential.secretRef, ...(value ? { value } : {}) };
}
