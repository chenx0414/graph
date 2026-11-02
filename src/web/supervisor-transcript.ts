import {
  conversationProjectionSnapshot,
  type ConversationHistoryRequest,
  type ConversationMessage,
  type ConversationProjectionState,
} from '../core/conversation-projection.ts';
import { visibleTranscriptMessages } from './composer-state.ts';
import { buildTranscriptRows, type TranscriptRow } from './transcript-model.ts';

/** What the supervisor thread shows. Streaming order and the activity fold stay behind this record. */
export interface SupervisorTranscript {
  /** Durable messages the thread and the composer history read. Cancelled user messages are already absent. Queued messages are listed separately. */
  messages: ConversationMessage[];
  queuedMessages: ConversationMessage[];
  rows: TranscriptRow[];
  promptSuggestion: string;
  streamNeedsResync: boolean;
  historyRequest: ConversationHistoryRequest | null;
}

/** Fold one supervisor projection into the picture the thread renders. */
export function supervisorTranscript(
  state: ConversationProjectionState,
  input: {
    busy: boolean;
    continuations?: { operationId: string; resumedOperationId: string | null }[];
  },
): SupervisorTranscript {
  const snapshot = conversationProjectionSnapshot(state, { busy: input.busy });
  const messages = visibleTranscriptMessages(snapshot.messages);
  return {
    messages,
    queuedMessages: snapshot.queuedMessages,
    rows: buildTranscriptRows({
      messages,
      continuations: input.continuations ?? [],
      liveTools: snapshot.liveTools,
      streaming: snapshot.streaming,
      busy: input.busy,
    }),
    promptSuggestion: snapshot.promptSuggestion,
    streamNeedsResync: snapshot.streamNeedsResync,
    historyRequest: snapshot.historyRequest,
  };
}
