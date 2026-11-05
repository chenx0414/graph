import { expect, test } from 'vitest';
import {
  MCP_PAYLOAD_SENTINEL, launchToolActivityGraph, type TranscriptToolMessage,
} from '../fixtures/tool-activity-graph.ts';

/**
 * What the host records for an MCP call and a computer-use call.
 *
 * The console only renders what it is given, so the summary of a tool call is
 * the host's record: one bounded line, with the service and the command the
 * model actually called, and without the arguments that belong to the call and
 * not to the transcript. This flow is the product's own: a real daemon, a real
 * provider boundary, the real desktop capability and the real conversation
 * store; only the MCP server is external and stands behind the gateway.
 */

const toolMessage = (messages: TranscriptToolMessage[], tool: string) =>
  messages.find(message => message.role === 'tool' && message.data?.tool === tool);

test('the host records the MCP service:command and the desktop subcommand, bounded and without payload arguments', async () => {
  const graph = await launchToolActivityGraph();
  try {
    const conversationId = await graph.open();
    const { messages = [] } = await graph.settle(conversationId);

    const mcp = toolMessage(messages, 'mcp');
    expect(mcp, 'the MCP call was not recorded').toBeTruthy();
    expect(mcp!.text).toBe('mcp: rea: open_binary');
    expect(mcp!.text, 'the MCP arguments were copied into the transcript').not.toContain(MCP_PAYLOAD_SENTINEL);

    const desktop = toolMessage(messages, 'desktop');
    expect(desktop, 'the desktop call was not recorded').toBeTruthy();
    expect(desktop!.text).toBe('desktop: snapshot --app Finder');

    // The existing bound still holds: a summary is one line, never the call.
    for (const message of [mcp!, desktop!]) {
      expect([...(message.text ?? '')].length).toBeLessThanOrEqual(200);
    }
  } finally {
    await graph.close();
  }
}, 240_000);
