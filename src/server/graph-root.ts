import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function graphApplicationRoot(moduleUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(moduleUrl)), '../..');
}
