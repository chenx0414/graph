import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assembleMattTeam, type MattTeamOptions } from '../src/catalog/matt-team.ts';
import { selectCapabilityRecord } from '../src/catalog/capability-select.ts';
import type { CapabilityRecord } from '../src/catalog/capability-library.ts';
import type { SavedAgentCombination } from '../src/catalog/catalog.ts';

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Usage: node examples/assemble-matt-team.ts --url http://127.0.0.1:<port> --config <task.json> --out <new-team.json>; missing ${name}`);
  return args[index + 1]!;
};
try {
  const base = new URL(option('--url'));
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('Use the local running Graph console URL');
  const output = resolve(option('--out'));
  if (await access(output).then(() => true, () => false)) throw new Error(`Output already exists: ${output}`);
  const options = JSON.parse(await readFile(resolve(option('--config')), 'utf8')) as MattTeamOptions;
  const session = await fetch(base);
  if (!session.ok) throw new Error(`Graph session: HTTP ${session.status}`);
  const cookie = session.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Graph did not provide a local session cookie');
  const headers = { cookie, origin: base.origin, 'content-type': 'application/json' };
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, base), { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`);
    return await response.json() as T;
  };
  const snapshot = await request<{ capabilities: CapabilityRecord[] }>('/api/catalog');
  const definition = await assembleMattTeam({
    capability: (id, version) => selectCapabilityRecord(snapshot.capabilities, id, version),
    saveAgentCombination: combination => request<SavedAgentCombination>('/api/catalog/combinations', { combination }),
  }, options);
  await writeFile(output, `${JSON.stringify(definition, null, 2)}\n`, { flag: 'wx' });
  console.log(`Reusable Matt team saved: ${output}`);
  console.log(`Published recipes: ${Object.values(definition.nodes).map(node => node.recipe).join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
