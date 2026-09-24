import { dirname } from 'node:path';
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { RuntimeError } from '../core/types.ts';

export interface ResolvedPiExtensionSource {
  /** Extension entry files the SDK resolved, in its own order. */
  entries: string[];
  /** Directories the loaded extension needs to read (install root plus each entry's folder). */
  readRoots: string[];
}

/**
 * Resolve one Pi extension capability source exactly the way the Pi SDK does it: `npm:<spec>`,
 * a git URL, or a local path. The SDK's own package manager installs it (temporary scope, under
 * `<agentDir>/tmp/extensions`) and reads the package's own `pi.extensions` list, so Graph neither
 * vendors a copy nor hand-writes the entry file.
 */
export async function resolvePiExtensionSource(input: {
  source: string;
  cwd: string;
  agentDir: string;
}): Promise<ResolvedPiExtensionSource> {
  const manager = new DefaultPackageManager({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: SettingsManager.inMemory(),
  });
  const resolved = await manager.resolveExtensionSources([input.source], { temporary: true });
  const entries = resolved.extensions.filter(resource => resource.enabled).map(resource => resource.path);
  if (!entries.length) {
    throw new RuntimeError('capability_unavailable', `Pi extension source ${input.source} resolved no extension entry`);
  }
  const readRoots = [...new Set([
    ...resolved.extensions.map(resource => resource.metadata.baseDir).filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...entries.map(entry => dirname(entry)),
  ])];
  return { entries, readRoots };
}
