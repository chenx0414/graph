







import { useCallback,useEffect,useRef,useState } from 'react';

import { api } from './api.ts';

import { type AgentContextView } from './AgentContext.tsx';

import { ChatComposer,type ChatAttachment } from './ChatComposer.tsx';

import { attachmentPayload } from './attachments.ts';

import { ComposerTelemetry,type ComposerTelemetryView } from './ComposerTelemetry.tsx';

import { defaultThinkingOption } from './thinking-levels.ts';





import { describeQuestion } from './labels.ts';

import { QuestionReply } from './Questions.tsx';

import { ErrorBox,useAsync } from './shared.tsx';


import { Card,Empty,Icon,Pill,Spinner } from './ui.tsx';
import { ChatIntro,OnboardingSteps,StarterCards } from './chat-intro.tsx';



import { composeSlashDirective,extractSlashTargets } from './SlashCommands.tsx';
import type { Settings_,TaskSummary,TaskView } from "./app-state.tsx";

export function NewConversation({ settings, initialProjectId }: { settings: Settings_ | null; initialProjectId: string }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modelId, setModelId] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('low');
  const [modelChosen, setModelChosen] = useState(false);
  const pendingMessage = useRef<{ payload: string; requestId: string } | null>(null);
  const { data: agentContext } = useAsync(() => api<AgentContextView>('/api/agent-context'), []);

  useEffect(() => { setProjectId(initialProjectId); }, [initialProjectId]);
  // A new conversation inherits the daemon's default master model/thinking
  // unless the user picks something else before the first message.
  useEffect(() => {
    if (!settings || modelId) return;
    const selected = settings.models.find(model => model.id === settings.defaultModel) ?? settings.models[0];
    setModelId(selected?.id ?? '');
    setThinkingLevel(selected?.defaultThinkingLevel ?? defaultThinkingOption(selected?.thinkingOptions ?? []) ?? 'low');
  }, [settings, modelId]);
  const selectedModel = settings?.models.find(model => model.id === modelId);
  const telemetry: ComposerTelemetryView = {
    model: modelId || null,
    thinkingLevel,
    cacheHitRate: null,
    cachedInput: 0,
    cacheInput: 0,
    contextTokens: null,
    contextLimit: selectedModel?.contextWindow ?? null,
    contextPercent: null,
  };
  async function start() {
    if (busy) return;
    if (!text.trim() && !attachments.length) { setError('先说说你想解决什么，或添加一个附件。'); return; }
    const outgoing = composeSlashDirective(text, extractSlashTargets(
      text,
      agentContext?.tools ?? [],
      agentContext?.capabilities ?? [],
    ));
    setBusy(true);
    setError('');
    const payload = JSON.stringify({
      projectId,
      text: outgoing.trim(),
      attachments: attachmentPayload(attachments),
    });
    if (pendingMessage.current?.payload !== payload) {
      pendingMessage.current = { payload, requestId: `message-${crypto.randomUUID()}` };
    }
    try {
      const target = projectId
        ? `/api/projects/${encodeURIComponent(projectId)}/thread`
        : '/api/orchestration/global';
      const thread = await api<{ conversationId: string }>(target, {
        method: 'POST',
        body: JSON.stringify({ requestId: `open-${crypto.randomUUID()}` }),
      });
      if (modelChosen && modelId) {
        await api(`/api/conversations/${thread.conversationId}/model`, {
          method: 'POST',
          body: JSON.stringify({ model: modelId, thinkingLevel, requestId: `model-${crypto.randomUUID()}` }),
        });
      }
      await api(`/api/conversations/${thread.conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text: outgoing.trim(),
          ...(attachments.length ? { attachments: attachmentPayload(attachments) } : {}),
          requestId: pendingMessage.current.requestId,
        }),
      });
      pendingMessage.current = null;
      setText('');
      setAttachments([]);
      window.dispatchEvent(new Event('graph:conversations-changed'));
      location.hash = `#/conversations/${thread.conversationId}`;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="new-chat-page" data-testid="conversations">
      <ChatIntro title="与主 Agent 对话" body="描述你想解决的问题，主 Agent 会帮你理清思路、制定方案并协调执行。" />
      <ChatComposer
        className="new-chat-composer"
        value={text}
        onChange={setText}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        projectId={projectId || null}
        placeholder="例如：这个项目很乱，先帮我看看能从哪里改进。"
        slashTools={agentContext?.tools ?? []}
        slashCapabilities={agentContext?.capabilities ?? []}
        slashModels={settings?.models ?? []}
        slashTelemetry={telemetry}
        onSlashModelSelect={(model, level) => {
          setModelId(model.id);
          setThinkingLevel(level);
          setModelChosen(true);
        }}
        onSend={() => void start()}
        sendDisabled={busy || (!text.trim() && !attachments.length)}
        autoFocus
        inputTestId="new-conversation-input"
        sendTestId="new-conversation-start"
        attachTestId="new-conversation-attach"
        attachmentInputTestId="new-conversation-attachment-input"
        leftActions={(
          <select
            className="composer-project"
            data-testid="new-conversation-project"
            value={projectId}
            onChange={event => setProjectId(event.target.value)}
            aria-label="对话项目"
          >
            <option value="">全局主 Agent</option>
            {(settings?.projects ?? []).map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
          </select>
        )}
      />
      <div className="composer-footer new-chat-composer-footer">
        <span className="composer-note">Enter 发送，Shift + Enter 换行</span>
        <ComposerTelemetry
          telemetry={telemetry}
          models={settings?.models ?? []}
          onSelect={(model, level) => {
            setModelId(model.id);
            setThinkingLevel(level);
            setModelChosen(true);
          }}
        />
      </div>
      {error && <ErrorBox message={error} />}
      <StarterCards
        disabled={busy}
        onPick={prompt => {
          if (text.trim()) return;
          setText(prompt);
          document.querySelector<HTMLElement>('[data-testid="new-conversation-input"]')?.focus();
        }}
      />
      <OnboardingSteps />
    </section>
  );
}

export function Inbox({ tasks, onAnswered }: { tasks: TaskSummary[]; onAnswered: () => void }) {
  const pending = tasks.filter(task => (task.openQuestions ?? 0) > 0);
  const [views, setViews] = useState<Record<string, TaskView>>({});
  const [error, setError] = useState('');
  const { data: inbox, error: historyError, loading: historyLoading, reload: reloadHistory } = useAsync(() => api<{
    history: {
      id: string; taskId: string; nodeId: string; kind: string; status: string;
      data: Record<string, unknown>; answer: Record<string, unknown> | null;
      request: string; projectId: string; conversationId: string | null;
    }[];
  }>('/api/inbox'), []);
  const pendingKey = pending.map(task => `${task.id}:${task.openQuestions}`).join(',');
  const load = useCallback(async () => {
    const next: Record<string, TaskView> = {};
    for (const task of pending.slice(0, 5)) {
      try {
        next[task.id] = await api<TaskView>(`/api/tasks/${task.id}`);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
    setViews(next);
  }, [pendingKey]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="stagger" data-testid="inbox">
      {error && <ErrorBox message={error} />}
      {historyError && <ErrorBox message={historyError} />}
      {!pending.length && (
        <Card title="问题收件箱" icon="inbox">
          <Empty icon="check" title="没有待处理问题" hint={<span data-testid="inbox-empty">需要你决策或补充信息时，问题会显示在这里。</span>} />
        </Card>
      )}
      {pending.map(task => (
        <Card key={task.id} testid={`inbox-${task.id}`} icon="inbox" tone="warn"
          title={<a href={`#/tasks/${task.id}/graph`}>{task.request.slice(0, 70)}</a>}
          subtitle={`${task.projectId} · ${task.openQuestions} 个等你回答`}>
          <ul className="list">{(views[task.id]?.questions ?? []).filter(question => question.status === 'open' && (question.owner ?? 'user') === 'user').map(question => (
            <QuestionReply key={question.id} taskId={task.id} question={question} onDone={() => { void load(); void reloadHistory(); onAnswered(); }} />
          ))}</ul>
        </Card>
      ))}
      {pending.length > 5 && <p className="muted">其余 {pending.length - 5} 个任务请进入任务页处理。</p>}
      <Card title="已处理问题" icon="check" subtitle={inbox?.history.length ? `${inbox.history.length} 条历史记录` : undefined}>
        {historyLoading && <Spinner />}
        {!historyLoading && !(inbox?.history.length) && <p className="muted" data-testid="inbox-history-empty">暂无已处理问题。</p>}
        {Boolean(inbox?.history.length) && (
          <div className="question-history" data-testid="inbox-history">
            {inbox!.history.map(item => (
              <article className="question-history-item" key={item.id}>
                <div className="row">
                  <Pill tone="success">{describeQuestion(item.kind)}</Pill>
                  <a className="grow truncate" href={item.conversationId ? `#/conversations/${item.conversationId}` : `#/tasks/${item.taskId}`}>{item.request}</a>
                  <span className="faint">{item.projectId}</span>
                </div>
                {item.data.prompt ? <p className="muted">{String(item.data.prompt)}</p> : null}
                <div className="question-history-answer">
                  <strong>处理结果</strong>
                  <span>{item.answer ? JSON.stringify(item.answer) : '已处理'}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
