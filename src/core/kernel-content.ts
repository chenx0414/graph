import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from './store.ts';
import { RuntimeError } from './types.ts';

// This prefix is deliberately not JSON: a user string/object can never impersonate
// a reference, since business values are always JSON encoded before storage.
const PREFIX = 'graph-content:sha256:';
export const contentDigest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Immutable JSON bodies share the kernel database and its transaction boundary. */
export class KernelContent {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS kernel_content(
      digest TEXT PRIMARY KEY, body TEXT NOT NULL, bytes INTEGER NOT NULL, preview TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS kernel_content_immutable BEFORE UPDATE ON kernel_content
      BEGIN SELECT RAISE(ABORT, 'Kernel content is immutable'); END;`);
  }

  encode(value: unknown): string {
    const body = canonicalJson(value);
    const bytes = Buffer.byteLength(body);
    if (bytes <= 4096) return body;
    const digest = contentDigest(body);
    this.db.prepare('INSERT OR IGNORE INTO kernel_content(digest,body,bytes,preview) VALUES(?,?,?,?)')
      .run(digest, body, bytes, body.slice(0, 512));
    return PREFIX + digest;
  }

  decode<T>(stored: string): T {
    if (!stored.startsWith(PREFIX)) return JSON.parse(stored) as T;
    const digest = stored.slice(PREFIX.length);
    const row = this.db.prepare('SELECT body FROM kernel_content WHERE digest=?').get(digest) as { body: string } | undefined;
    if (!row || contentDigest(row.body) !== digest) throw new RuntimeError('invalid_content', 'Missing or corrupt kernel content');
    return JSON.parse(row.body) as T;
  }
}

/** Internal SQL columns only. Metadata reads never fetch the large body. */
export function contentColumn(column: string, part: 'body' | 'bytes' | 'preview' = 'body'): string {
  const inline = part === 'body' ? column : part === 'bytes' ? `length(CAST(${column} AS BLOB))` : `substr(${column},1,512)`;
  return `(CASE WHEN substr(${column},1,${PREFIX.length})='${PREFIX}' THEN
    (SELECT c.${part} FROM kernel_content c WHERE c.digest=substr(${column},${PREFIX.length + 1})) ELSE ${inline} END)`;
}
