/** A self-improvement receipt as the transcript shows it: the durable record of
 * one change the Agent made to itself, with the checks it ran. Kept beside the
 * transcript model rather than inside it because the card is a whole record of
 * its own, and the model is already the longest file in the console. */
import type { ConversationMessage } from '../core/conversation-projection.ts';

export type TranscriptRsi = {
  id: string;
  status: 'applied' | 'checks_failed' | 'rolled_back' | 'unavailable' | 'dry_run';
  title: string;
  problem: string;
  branch: string | null;
  commit: string | null;
  files: string[];
  validation: { command: string; status: string }[];
  restartRequired: boolean;
  activation: 'saved' | 'pending_reload' | 'active' | null;
  force: boolean;
  pendingFiles: string[];
  error?: string;
  diff?: string;
  report: string;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** The receipt a durable `rsi` message carries, in the shape the card renders. */
export function durableRsi(message: ConversationMessage): TranscriptRsi {
  const data = (message.data ?? {}) as Record<string, unknown>;
  const status = data.status === 'applied' || data.status === 'checks_failed'
    || data.status === 'rolled_back' || data.status === 'unavailable' || data.status === 'dry_run'
    ? data.status
    : 'unavailable';
  const validation = Array.isArray(data.validation)
    ? (data.validation as unknown[]).flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        return typeof record.command === 'string' && typeof record.status === 'string'
          ? [{ command: record.command, status: record.status }]
          : [];
      })
    : [];
  return {
    id: message.id,
    status,
    title: typeof data.title === 'string' && data.title ? data.title : '自我改进',
    problem: typeof data.problem === 'string' ? data.problem : '',
    branch: typeof data.branch === 'string' ? data.branch : null,
    commit: typeof data.commit === 'string' ? data.commit : null,
    files: stringArray(data.files),
    validation,
    restartRequired: data.restartRequired === true,
    activation: data.activation && typeof data.activation === 'object' && !Array.isArray(data.activation)
      && ['saved', 'pending_reload', 'active'].includes(String((data.activation as Record<string, unknown>).state))
      ? (data.activation as Record<string, unknown>).state as 'saved' | 'pending_reload' | 'active'
      : status === 'applied' ? (data.restartRequired === true ? 'pending_reload' : 'saved') : null,
    force: data.force === true,
    pendingFiles: stringArray(data.pendingFiles),
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
    ...(typeof data.diff === 'string' ? { diff: data.diff } : {}),
    report: message.text,
  };
}
