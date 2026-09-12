import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Catalog } from '../catalog/catalog.ts';
import type { Json, NodeSpec, Proposal } from '../core/types.ts';

type Supervisor = {
  propose(proposal: Proposal, requestId: string): Promise<unknown>;
  revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; requestId: string }): Promise<unknown>;
};

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }], details: {} };
}

function workspacePath(workspace: string, relative: string) {
  const root = realpathSync(workspace);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error('Path is outside the workspace');
  return target;
}

function fields(params: unknown) {
  return params as Record<string, unknown>;
}

/** Workspace, result, and supervisor tools for a production Pi instance. */
export function agentTools(input: {
  workspace: string;
  role?: NodeSpec['role'];
  supervisor?: Supervisor;
  catalog?: Catalog;
  install?: (input: { id: string; kind: 'skill' | 'mcp' | 'extension'; source: string; version: string; requestId: string }) => Promise<unknown>;
  onSubmit?: (output: Json) => void;
}): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'read_file', label: 'Read file', description: 'Read a UTF-8 file from the instance workspace.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => {
        const path = workspacePath(input.workspace, String(fields(params).path));
        return text(await readFile(path, 'utf8'));
      },
    },
    {
      name: 'write_file', label: 'Write file', description: 'Write a UTF-8 file inside the instance workspace.',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id, params) => {
        const body = fields(params);
        const path = workspacePath(input.workspace, String(body.path));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, String(body.content));
        return text(`Wrote ${body.path}`);
      },
    },
    {
      name: 'list_dir', label: 'List directory', description: 'List files in a workspace directory.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => {
        const path = workspacePath(input.workspace, String(fields(params).path || '.'));
        const names = await readdir(path);
        return text(names.join('\n'));
      },
    },
    {
      name: 'submit_result', label: 'Submit result', description: 'Submit structured JSON output for this operation.',
      parameters: Type.Object({ outputJson: Type.String() }),
      execute: async (_id, params) => {
        input.onSubmit?.(JSON.parse(String(fields(params).outputJson)) as Json);
        return text('Recorded structured result');
      },
    },
  ];
  if (input.role === 'master' && input.supervisor) {
    tools.push(
      {
        name: 'propose_graph', label: 'Propose graph', description: 'Submit a validated task graph proposal for the user to confirm.',
        parameters: Type.Object({ proposalJson: Type.String(), requestId: Type.String() }),
        execute: async (_id, params) => {
          const body = fields(params);
          const proposal = JSON.parse(String(body.proposalJson)) as Proposal;
          const receipt = await input.supervisor!.propose(proposal, String(body.requestId));
          return text(JSON.stringify(receipt));
        },
      },
      {
        name: 'revise_graph', label: 'Revise graph', description: 'Revise the confirmed task graph without changing acceptance items.',
        parameters: Type.Object({ baseVersion: Type.Number(), reason: Type.String(), nodesJson: Type.String(), requestId: Type.String() }),
        execute: async (_id, params) => {
          const body = fields(params);
          const receipt = await input.supervisor!.revise({
            baseVersion: Number(body.baseVersion), reason: String(body.reason),
            nodes: JSON.parse(String(body.nodesJson)) as NodeSpec[], requestId: String(body.requestId),
          });
          return text(JSON.stringify(receipt));
        },
      },
    );
  }
  if (input.role === 'master' && input.catalog) {
    tools.push({
      name: 'publish_definition', label: 'Publish definition', description: 'Publish a versioned Agent definition to the catalog.',
      parameters: Type.Object({ id: Type.String(), specJson: Type.String() }),
      execute: async (_id, params) => {
        const body = fields(params);
        const published = input.catalog!.publishDefinition(String(body.id), JSON.parse(String(body.specJson)));
        return text(JSON.stringify(published));
      },
    });
  }
  if (input.role === 'master' && input.install) {
    tools.push({
      name: 'install_capability', label: 'Install capability', description: 'Install a skill, MCP server, or extension into the capability catalog.',
      parameters: Type.Object({ id: Type.String(), kind: Type.String(), source: Type.String(), version: Type.String(), requestId: Type.String() }),
      execute: async (_id, params) => {
        const body = fields(params);
        const kind = String(body.kind);
        if (kind !== 'skill' && kind !== 'mcp' && kind !== 'extension') throw new Error('Unsupported capability kind');
        const receipt = await input.install!({ id: String(body.id), kind, source: String(body.source), version: String(body.version), requestId: String(body.requestId) });
        return text(JSON.stringify(receipt));
      },
    });
  }
  return tools;
}
