import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelGrade } from './models.ts';

export interface BootstrapDefinition {
  id: string;
  recommendedGrade: ModelGrade;
  review?: boolean;
}

export interface PresetBootstrap {
  available: boolean;
  prompts: Record<string, string>;
  toolPrompt?: string;
  agentDocs: Record<string, string>;
  definitions: BootstrapDefinition[];
  installed: string[];
  failed: { id: string; reason: string }[];
}

interface PresetManifest {
  version: number;
  bootstrap?: {
    prompts?: Record<string, string>;
    toolPrompt?: string;
    agentDocs?: string;
    definitions?: BootstrapDefinition[];
  };
}

export interface PresetCatalog {
  publishDefinition(id: string, spec: { recommendedGrade: ModelGrade; review?: boolean }, requestId: string): unknown;
  ensureDefinition?(id: string, spec: { recommendedGrade: ModelGrade; review?: boolean }): unknown;
}

/** Load immutable Graph bootstrap content. Third-party capabilities never live
 * in presets; they are scanned from the user's ~/.graph/capabilities root. */
export async function loadPresetBootstrap(presetsRoot: string, log: (line: string) => void = () => {}): Promise<PresetBootstrap> {
  const result: PresetBootstrap = { available: false, prompts: {}, agentDocs: {}, definitions: [], installed: [], failed: [] };
  let manifest: PresetManifest;
  try {
    manifest = JSON.parse(await readFile(join(presetsRoot, 'manifest.json'), 'utf8')) as PresetManifest;
    if (!manifest.bootstrap || !Array.isArray(manifest.bootstrap.definitions)) throw new Error('bootstrap.definitions must be an array');
    result.definitions = manifest.bootstrap.definitions;
    result.available = true;
  } catch (error) {
    log(`Bootstrap preset pack not available (${error instanceof Error ? error.message : String(error)}); built-in definitions stay minimal.`);
    return result;
  }
  const promptPaths = manifest.bootstrap.prompts ?? {};
  for (const [name, relative] of Object.entries(promptPaths)) {
    try {
      const text = await readFile(join(presetsRoot, relative), 'utf8');
      if (!text.trim()) throw new Error('prompt is empty');
      result.prompts[name] = text;
    } catch (error) {
      result.failed.push({ id: `prompt:${name}`, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (manifest.bootstrap.toolPrompt) {
    try {
      const text = await readFile(join(presetsRoot, manifest.bootstrap.toolPrompt), 'utf8');
      if (!text.trim()) throw new Error('tool prompt is empty');
      result.toolPrompt = text;
    } catch (error) {
      result.failed.push({ id: 'prompt:tool-awareness', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (manifest.bootstrap.agentDocs) {
    try {
      const docs = await loadMarkdownTree(join(presetsRoot, manifest.bootstrap.agentDocs));
      if (!docs['INDEX.md']) throw new Error('agent docs must include INDEX.md');
      result.agentDocs = Object.fromEntries(
        Object.entries(docs).map(([path, content]) => [`docs/${path}`, content]),
      );
    } catch (error) {
      result.failed.push({ id: 'docs:agent', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

async function loadMarkdownTree(root: string, prefix = ''): Promise<Record<string, string>> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await loadMarkdownTree(root, relative));
    else if (entry.isFile() && entry.name.endsWith('.md')) result[relative] = await readFile(join(root, relative), 'utf8');
  }
  return result;
}

export function publishBootstrap(catalog: PresetCatalog, bootstrap: PresetBootstrap, log: (line: string) => void = () => {}) {
  const result: PresetBootstrap = { ...bootstrap, definitions: [], installed: [], failed: [...bootstrap.failed] };
  for (const definition of bootstrap.definitions) {
    try {
      const spec = {
        recommendedGrade: definition.recommendedGrade,
        ...(definition.review ? { review: true } : {}),
      };
      if (catalog.ensureDefinition) catalog.ensureDefinition(definition.id, spec);
      else catalog.publishDefinition(definition.id, spec, `bootstrap-${definition.id}`);
      result.definitions.push(definition);
      result.installed.push(definition.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.failed.push({ id: definition.id, reason });
      log(`Bootstrap definition ${definition.id} failed: ${reason}`);
    }
  }
  return result;
}

export async function installPresets(catalog: PresetCatalog, presetsRoot: string, log: (line: string) => void = () => {}): Promise<PresetBootstrap> {
  return publishBootstrap(catalog, await loadPresetBootstrap(presetsRoot, log), log);
}
