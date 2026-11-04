import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { Page } from 'playwright';
import { launchCli } from '../helpers/cli-daemon.ts';
import { desktopBinary } from '../helpers/agent-desktop.ts';
import { openaiServer, type ResponsePlan } from './openai-server.ts';

/**
 * A real daemon whose master Agent can call the two tools the console has to
 * describe: the MCP gateway (a Pi extension tool named `mcp`, exactly as the
 * host installs it) and the native computer-use tool `desktop`.
 *
 * Everything the product owns is real here: the built graphd, the desktop
 * capability running the installed agent-desktop CLI, Graph's own conversation
 * storage and the built console. The MCP server itself is an external service,
 * so the extension stands in for it and the arguments are what the gateway
 * passes through.
 */

/** A value that must never reach the transcript: MCP arguments, not identity. */
export const MCP_PAYLOAD_SENTINEL = 'GRAPH_MCP_PAYLOAD_SENTINEL_8f2c';
export const MARKER = 'TOOL-ACTIVITY-MARKER';

const mcpGatewaySource = `export default function (pi) {
  pi.registerTool({
    name: 'mcp',
    description: 'MCP gateway: one server tool plus its arguments.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        tool: { type: 'string' },
        action: { type: 'string' },
        args: { type: 'object' },
      },
      additionalProperties: true,
    },
    execute: async () => ({ content: [{ type: 'text', text: 'mcp: ok' }] }),
  });
}
`;

export interface TranscriptToolMessage {
  role: string;
  kind?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface ConversationView {
  master?: { status?: string };
  messages?: TranscriptToolMessage[];
}

/** The calls the scripted model makes before it answers in words. */
export function toolActivityPlans(): ResponsePlan[] {
  return [
    {
      tools: [
        {
          id: 'mcp-open-binary',
          name: 'mcp',
          arguments: JSON.stringify({
            server: 'rea',
            tool: 'open_binary',
            args: { path: '/tmp/' + MCP_PAYLOAD_SENTINEL },
          }),
        },
        {
          id: 'desktop-snapshot',
          name: 'desktop',
          arguments: JSON.stringify({ command: 'snapshot', args: ['--app', 'Finder'] }),
        },
      ],
    },
    { text: '两个工具都跑完了。' },
  ];
}

export async function launchToolActivityGraph(options: { webDir?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-tool-activity-'));
  const project = join(root, 'project');
  const graphHome = join(root, 'graph-home');
  await mkdir(project, { recursive: true });
  await mkdir(graphHome, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), '# Tool activity project\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'graph@example.invalid'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'Graph Test'], { cwd: project });
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: project });

  // The MCP gateway is a Pi extension on the host, so the fixture installs one
  // the same way a user's host does: a capability the recipe binds.
  const capabilityDirectory = join(graphHome, 'capabilities', 'pi-extension', 'mcp-gateway-1.0.0');
  await mkdir(capabilityDirectory, { recursive: true });
  await writeFile(join(capabilityDirectory, 'index.mjs'), mcpGatewaySource);
  await writeFile(join(capabilityDirectory, 'capability.json'), JSON.stringify({
    id: 'mcp-gateway', kind: 'pi-extension', version: '1.0.0', name: 'MCP gateway',
    entry: './index.mjs',
    tools: [{ name: 'mcp', description: 'MCP gateway: one server tool plus its arguments.' }],
  }));
  await writeFile(join(graphHome, 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'main', name: 'Main', description: 'The main agent with the MCP gateway.',
      recommendedGrade: 'high', review: false, tags: [],
      resources: [{ resourceId: 'mcp-gateway', version: '1.0.0', role: 'pi-extension', required: false }],
    }],
  }));

  const desktopHome = join(root, 'agent-desktop');
  await mkdir(desktopHome, { recursive: true, mode: 0o700 });
  const provider = await openaiServer(toolActivityPlans());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_TOOL_ACTIVITY_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath,
    graphHome,
    ...(options.webDir ? { webDir: options.webDir } : {}),
    env: {
      GRAPH_TOOL_ACTIVITY_KEY: 'synthetic-only',
      GRAPH_DESKTOP_BIN: desktopBinary(),
      AGENT_DESKTOP_HOME: desktopHome,
    },
    extraArgs: ['--execute'],
  });

  const compiled = await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST' });
  if (compiled.status !== 200) throw new Error(`the recipe did not compile: ${await compiled.text()}`);

  const open = async (): Promise<string> => {
    const response = await daemon.request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p', model: 'main', text: `${MARKER}: 用一下这两个工具`, requestId: 'tool-activity-open' }),
    });
    const body = await response.text();
    if (response.status !== 200) throw new Error(`the conversation did not open: ${body}`);
    return (JSON.parse(body) as { conversationId: string }).conversationId;
  };
  const view = async (id: string): Promise<ConversationView> =>
    await (await daemon.request(`/api/conversations/${id}`)).json() as ConversationView;
  const settle = async (id: string): Promise<ConversationView> => {
    await expect.poll(async () => (await view(id)).master?.status, { timeout: 180_000, interval: 250 }).toBe('succeeded');
    return await view(id);
  };

  return {
    root, project, daemon, provider, open, view, settle,
    async close() {
      await daemon.close();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Open the built console on one conversation and unfold the turn until its tool
 * rows are on screen. The page is the product's own route, not a harness shim.
 */
export async function openConsole(page: Page, url: string, conversationId: string): Promise<void> {
  await page.goto(`${url}/#/conversations/${conversationId}`);
  await page.waitForURL(`${url}/#/conversations/${conversationId}`);
  const conversation = page.locator('[data-testid="conversation"]:visible');
  await conversation.getByTestId('chat-input').waitFor();
  const turn = conversation.getByTestId('collapsed-turn').first();
  await turn.waitFor();
  if (await turn.getAttribute('data-open') !== 'true') {
    await turn.getByRole('button', { name: '展开这一轮的思考与工具调用' }).click();
    await expect.poll(() => turn.getAttribute('data-open')).toBe('true');
  }
  const group = conversation.getByTestId('tool-activity-group').first();
  await group.waitFor();
  if (await group.getAttribute('data-open') !== 'true') {
    await group.getByRole('button', { name: '展开工具活动' }).click();
    await expect.poll(() => group.getAttribute('data-open')).toBe('true');
  }
}
