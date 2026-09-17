import { realpathSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CapabilityKind, Catalog } from '../catalog/catalog.ts';
import type { Json, NodeSpec, Proposal } from '../core/types.ts';
import { listBounded, readBounded, writeBounded } from './bounded-path.ts';
import { externallyGated } from './pi-instance.ts';

type Supervisor = {
  propose(proposal: Proposal, requestId: string): Promise<unknown>;
  revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; requestId: string }): Promise<unknown>;
};

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }], details: {} };
}

function fields(params: unknown) {
  return params as Record<string, unknown>;
}

/** Workspace, result, supervisor, and granted retrieval tools for a production Pi instance. */
export function agentTools(input: {
  workspace: string;
  role?: NodeSpec['role'];
  readRoots?: string[];
  /** Discussion turns investigate without writing business files or running commands. */
  readOnly?: boolean;
  run?: (command: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  fetch?: (url: string) => Promise<{ url: string; status: number; contentType: string; text: string; truncated: boolean }>;
  supervisor?: Supervisor;
  catalog?: Catalog;
  install?: (input: { id: string; kind: CapabilityKind; source: string; version: string; requestId: string }) => Promise<unknown>;
  onSubmit?: (output: Json) => void;
  onSuggestedPrompt?: (prompt: string) => void;
}): ToolDefinition[] {
  const root = realpathSync(input.workspace);
  const readRoots = (input.readRoots ?? []).map(item => realpathSync(item));
  const tools: ToolDefinition[] = [
    {
      name: 'read', label: 'Read file', description: 'Read a UTF-8 file from the instance workspace or a bound capability.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => {
        const requested = String(fields(params).path);
        if (isAbsolute(requested)) {
          const mount = [root, ...readRoots].find(candidate => requested === candidate || requested.startsWith(`${candidate}${sep}`));
          if (!mount) throw new Error('Path is outside the workspace');
          return text(await readBounded(mount, requested));
        }
        return text(await readBounded(root, requested));
      },
    },
    ...(input.readOnly ? [] : [{
      name: 'write_file', label: 'Write file', description: 'Write a UTF-8 file inside the instance workspace.',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id: string, params: unknown) => {
        const body = fields(params);
        await writeBounded(root, String(body.path), String(body.content));
        return text(`Wrote ${body.path}`);
      },
    }]),
    {
      name: 'list_dir', label: 'List directory', description: 'List files in a workspace directory.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => text((await listBounded(root, String(fields(params).path || '.'))).join('\n')),
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
  if (input.run && !input.readOnly) {
    const run = input.run;
    tools.push(externallyGated({
      name: 'run_command', label: 'Run command', description: 'Run an allowed command inside the work copy: command is a bare executable name (node or git) and args is a string array, for example {command:"node",args:["--test","test/x.test.js"]}. It is not a shell; git only supports read-only status/diff/log/show.',
      parameters: Type.Object({ command: Type.String(), args: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, params) => {
        const body = fields(params);
        const result = await run(String(body.command), Array.isArray(body.args) ? body.args.map(String) : []);
        return text(`exit ${result.code ?? 'signal'}\n${result.stdout}${result.stderr}`);
      },
    }));
  }
  if (input.fetch) {
    const fetchUrl = input.fetch;
    tools.push(externallyGated({
      name: 'fetch', label: 'Fetch URL', description: 'Fetch a text document from a granted domain and return its body.',
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, params) => text(JSON.stringify(await fetchUrl(String(fields(params).url)))),
    }));
  }
  if (input.role === 'master' && input.supervisor) {
    tools.push(
      {
        name: 'suggest_prompt', label: 'Suggest next prompt', description: 'Record one concise next user prompt to show as an optional composer suggestion. This never sends anything automatically and must not replace the normal reply.',
        parameters: Type.Object({ prompt: Type.String() }),
        execute: async (_id, params) => {
          const prompt = String(fields(params).prompt).trim();
          if (!prompt || prompt.length > 500) throw new Error('A prompt suggestion must be between 1 and 500 characters');
          input.onSuggestedPrompt?.(prompt);
          return text('Recorded prompt suggestion');
        },
      },
      {
        name: 'propose_graph', label: 'Propose graph', description: 'Submit a validated task graph proposal for the user to confirm. proposalJson must use the schema shown in the briefing. Keep the optional decisions list current: it is frozen with this draft version and passed to workers after confirmation.',
        parameters: Type.Object({ proposalJson: Type.String(), requestId: Type.String() }),
        execute: async (_id, params) => {
          const body = fields(params);
          const proposal = JSON.parse(String(body.proposalJson)) as Proposal;
          const receipt = await input.supervisor!.propose(proposal, String(body.requestId));
          return text(JSON.stringify(receipt));
        },
      },
      {
        name: 'revise_graph', label: 'Revise graph', description: 'Revise the confirmed task graph without changing acceptance items. nodesJson uses the same node schema shown in the briefing.',
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
      name: 'install_capability', label: 'Install capability', description: 'Install a Skill, MCP server, Graph extension, Pi extension, or prompt bundle into the capability catalog.',
      parameters: Type.Object({ id: Type.String(), kind: Type.String(), source: Type.String(), version: Type.String(), requestId: Type.String() }),
      execute: async (_id, params) => {
        const body = fields(params);
        const kind = String(body.kind);
        if (kind !== 'skill' && kind !== 'mcp' && kind !== 'extension' && kind !== 'pi-extension' && kind !== 'prompt') throw new Error('Unsupported capability kind');
        const receipt = await input.install!({ id: String(body.id), kind, source: String(body.source), version: String(body.version), requestId: String(body.requestId) });
        return text(JSON.stringify(receipt));
      },
    });
  }
  return tools;
}
