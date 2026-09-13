import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RuntimeError } from '../core/types.ts';
import { defaultConfigPath, defaultStateDir } from './config.ts';
import { startGraphDaemon, type GraphDaemon } from './start.ts';

export interface CliOptions {
  configPath: string | null;
  stateDir: string;
  webDir: string;
  port: number;
  mode: 'view' | 'execute';
  help: boolean;
}

const USAGE = `Usage: node src/server/cli.ts [options] (pnpm start [-- options])

Starts the Graph console on http://127.0.0.1 (loopback only).

Options:
  --config <path>     Config file (default: ./graph.config.json when present)
  --state-dir <path>  State directory (default: $XDG_STATE_HOME/graph or ~/.local/state/graph)
  --web-dir <path>    Built web console (default: ./dist/web)
  --port <number>     Loopback port, 0 picks a free port (default: 4173)
  --execute           Enable task dispatch; requires configured models and credentials
  --view-only         History, settings and graph only; never dispatches (default)
  -h, --help          Print this help

Environment fallbacks: GRAPH_CONFIG, GRAPH_STATE_DIR, GRAPH_WEB_DIR, GRAPH_PORT.`;

function usageError(message: string): never {
  throw new RuntimeError('usage', message);
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>, cwd: string): CliOptions {
  let configFlag: string | undefined;
  let stateFlag: string | undefined;
  let webFlag: string | undefined;
  let portFlag: string | undefined;
  let execute = false;
  let viewOnly = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) usageError(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--config') configFlag = value();
    else if (arg === '--state-dir') stateFlag = value();
    else if (arg === '--web-dir') webFlag = value();
    else if (arg === '--port') portFlag = value();
    else if (arg === '--execute') execute = true;
    else if (arg === '--view-only') viewOnly = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else usageError(`Unknown argument: ${arg}`);
  }
  if (execute && viewOnly) usageError('--execute and --view-only are mutually exclusive');
  let port = 4173;
  const rawPort = portFlag ?? env.GRAPH_PORT;
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) usageError(`Invalid port: ${rawPort}`);
  }
  const explicitConfig = configFlag ?? env.GRAPH_CONFIG;
  const defaultPath = defaultConfigPath(cwd);
  const configPath = explicitConfig ? resolve(cwd, explicitConfig) : existsSync(defaultPath) ? defaultPath : null;
  return {
    configPath,
    stateDir: resolve(cwd, stateFlag ?? env.GRAPH_STATE_DIR ?? defaultStateDir(env)),
    webDir: resolve(cwd, webFlag ?? env.GRAPH_WEB_DIR ?? 'dist/web'),
    port,
    mode: execute ? 'execute' : 'view',
    help,
  };
}

export function printBanner(daemon: GraphDaemon, write: (line: string) => void) {
  const mode = daemon.mode === 'execute'
    ? 'execute (task dispatch enabled)'
    : 'view-only (history, settings and graph; no model dispatch)';
  write('Graph console');
  write(`  mode:      ${mode}`);
  write(`  config:    ${daemon.configPath ?? 'none — first run; add graph.config.json to enable projects and models'}`);
  write(`  state:     ${daemon.stateDir}`);
  write(`  web:       ${daemon.webDir}`);
  write(`  models:    ${daemon.modelCount} configured, ${daemon.enabledModelCount} enabled`);
  write(`  address:   ${daemon.url}`);
  write('  stop:      Ctrl-C / SIGTERM (bounded 5s stop)');
  write('The browser is only a client; closing it does not stop the daemon.');
}

async function main() {
  const write = (line: string) => process.stdout.write(`${line}\n`);
  const fail = (line: string) => process.stderr.write(`graph: ${line}\n`);
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2), process.env, process.cwd());
  } catch (error) {
    fail(`${(error as RuntimeError).code ?? 'error'}: ${(error as Error).message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    write(USAGE);
    return;
  }
  let daemon: GraphDaemon;
  try {
    daemon = await startGraphDaemon({ ...options, env: process.env, log: write });
  } catch (error) {
    fail(`${(error as RuntimeError).code ?? 'error'}: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  printBanner(daemon, write);
  let stopping = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) {
      fail(`Second ${signal}; exiting immediately.`);
      process.exit(1);
    }
    stopping = true;
    write(`${signal} received; stopping with a 5s deadline...`);
    const timeout = new Promise<'timeout'>(resolveTimeout => {
      const timer = setTimeout(() => resolveTimeout('timeout'), 5_000);
      timer.unref();
    });
    const outcome = await Promise.race([daemon.close().then(() => 'closed' as const), timeout]);
    if (outcome === 'timeout') {
      fail('Stop deadline exceeded; exiting with code 1. In-flight work stays recorded and is re-verified on restart.');
      process.exit(1);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
