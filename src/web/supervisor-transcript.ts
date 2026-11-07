import {
  conversationProjectionSnapshot,
  type ConversationHistoryRequest,
  type ConversationMessage,
  type ConversationProjectionState,
} from '../core/conversation-projection.ts';
import { visibleTranscriptMessages } from './composer-state.ts';
import { buildTranscriptRows, type TranscriptRow } from './transcript-model.ts';

export interface SupervisorTranscript {
  messages: ConversationMessage[];
  queuedMessages: ConversationMessage[];
  rows: TranscriptRow[];
  streamNeedsResync: boolean;
  historyRequest: ConversationHistoryRequest | null;
}

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
    streamNeedsResync: snapshot.streamNeedsResync,
    historyRequest: snapshot.historyRequest,
  };
}
