import { readCapabilityManifest, type CapabilityManifest } from './file-capabilities.ts';
import type { CapabilityRecord } from './capability-library.ts';

export interface CapabilityConfigField {
  env: string;
  label: string;
  secret: boolean;
  reason: string;
}

export interface CapabilityConfigView {
  id: string;
  version: string;
  name: string;
  kind: CapabilityRecord['kind'];
  source: string;
  fields: CapabilityConfigField[];
  configured: string[];
  missing: string[];
  ready: boolean;
  error?: string;
}

function envRefs(value: unknown) {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map(match => match[1] ?? match[2]!)
    .filter(Boolean);
}

function fieldName(env: string) {
  return env.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function looksSecret(env: string, reason: string) {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)/i.test(env)
    || /authorization|api[-_ ]?key|token|password|secret/i.test(reason);
}

export async function capabilityConfigView(record: CapabilityRecord, values: Record<string, string>): Promise<CapabilityConfigView> {
  try {
    const snapshot = record.snapshot && typeof record.snapshot === 'object' && !Array.isArray(record.snapshot)
      ? record.snapshot as { manifest?: CapabilityManifest }
      : undefined;
    const manifest = snapshot?.manifest ?? await readCapabilityManifest(record.source);
    const fields = new Map<string, CapabilityConfigField>();
    const add = (env: string, reason: string) => {
      if (!env || fields.has(env)) return;
      fields.set(env, {
        env,
        label: fieldName(env),
        secret: looksSecret(env, reason),
        reason,
      });
    };
    for (const [header, env] of Object.entries(manifest.headersEnv ?? {})) add(env, `请求头 ${header}`);
    for (const [name, value] of Object.entries(manifest.env ?? {})) for (const env of envRefs(value)) add(env, `环境变量 ${name}`);
    for (const arg of manifest.args ?? []) for (const env of envRefs(arg)) add(env, '启动参数');
    for (const domain of manifest.networkDomains ?? []) for (const env of envRefs(domain)) add(env, '网络域名');
    for (const env of envRefs(manifest.url)) add(env, '远程地址');
    const configured = [...fields.keys()].filter(env => Boolean(values[env]?.trim()));
    const missing = [...fields.keys()].filter(env => !configured.includes(env));
    return {
      id: record.id,
      version: record.version,
      name: record.name ?? record.id,
      kind: record.kind,
      source: record.source,
      fields: [...fields.values()],
      configured,
      missing,
      ready: missing.length === 0,
    };
  } catch (error) {
    return {
      id: record.id,
      version: record.version,
      name: record.name ?? record.id,
      kind: record.kind,
      source: record.source,
      fields: [],
      configured: [],
      missing: [],
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function capabilityConfigViews(records: CapabilityRecord[], values: Record<string, string>) {
  const views = await Promise.all(records.map(record => capabilityConfigView(record, values)));
  return views.filter(view => view.fields.length > 0 || view.error);
}
