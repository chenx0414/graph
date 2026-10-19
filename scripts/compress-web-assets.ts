import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

/** Compress the final files: Vite may still append CSS metadata after generateBundle. */
export function compressWebAssets(): Plugin {
  return {
    name: 'graph-precompressed-assets',
    async writeBundle(options, bundle) {
      if (!options.dir) return;
      for (const item of Object.values(bundle)) {
        if (!/\.(?:js|css|json)$/.test(item.fileName)) continue;
        const file = join(options.dir, item.fileName);
        const bytes = await readFile(file);
        if (bytes.length < 1024) continue;
        const compressed = gzipSync(bytes, { level: 9 });
        if (compressed.length < bytes.length) await writeFile(`${file}.gz`, compressed);
      }
    },
  };
}
