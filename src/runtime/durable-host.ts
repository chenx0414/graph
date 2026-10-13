import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, configure, createRegistry, defineDoc, type AgentChange, type ConversationId, type Tx } from '@earendil-works/pi-durable';
import type { MutableModels } from 'pi-ai-v1/models';
import { openDurableStorage } from './durable-storage.ts';
import type { TaskStore } from '../core/store.ts';

const Identities = defineDoc<{ conversations: Record<string, number> }>({ kind: 'graph.identities', scope: 'session', version: 1, initial: () => ({ conversations: {} }) });
/** One Harness and one off-thread storage owner for main and every Graph node.
 * Identity creation and mapping commit together, leaving no orphan-ack window. */
export async function openDurableHost(store: TaskStore, models: MutableModels) {
  const registry = createRegistry();
  const storage = await openDurableStorage(store);
  try {
    const harness = await Harness.open(storage, { models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1024, backgroundTokens: 0 } } }, BACKGROUND_CONTEXT);
    const root = await harness.root(BACKGROUND_CONTEXT);
    return {
      harness, models, registry,
      async conversation(identity: string, agent: AgentChange, init?: (tx: Tx, id: ConversationId) => Promise<void>) {
        const id = await root.commit(async tx => {
          const index = await tx.doc(Identities);
          const existing = index.conversations[identity];
          if (existing !== undefined) return existing as ConversationId;
          const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
          await configure(tx, conversation.id, agent);
          await init?.(tx, conversation.id);
          index.conversations[identity] = conversation.id;
          return conversation.id;
        }, BACKGROUND_CONTEXT);
        const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
        if (!conversation) throw new Error('Durable conversation identity points at missing conversation');
        return conversation;
      },
      async close() { await harness.close(BACKGROUND_CONTEXT); },
    };
  } catch (error) { await storage.close(BACKGROUND_CONTEXT); throw error; }
}
export type DurableHost = Awaited<ReturnType<typeof openDurableHost>>;
