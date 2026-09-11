import { join } from 'node:path';
import type { Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Catalog } from '../catalog/catalog.ts';
import type { ModelEntry } from '../catalog/models.ts';
import { RuntimeError, type ActionAdapter, type Json } from '../core/types.ts';
import type { TaskStore } from '../core/store.ts';
import { controlledOpenAIStream } from './controlled-openai.ts';
import { openPiInstance } from './pi-instance.ts';
import { taskGate } from './task-gate.ts';

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

/** Production Agent adapter: one Task Runtime operation opens a restored Pi instance and sends one prompt. */
export function createPiAdapter(options: {
  store: TaskStore;
  instancesDir: string;
  catalog: Catalog;
  directory: () => ModelEntry[];
  apiKey: string;
  modelRuntime: ModelRuntime;
}): ActionAdapter {
  return {
    kind: 'agent',
    reserveTokens: 40_000,
    prepare: async operation => {
      if (!operation.instanceId) throw new RuntimeError('invalid_adapter', 'Agents require an instance');
      const instance = options.store.db.prepare('SELECT definition_version,model FROM instances WHERE id=?').get(operation.instanceId) as { definition_version: string | null; model: string | null };
      const entry = options.directory().find(model => model.id === instance.model);
      if (!entry) throw new RuntimeError('model_unavailable', 'No configured model for this instance');
      const task = options.store.task(operation.taskId);
      const project = options.store.db.prepare('SELECT root FROM projects WHERE id=?').get(task.project_id) as { root: string };
      const definitionVersion = instance.definition_version ?? 'unknown@1';
      return async () => {
        const gate = taskGate(options.store, { id: operation.id, taskId: operation.taskId, instanceId: operation.instanceId! }, entry);
        const session = await openPiInstance({
          binding: { instanceId: operation.instanceId!, nodeId: operation.nodeId, definitionVersion },
          workspace: operation.workspace ?? project.root, stateDir: join(options.instancesDir, operation.instanceId!),
          model: toPiModel(entry), modelRuntime: options.modelRuntime, stream: controlledOpenAIStream(gate, options.apiKey),
        });
        try {
          await session.prompt(operation.context.briefing ?? `Continue work for ${operation.nodeId}`);
          const text = assistantText(session.inspect().messages);
          return { outcome: 'completed', output: { text } as Json, usage: gate.total() };
        } finally { await session.close(); }
      };
    },
  };
}
