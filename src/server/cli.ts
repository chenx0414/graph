import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findGraphd, graphdSearchStarts } from './go-launch.ts';
import { graphApplicationRoot } from '../runtime/graph-root.ts';

// Preserve the CLI process identity and signals while Go owns the application.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const binary = findGraphd([process.cwd(), dirname(fileURLToPath(import.meta.url)), ...graphdSearchStarts()]);
const args = process.argv.slice(2);
if (!args.includes('--application-root')) args.push('--application-root', graphApplicationRoot());
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
process.execve!(binary, [binary, ...args], env);

}
