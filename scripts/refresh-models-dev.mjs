#!/usr/bin/env node
/**
 * Refresh the vendored models.dev snapshot (B-1).
 *
 * Source: https://models.dev/api.json — the community "models.dev" catalog of
 * model metadata (context/limit, modalities, reasoning options and USD prices
 * per million tokens). Retrieved from the public API over plain `fetch`; the
 * runtime console never downloads this file, it only reads the vendored copy,
 * so the server gains no new runtime network dependency.
 *
 * The snapshot keeps models.dev's provider/model structure verbatim under
 * `providers` and adds provenance next to it (source URL, fetch timestamp and
 * the license/attribution note). `src/catalog/models-dev.ts` does the mapping.
 *
 * Usage: node --run catalog:refresh
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://models.dev/api.json';
const LICENSE = 'models.dev community catalog (MIT). Attribution: https://models.dev';
const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'catalog', 'models-dev.snapshot.json');

const response = await fetch(SOURCE_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
if (!response.ok) {
  console.error(`catalog:refresh failed: ${SOURCE_URL} responded HTTP ${response.status} ${response.statusText}`);
  process.exit(1);
}
const body = await response.json();
if (!body || typeof body !== 'object' || Array.isArray(body)) {
  console.error('catalog:refresh failed: expected a JSON object of providers');
  process.exit(1);
}
const providers = Object.keys(body).length;
if (!providers) {
  console.error('catalog:refresh failed: the payload contained no providers');
  process.exit(1);
}
const snapshot = {
  fetchedAt: new Date().toISOString(),
  sourceUrl: SOURCE_URL,
  license: LICENSE,
  providers: body,
};
await writeFile(OUTPUT, `${JSON.stringify(snapshot)}\n`);
console.error(`catalog:refresh wrote ${providers} providers to ${OUTPUT}`);
