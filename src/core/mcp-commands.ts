/** Local MCP commands accepted by both capability scanning and runtime launch. */
export const LOCAL_MCP_COMMANDS = ['node', 'npx', 'uvx'] as const;

const LOCAL_MCP_COMMAND_SET = new Set<string>(LOCAL_MCP_COMMANDS);

export function isLocalMcpCommand(value: string) {
  return LOCAL_MCP_COMMAND_SET.has(value);
}
