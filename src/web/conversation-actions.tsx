import type { Dispatch, SetStateAction } from 'react';
import type { useTranscriptFollow } from './use-transcript-follow.ts';
import type { composerPrimaryState } from './composer-state.ts';
import {
type ConversationMessage
} from '../core/conversation-projection.ts';
import { type AgentContextView } from './AgentContext.tsx';
import { api } from './api.ts';
import { attachmentPayload } from './attachments.ts';
import { type ChatAttachment } from './ChatComposer.tsx';
import { type ThinkingLevel } from './ComposerTelemetry.tsx';
import './conversation-drawer.css';
import { composeSlashDirective,extractSlashTargets } from './SlashCommands.tsx';
import { toast } from './ui.tsx';

export function conversationActions({ setActionError, reload, onChanged, pauseAction, setPauseAction, id, setPausedOverride, text, agentContext, attachments, setText, setAttachments, setSending, transcriptFollow, steering, interrupting, queuedMessages, setSteering, sending, busy, promptSuggestion, primaryState, hasComposerInput, setDismissedQueue }: {
setActionError: Dispatch<SetStateAction<string>>;
reload: () => void;
onChanged: (() => void) | undefined;
pauseAction: "pause" | "resume" | null;
setPauseAction: Dispatch<SetStateAction<"pause" | "resume" | null>>;
id: string;
setPausedOverride: Dispatch<SetStateAction<boolean | null>>;
text: string;
agentContext: AgentContextView | null;
attachments: ChatAttachment[];
setText: Dispatch<SetStateAction<string>>;
setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
setSending: Dispatch<SetStateAction<boolean>>;
transcriptFollow: ReturnType<typeof useTranscriptFollow>;
steering: boolean;
interrupting: boolean;
queuedMessages: ConversationMessage[];
setSteering: Dispatch<SetStateAction<boolean>>;
sending: boolean;
busy: boolean;
promptSuggestion: string | null;
primaryState: ReturnType<typeof composerPrimaryState>;
hasComposerInput: boolean;
setDismissedQueue: Dispatch<SetStateAction<string[]>>;
}) {
async function act(action: () => Promise<unknown>, after?: () => void) {
    setActionError('');
    try { await action(); after?.(); reload(); onChanged?.(); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function changePaused(nextPaused: boolean) {
    if (pauseAction) return;
    const action = nextPaused ? 'pause' : 'resume';
    setPauseAction(action);
    setActionError('');
    try {
      await api(`/api/conversations/${id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ requestId: crypto.randomUUID() }),
      });
      setPausedOverride(nextPaused);
      toast(
        nextPaused
          ? '主 Agent 对话已暂停：正在跑的回合会在当前工具调用收尾后停下，不再发起新的模型请求；新消息会保留并排队。'
          : '主 Agent 对话已继续：会接着跑刚才被停下的那个回合，排队消息随后按序处理。',
        nextPaused ? 'info' : 'success',
      );
      reload();
      onChanged?.();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      toast(message, 'danger');
    } finally {
      setPauseAction(null);
    }
  }
  async function send(outgoingOverride?: string): Promise<boolean> {
    const rawOutgoing = (outgoingOverride ?? text).trim();
    const outgoing = composeSlashDirective(rawOutgoing, extractSlashTargets(
      rawOutgoing,
      agentContext?.tools ?? [],
      agentContext?.capabilities ?? [],
    ));
    const outgoingAttachments = outgoingOverride === undefined ? attachments : [];
    if (!outgoing && !outgoingAttachments.length) return false;
    setText('');
    setAttachments([]);
    setSending(true);
    setActionError('');
    try {
      await api(`/api/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: outgoing, attachments: attachmentPayload(outgoingAttachments), requestId: `msg-${crypto.randomUUID()}` }),
      });
      transcriptFollow.scrollToLatest('smooth');
      reload();
      onChanged?.();
      return true;
    } catch (reason) {
      setText(current => current || rawOutgoing);
      setAttachments(current => current.length ? current : outgoingAttachments);
      setActionError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setSending(false);
    }
  }
  async function steerQueued() {
    if (steering || interrupting || !queuedMessages.length) return;
    setSteering(true);
    setActionError('');
    try {
      const result = await api<{ state: 'empty' | 'queued' | 'steered'; steered: number }>(`/api/conversations/${id}/steer`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `steer-${crypto.randomUUID()}` }),
      });
      if (result.state === 'steered') toast(`已将 ${result.steered} 条队列消息作为打断引导发送给主 Agent。`, 'success');
      else if (result.state === 'queued') toast('当前回复已经结束，队列消息会作为下一轮继续处理。', 'info');
      reload();
      onChanged?.();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      toast(message, 'danger');
    } finally {
      setSteering(false);
    }
  }
  async function submitEnter() {
    if (sending || steering || interrupting) return;
    if (text.trim() || attachments.length) return send();
    if (busy && queuedMessages.length) return steerQueued();
    if (!busy && promptSuggestion) return send(promptSuggestion);
  }

  async function submitPrimary() {
    if (sending || steering || interrupting || pauseAction) return;
    const action = primaryState.action;
    if (action === 'pause') { await changePaused(true); return; }
    if (action === 'resume') { await changePaused(false); return; }
    if (action === 'send-and-resume') {
      if (hasComposerInput && !(await send())) return;
      await changePaused(false);
      return;
    }
    if (action === 'send') { await send(); return; }
    if (action === 'steer') { await steerQueued(); return; }
    if (action === 'suggestion') { if (promptSuggestion) await send(promptSuggestion); return; }
  }

  async function cancelQueued(messageId: string) {
    setActionError('');
    setDismissedQueue(current => current.includes(messageId) ? current : [...current, messageId]);
    try {
      await api(`/api/conversations/${id}/messages/${encodeURIComponent(messageId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `cancel-${crypto.randomUUID()}` }),
      });
      reload();
      onChanged?.();
    } catch (reason) {
      setDismissedQueue(current => current.filter(id => id !== messageId));
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      toast(message, 'danger');
    }
  }

  async function selectMasterModel(model: { id: string }, thinkingLevel: ThinkingLevel) {
    await api(`/api/conversations/${id}/model`, {
      method: 'POST',
      body: JSON.stringify({
        model: model.id,
        thinkingLevel,
        requestId: `model-${crypto.randomUUID()}`,
      }),
    });
    reload();
    onChanged?.();
  }

  async function compactConversation() {
    await api(`/api/conversations/${id}/compact`, {
      method: 'POST',
      body: JSON.stringify({ requestId: `compact-${crypto.randomUUID()}` }),
    });
    toast(
      busy ? '压缩请求已排队；主 Agent 完成当前轮后会执行。' : '已请求压缩当前会话上下文。',
      'success',
    );
    reload();
    onChanged?.();
  }
return { act, changePaused, send, steerQueued, submitEnter, submitPrimary, cancelQueued, selectMasterModel, compactConversation };
}
