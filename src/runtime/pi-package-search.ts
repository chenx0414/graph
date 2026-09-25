import { RuntimeError } from '../core/types.ts';

/**
 * The official Pi package channel is npm, marked by the `pi-package` keyword: the Pi README
 * points readers at `npmjs.com/search?q=keywords%3Api-package` and its Discord. There is no
 * separate registry, so browsing is a read-only registry search.
 */
export interface PiPackageHit {
  name: string;
  version: string;
  description: string;
  publisher: string | null;
  weeklyDownloads: number | null;
  url: string | null;
}

const KEYWORD = 'pi-package';
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; hits: PiPackageHit[] }>();

/** Parse one npm registry search payload into browse rows; only real Pi packages survive. */
export function parseRegistrySearch(payload: unknown): PiPackageHit[] {
  const objects = (payload as { objects?: unknown } | null)?.objects;
  if (!Array.isArray(objects)) return [];
  const hits: PiPackageHit[] = [];
  for (const entry of objects) {
    const pkg = (entry as { package?: Record<string, unknown> } | null)?.package;
    const name = pkg?.name;
    if (!pkg || typeof name !== 'string' || !name) continue;
    const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.filter((value): value is string => typeof value === 'string') : [];
    // Registry search is fuzzy, so the official marker decides what counts as a Pi package.
    if (!keywords.includes(KEYWORD)) continue;
    const publisher = (pkg.publisher as { username?: unknown } | undefined)?.username;
    const npmLink = (pkg.links as { npm?: unknown } | undefined)?.npm;
    const weekly = (entry as { downloads?: { weekly?: unknown } } | null)?.downloads?.weekly;
    hits.push({
      name,
      version: typeof pkg.version === 'string' ? pkg.version : '',
      description: typeof pkg.description === 'string' ? pkg.description : '',
      publisher: typeof publisher === 'string' && publisher ? publisher : null,
      weeklyDownloads: typeof weekly === 'number' ? weekly : null,
      url: typeof npmLink === 'string' && npmLink ? npmLink : null,
    });
  }
  return hits;
}

/** Read-only search of the official channel; a short cache keeps repeated browsing cheap. */
export async function searchPiPackages(input: { query?: string; limit?: number }): Promise<PiPackageHit[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const terms = (input.query ?? '').trim().replace(/\s+/g, ' ');
  const text = terms ? `keywords:${KEYWORD} ${terms}` : `keywords:${KEYWORD}`;
  const key = `${text}|${limit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.hits;
  const response = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${limit}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new RuntimeError('capability_unavailable', `npm registry search failed: HTTP ${response.status}`);
  const hits = parseRegistrySearch(await response.json() as unknown);
  cache.set(key, { at: Date.now(), hits });
  return hits;
}
