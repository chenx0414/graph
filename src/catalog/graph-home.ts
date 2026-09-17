import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** User-owned Graph state. Capabilities and recipes stay outside the daemon DB. */
export function graphHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GRAPH_HOME?.trim();
  return resolve(configured ? configured : join(homedir(), '.graph'));
}

export function capabilityRoot(home = graphHome()): string {
  return join(home, 'capabilities');
}

export function agentCombinationPath(home = graphHome()): string {
  return join(home, 'agent-combinations.json');
}
