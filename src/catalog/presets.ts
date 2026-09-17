import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { canonicalJson } from '../core/store.ts';
import type { ModelGrade } from './models.ts';
import type { Json } from '../core/types.ts';
import type { CapabilityKind } from './catalog.ts';

/** Narrow catalog surface used by preset installation; satisfied by the
 * runtime catalog handle so installation goes through the audited command path. */
export interface PresetCatalog {
  capability(id: string, version?: string): { status: string } | undefined;
  preset(id: string): { hash: string } | undefined;
  recordPreset(id: string, version: string, hash: string, detail: Json): unknown;
  definitions(): { id: string; version: number }[];
  definitionSpec(id: string, version: number): unknown;
  publishDefinition(id: string, spec: unknown, requestId: string): unknown;
  install(input: { id: string; kind: CapabilityKind; source: string; version: string; requestId: string }): Promise<unknown>;
}

interface PresetEntry {
  id: string;
  kind: 'skill' | 'mcp' | 'prompt' | 'agent';
  version: string;
  path?: string;
  definition?: string;
  recommendedGrade?: ModelGrade;
  review?: boolean;
  description?: string;
  capabilities?: { id: string; version: string }[];
  prompts?: {
    agent?: { id: string; version: string };
    tool?: { id: string; version: string };
  };
}

interface PresetManifest {
  version: number;
  license?: string;
  source?: string;
  presets: PresetEntry[];
}

export interface PresetInstallResult {
  available: boolean;
  installed: string[];
  skipped: string[];
  failed: { id: string; reason: string }[];
}

async function fileHash(root: string) {
  const hash = createHash('sha256');
  const walk = async (dir: string, prefix: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, rel);
      else if (entry.isFile()) {
        hash.update(rel);
        hash.update('\0');
        hash.update(await readFile(path));
        hash.update('\0');
      }
    }
  };
  await walk(root, '');
  return hash.digest('hex');
}

/** Install the built-in preset pack into the versioned capability/definition
 * catalog. Skill and MCP content is copied through the existing restricted
 * installer; an unchanged content hash never republishes a definition, and an
 * upgrade creates new versions while old ones stay for running instances. */
export async function installPresets(catalog: PresetCatalog, presetsRoot: string, log: (line: string) => void = () => {}): Promise<PresetInstallResult> {
  const result: PresetInstallResult = { available: false, installed: [], skipped: [], failed: [] };
  let manifest: PresetManifest;
  try {
    manifest = JSON.parse(await readFile(join(presetsRoot, 'manifest.json'), 'utf8')) as PresetManifest;
    if (!Array.isArray(manifest.presets)) throw new Error('presets must be an array');
    result.available = true;
  } catch (error) {
    log(`Preset pack not available (${error instanceof Error ? error.message : String(error)}); built-in definitions stay minimal.`);
    return result;
  }
  for (const preset of manifest.presets) {
    try {
      if (preset.kind === 'skill' || preset.kind === 'mcp' || preset.kind === 'prompt') {
        if (!preset.path) throw new Error('preset path is required');
        const source = join(presetsRoot, preset.path);
        const info = await stat(source).catch(() => undefined);
        if (!info?.isDirectory()) throw new Error(`preset source ${preset.path} is not a directory`);
        const hash = await fileHash(source);
        const recorded = catalog.preset(preset.id);
        const capability = catalog.capability(preset.id, preset.version);
        if (recorded?.hash === hash && capability?.status === 'installed') {
          result.skipped.push(preset.id);
          continue;
        }
        if (!capability || capability.status !== 'installed') {
          await catalog.install({ id: preset.id, kind: preset.kind, source, version: preset.version, requestId: `preset-${preset.id}-${preset.version}-${hash.slice(0, 12)}` });
        }
        catalog.recordPreset(preset.id, preset.version, hash, {
          kind: preset.kind, version: preset.version, description: preset.description ?? null, license: manifest.license ?? null, source: manifest.source ?? null,
        });
        result.installed.push(preset.id);
        continue;
      }
      // Agent presets bind exact capability versions and are published only
      // when the same spec does not already exist at any version.
      const definitionId = preset.definition;
      if (!definitionId || !preset.recommendedGrade) throw new Error('agent presets need definition and recommendedGrade');
      const hash = createHash('sha256').update(JSON.stringify({ preset, manifest: manifest.version })).digest('hex');
      const desired = {
        recommendedGrade: preset.recommendedGrade,
        ...(preset.review ? { review: true } : {}),
        ...(preset.capabilities?.length ? { capabilities: preset.capabilities } : {}),
        ...(preset.prompts ? { prompts: preset.prompts } : {}),
        snapshot: {
          preset: { id: preset.id, version: preset.version, hash: hash.slice(0, 16), license: manifest.license ?? null, source: manifest.source ?? null },
          description: preset.description ?? null,
        } as Json,
      };
      const existing = catalog.definitions().filter(item => item.id === definitionId);
      const matches = (item: { id: string; version: number }) => canonicalJson(catalog.definitionSpec(item.id, item.version) as Json) === canonicalJson({ id: definitionId, version: item.version, ...desired } as unknown as Json);
      if (existing.some(matches)) {
        catalog.recordPreset(preset.id, preset.version, hash, { kind: 'agent', definition: definitionId, version: preset.version, description: preset.description ?? null });
        result.skipped.push(preset.id);
        continue;
      }
      for (const bound of preset.capabilities ?? []) {
        const record = catalog.capability(bound.id, bound.version);
        if (!record || record.status !== 'installed') throw new Error(`bound capability ${bound.id}@${bound.version} is not installed`);
      }
      for (const bound of [preset.prompts?.agent, preset.prompts?.tool]) {
        if (!bound) continue;
        const record = catalog.capability(bound.id, bound.version);
        if (!record || record.status !== 'installed') throw new Error(`bound prompt ${bound.id}@${bound.version} is not installed`);
      }
      catalog.publishDefinition(definitionId, desired, `preset-${preset.id}-${hash.slice(0, 16)}`);
      catalog.recordPreset(preset.id, preset.version, hash, { kind: 'agent', definition: definitionId, version: preset.version, description: preset.description ?? null });
      result.installed.push(preset.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.failed.push({ id: preset.id, reason });
      log(`Preset ${preset.id} failed: ${reason}`);
    }
  }
  return result;
}
