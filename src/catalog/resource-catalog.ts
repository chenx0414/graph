import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeError, type Json } from '../core/types.ts';

export type RecommendedResourceKind = 'skill' | 'mcp' | 'pi-extension' | 'agent-md';
export type ResourceCommercialUse = 'allowed' | 'restricted' | 'mixed' | 'unknown';
export type ResourceCompatibility = 'verified' | 'unverified' | 'incompatible';
export type ResourceTransport = 'stdio' | 'streamable-http' | 'sse' | 'none';
export type ResourceRisk = 'credentials' | 'network' | 'external-write' | 'code-execution' | 'local-runtime';

export interface RecommendedResource {
  id: string;
  kind: RecommendedResourceKind;
  name: string;
  description: string;
  source: string;
  sourceKind: 'github' | 'npm' | 'pi-package' | 'website' | 'local-reference';
  license?: string;
  sourcePath?: string;
  archived?: boolean;
  commercialUse?: ResourceCommercialUse;
  compatibility?: ResourceCompatibility;
  transport?: ResourceTransport;
  risk?: ResourceRisk[];
  tags?: string[];
  requirements?: string[];
  importHint?: string;
}

interface ResourceCatalogDocument {
  version: number;
  updatedAt?: string;
  entries: RecommendedResource[];
}

const KINDS = new Set<RecommendedResourceKind>(['skill', 'mcp', 'pi-extension', 'agent-md']);
const SOURCE_KINDS = new Set<RecommendedResource['sourceKind']>(['github', 'npm', 'pi-package', 'website', 'local-reference']);
const COMMERCIAL_USE = new Set<ResourceCommercialUse>(['allowed', 'restricted', 'mixed', 'unknown']);
const COMPATIBILITY = new Set<ResourceCompatibility>(['verified', 'unverified', 'incompatible']);
const TRANSPORTS = new Set<ResourceTransport>(['stdio', 'streamable-http', 'sse', 'none']);
const RISKS = new Set<ResourceRisk>(['credentials', 'network', 'external-write', 'code-execution', 'local-runtime']);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function text(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new RuntimeError('invalid_resource_catalog', `${label} must be a nonempty string`);
  return value.trim();
}

function textList(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new RuntimeError('invalid_resource_catalog', `${label} must be an array of nonempty strings`);
  }
  return value.map(item => item.trim());
}

function optionalEnum<T extends string>(value: unknown, allowed: Set<T>, label: string) {
  if (value === undefined) return undefined;
  const parsed = text(value, label) as T;
  if (!allowed.has(parsed)) throw new RuntimeError('invalid_resource_catalog', `${label} has unsupported value ${parsed}`);
  return parsed;
}

function enumList<T extends string>(value: unknown, allowed: Set<T>, label: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !allowed.has(item as T))) {
    throw new RuntimeError('invalid_resource_catalog', `${label} contains an unsupported value`);
  }
  return [...new Set(value as T[])];
}

export function parseResourceCatalog(value: unknown): ResourceCatalogDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError('invalid_resource_catalog', 'Resource catalog must be an object');
  }
  const document = value as { version?: unknown; updatedAt?: unknown; entries?: unknown };
  if (!Number.isInteger(document.version) || Number(document.version) < 1) {
    throw new RuntimeError('invalid_resource_catalog', 'Resource catalog version must be a positive integer');
  }
  if (!Array.isArray(document.entries)) throw new RuntimeError('invalid_resource_catalog', 'Resource catalog entries must be an array');
  const ids = new Set<string>();
  const entries = document.entries.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RuntimeError('invalid_resource_catalog', `Resource catalog entry ${index} must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const id = text(entry.id, `entries[${index}].id`);
    if (!ID_PATTERN.test(id)) throw new RuntimeError('invalid_resource_catalog', `Resource id ${id} must use lowercase letters, numbers and hyphens`);
    if (ids.has(id)) throw new RuntimeError('invalid_resource_catalog', `Duplicate resource id ${id}`);
    ids.add(id);
    const kind = text(entry.kind, `entries[${index}].kind`) as RecommendedResourceKind;
    if (!KINDS.has(kind)) throw new RuntimeError('invalid_resource_catalog', `Resource ${id} has unsupported kind ${kind}`);
    const sourceKind = text(entry.sourceKind, `entries[${index}].sourceKind`) as RecommendedResource['sourceKind'];
    if (!SOURCE_KINDS.has(sourceKind)) throw new RuntimeError('invalid_resource_catalog', `Resource ${id} has unsupported sourceKind ${sourceKind}`);
    const source = text(entry.source, `entries[${index}].source`);
    if (sourceKind !== 'local-reference') {
      try {
        const url = new URL(source);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported protocol');
      } catch {
        throw new RuntimeError('invalid_resource_catalog', `Resource ${id} source must be an http(s) URL`);
      }
    }
    const tags = textList(entry.tags, `entries[${index}].tags`);
    const requirements = textList(entry.requirements, `entries[${index}].requirements`);
    const license = entry.license === undefined ? undefined : text(entry.license, `entries[${index}].license`);
    const sourcePath = entry.sourcePath === undefined ? undefined : text(entry.sourcePath, `entries[${index}].sourcePath`);
    if (entry.archived !== undefined && typeof entry.archived !== 'boolean') {
      throw new RuntimeError('invalid_resource_catalog', `entries[${index}].archived must be a boolean`);
    }
    const commercialUse = optionalEnum(entry.commercialUse, COMMERCIAL_USE, `entries[${index}].commercialUse`);
    const compatibility = optionalEnum(entry.compatibility, COMPATIBILITY, `entries[${index}].compatibility`);
    const transport = optionalEnum(entry.transport, TRANSPORTS, `entries[${index}].transport`);
    const risk = enumList(entry.risk, RISKS, `entries[${index}].risk`);
    const importHint = entry.importHint === undefined ? undefined : text(entry.importHint, `entries[${index}].importHint`);
    return {
      id,
      kind,
      name: text(entry.name, `entries[${index}].name`),
      description: text(entry.description, `entries[${index}].description`),
      source,
      sourceKind,
      ...(license ? { license } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(entry.archived === true ? { archived: true } : {}),
      ...(commercialUse ? { commercialUse } : {}),
      ...(compatibility ? { compatibility } : {}),
      ...(transport ? { transport } : {}),
      ...(risk?.length ? { risk } : {}),
      ...(tags?.length ? { tags } : {}),
      ...(requirements?.length ? { requirements } : {}),
      ...(importHint ? { importHint } : {}),
    };
  });
  return {
    version: Number(document.version),
    ...(document.updatedAt === undefined ? {} : { updatedAt: text(document.updatedAt, 'updatedAt') }),
    entries,
  };
}

export async function loadResourceCatalog(root: string) {
  const document = JSON.parse(await readFile(join(root, 'resources.json'), 'utf8')) as Json;
  return parseResourceCatalog(document);
}
