import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import { SQLITE_MIGRATIONS } from '@earendil-works/pi-durable/storage/sqlite';

// Identifiers belong to the locked upstream schema. Bindings, comments and SQL
// string literals are copied verbatim; they are never namespace candidates.
const objects = new Set(['durable_schema', ...SQLITE_MIGRATIONS.flatMap(migration => migration.statements.flatMap(sql => {
  const match = /CREATE (?:TABLE|INDEX)\s+(\w+)/i.exec(sql);
  return match?.[1] ? [match[1]] : [];
}))]);
function namespace(sql: string): string {
  const tokens = sql.match(/'(?:''|[^'])*'|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[\s\S]/g) ?? [];
  return tokens.map(token => {
    if (objects.has(token.toLowerCase())) return `graph_durable_${token}`;
    const first = token[0];
    if (first === '"' || first === '`' || first === '[') {
      const name = token.slice(1, -1);
      if (objects.has(name.toLowerCase())) return `${first}graph_durable_${name}${token.at(-1)}`;
    }
    return token;
  }).join('');
}
function executor(database: SqliteExecutor): SqliteExecutor {
  return {
    exec: sql => database.exec(namespace(sql)),
    run: (sql, ...params: SqliteValue[]) => database.run(namespace(sql), ...params),
    get: <T extends object>(sql: string, ...params: SqliteValue[]) => database.get<T>(namespace(sql), ...params),
    all: <T extends object>(sql: string, ...params: SqliteValue[]) => database.all<T>(namespace(sql), ...params),
  };
}
/** Dedicated durable connection, namespaced in the formal Graph database. */
export function namespaceDurableDatabase(database: SqliteDatabase): SqliteDatabase {
  return {
    ...executor(database),
    transaction: callback => database.transaction(tx => callback(executor(tx))),
    close: () => database.close(),
  };
}
