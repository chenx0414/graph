import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Running source checkout, or the packaged APP's Contents/Resources/app root. */
export function graphApplicationRoot(moduleUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(moduleUrl)), '../..');
}
