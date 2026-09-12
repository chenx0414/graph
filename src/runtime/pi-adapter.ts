import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Catalog } from '../catalog/catalog.ts';
import type { ModelEntry } from '../catalog/models.ts';
import { RuntimeError, type ActionAdapter, type Json, type NodeSpec, type Proposal } from '../core/types.ts';
import type { TaskStore } from '../core/store.ts';
import { agentTools } from './agent-tools.ts';
import { loadCapabilities, type CapabilityPermissionRequest } from './capabilities.ts';
import { controlledOpenAIStream } from './controlled-openai.ts';
import { openPiInstance } from './pi-instance.ts';
import { createRetrievalBroker } from './retrieval.ts';
import { taskGate } from './task-gate.ts';
import { openWorkspaceCommandRunner } from './workspace-command.ts';

export interface PiAdapterChannels {
  supervisor: (taskId: string) => {
    propose(proposal: Proposal, requestId: string): Promise<unknown>;
    revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; requestId: string }): Promise<unknown>;
  };
  catalog: Catalog;
  install: (input: { id: string; kind: 'skill' | 'mcp' | 'extension'; source: string; version: string; requestId: string }) => Promise<unknown>;
}

function toPiModel(entry: ModelEntry): Model<'openai-completions'> {
  return {
    id: entry.id, name: entry.id, provider: entry.provider, api: 'openai-completions', baseUrl: entry.baseUrl,
    reasoning: false, input: ['text'], contextWindow: entry.contextWindow, maxTokens: entry.maxTokens,
    // Pi's Model.cost is required numeric metadata; Graph billing uses catalog cost, never this placeholder.
    cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function assistantText(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: { type: string; text?: string }[] };
    if (message.role === 'assistant') return message.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('') ?? '';
  }
  return '';
}

// One Pi operation is a whole session of provider calls, not a single request.
// This bound covers a long planning or coding session while still stopping a
// runaway loop for user acknowledgement inside the 20M instance budget.
const PI_SESSION_RESERVE = 2_000_000;

/** Production Agent adapter: one Task Runtime operation opens a restored Pi instance and sends one prompt. */
export function createPiAdapter(options: {
  store: TaskStore;
  instancesDir: string;
  catalog: Catalog;
  directory: () => ModelEntry[];
  apiKey: string;
  modelRuntime: ModelRuntime;
  network?: { retrievalDomains?: string[]; mcpDomains?: string[] };
  channels?: PiAdapterChannels;
}): ActionAdapter {
  return {
    kind: 'agent',
    reserveTokens: PI_SESSION_RESERVE,
    prepare: async operation => {
      if (!operation.instanceId) throw new RuntimeError('invalid_adapter', 'Agents require an instance');
      const instance = options.store.db.prepare('SELECT definition_version,model FROM instances WHERE id=?').get(operation.instanceId) as { definition_version: string | null; model: string | null };
      const entry = options.directory().find(model => model.id === instance.model);
      if (!entry) throw new RuntimeError('model_unavailable', 'No configured model for this instance');
      const task = options.store.task(operation.taskId);
      const project = options.store.db.prepare('SELECT root FROM projects WHERE id=?').get(task.project_id) as { root: string };
      const definitionVersion = instance.definition_version ?? 'unknown@1';
      return async () => {
        const gate = taskGate(options.store, { id: operation.id, taskId: operation.taskId, instanceId: operation.instanceId!, nodeId: operation.nodeId }, entry);
        const spec = JSON.parse((options.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, operation.nodeId) as { spec: string }).spec) as NodeSpec;
        const workspace = await realpath(operation.workspace ?? project.root);
        let submitted: Json | undefined;
        let permissionRequest: CapabilityPermissionRequest | undefined;
        const channels = options.channels;
        let capabilities: Awaited<ReturnType<typeof loadCapabilities>>;
        let commands: Awaited<ReturnType<typeof openWorkspaceCommandRunner>>;
        const retrieval = options.network?.retrievalDomains?.length
          ? createRetrievalBroker({ domains: options.network.retrievalDomains, gate })
          : undefined;
        try {
          capabilities = await loadCapabilities({
            catalog: options.catalog,
            ...(instance.definition_version ? { definitionVersion: instance.definition_version } : {}),
            workspace, scratchDir: join(options.instancesDir, operation.instanceId!, 'capability-scratch'), gate,
            ...(options.network?.mcpDomains?.length ? { mcpDomains: options.network.mcpDomains } : {}),
            grants: operation.grants,
            onPermissionRequired: request => { permissionRequest ??= request; },
          });
          commands = await openWorkspaceCommandRunner({ workspace, scratchDir: join(options.instancesDir, operation.instanceId!, 'command-scratch'), gate });
        } catch (error) {
          // A missing or unsupported bound capability stops this node with a concrete
          // reason instead of silently running without the definition's capabilities.
          return { outcome: 'failed', output: { setupError: String(error) }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        }
        const tools = [
          ...agentTools({
            workspace, ...(spec.role ? { role: spec.role } : {}),
            ...(capabilities.readRoots.length ? { readRoots: capabilities.readRoots } : {}),
            run: (command, args) => commands.run(command, args),
            ...(retrieval ? { fetch: (url: string) => retrieval.fetch(url) } : {}),
            ...(channels ? { supervisor: channels.supervisor(operation.taskId), catalog: channels.catalog, install: channels.install } : {}),
            onSubmit: output => { submitted = output; },
          }),
          ...capabilities.tools,
        ];
        try {
          const session = await openPiInstance({
            binding: { instanceId: operation.instanceId!, nodeId: operation.nodeId, definitionVersion },
            workspace, stateDir: join(options.instancesDir, operation.instanceId!),
            model: toPiModel(entry), modelRuntime: options.modelRuntime, stream: controlledOpenAIStream(gate, options.apiKey),
            tools, ...(capabilities.skillPaths.length ? { skillPaths: capabilities.skillPaths } : {}), broker: gate,
          });
          try {
            const briefing = operation.context.briefing ?? `Continue work for ${operation.nodeId}`;
            // Order matches the harness directory: implementation first, independent review second.
            const models = options.directory().map((entry, index) => `${index === 0 ? 'implementation' : 'review'}=${entry.id} (${entry.grade})`).join(', ');
            const hint = spec.role === 'master'
              ? [
                  '\nUse propose_graph to submit a validated task graph. Program nodes may use graph.command with input {"command":"...","args":[...]} for allowed build/test commands (including a headless browser test), graph.verify for independent review, and graph.human_check for user checks. Use workspace tools to inspect the project.',
                  `Configured models: ${models || '(none)'}. Implementation nodes must use the implementation model and review nodes must use the review model, both from the briefing catalog (for example coder@1, reviewer@1).`,
                  'proposalJson schema:',
                  `{"requirementVersion": ${operation.requirementVersion}, "summary": "<one line>",`,
                  ' "acceptance": [{"id":"a1","description":"...","checkNode":"<mandatory program node id>"}],',
                  ' "nodes": [',
                  '  {"id":"work","kind":"agent","action":"work","definitionVersion":"coder@1","model":"<one of the configured models>"},',
                  '  {"id":"check","kind":"program","action":"graph.command","dependsOn":["work"],"input":{"command":"node","args":["--test","test/example.test.js"]}},',
                  '  {"id":"review","kind":"agent","action":"review","definitionVersion":"reviewer@1","model":"<a different configured model>"},',
                  '  {"id":"review-gate","kind":"program","action":"graph.verify","dependsOn":["review"],"verifier":{"kind":"independent","reportNodes":["review"]}},',
                  '  {"id":"login","kind":"program","action":"graph.human_check","dependsOn":["review-gate"]}],',
                  ' "loops": [{"from":"check","to":"work"}]}',
                ].join('\n')
              : `\nUse workspace tools to read and edit files. Submit structured output with submit_result when required. Start writing implementation files early and keep each turn short instead of exploring or reasoning at length; the task graph lists the exact check inputs that must exist. run_command is not a shell: it only accepts node (without inline evaluation) and read-only git status/diff/log/show.${retrieval ? ' The fetch tool reads HTTP documents from granted domains.' : ''}`;
            await session.prompt(`${briefing}${hint}`);
            if (permissionRequest) {
              return {
                outcome: 'waiting', output: { permission: { grant: permissionRequest.grant, capabilityId: permissionRequest.capabilityId, tool: permissionRequest.tool } },
                question: { prompt: `Remote MCP tool ${permissionRequest.tool} requires the user grant ${permissionRequest.grant} in this task`, grant: permissionRequest.grant },
                usage: gate.total(),
              };
            }
            const text = assistantText(session.inspect().messages);
            return { outcome: 'completed', output: (submitted ?? { text }) as Json, usage: gate.total() };
          } finally { await session.close(); }
        } finally { await capabilities.close(); await commands.close(); }
      };
    },
  };
}
