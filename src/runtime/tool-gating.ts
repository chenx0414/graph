import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const EXTERNALLY_GATED = Symbol.for('graph.externally-gated');

/** Mark a tool whose execute already passes the send gate at its own effect boundary. */
export function externallyGated<T extends ToolDefinition>(tool: T): T {
  return Object.assign(tool, { [EXTERNALLY_GATED]: true });
}

export function isExternallyGated(tool: ToolDefinition) {
  return Boolean((tool as { [EXTERNALLY_GATED]?: boolean })[EXTERNALLY_GATED]);
}

