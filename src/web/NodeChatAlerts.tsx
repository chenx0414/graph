import { QuestionReply } from './Questions.tsx';
import { Icon } from './ui.tsx';

/** One question a node is waiting on, as the run view reports it. */
export type NodeQuestion = {
  id: string;
  kind: string;
  data?: Record<string, unknown>;
};

/** The questions still waiting for an answer. A node run reports every question
 * it ever raised, answered ones included, and only the open ones are a thing the
 * reader can act on. */
export function openNodeQuestions(questions: unknown[]): NodeQuestion[] {
  return questions.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.kind !== 'string') return [];
    if (record.status !== undefined && record.status !== 'open') return [];
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : {};
    return [{ id: record.id, kind: record.kind, data }];
  });
}

/**
 * The questions a node is blocked on, answered in place.
 *
 * It is the same `QuestionReply` the main conversation uses, with the same
 * section classes: a node asking for a decision is the conversation asking for
 * one, and two different renderings of the same question is how a reader learns
 * to distrust one of them.
 */
export function NodeChatQuestions({ taskId, questions, onDone }: {
  taskId: string;
  questions: unknown[];
  onDone: () => void;
}) {
  const open = openNodeQuestions(questions);
  if (!taskId || !open.length) return null;
  return (
    <section className="conversation-question-composer" data-testid="node-chat-questions" aria-label="等待你确认">
      <ul className="list">
        {open.map(question => (
          <QuestionReply key={question.id} taskId={taskId} question={{ id: question.id, kind: question.kind, data: question.data ?? {} }} onDone={onDone} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The messages the reader typed while this node was busy, in the order the node
 * will take them. The main conversation shows its queue the same way; without
 * it, a second message looks like it vanished.
 */
export function NodeChatPending({ taskId, questions, queued, onDone }: {
  taskId: string;
  questions: unknown[];
  queued: { seq: number; text: string }[];
  onDone: () => void;
}) {
  return (
    <>
      {queued.length > 0 && (
        <div className="queued-messages" data-testid="node-chat-queued">
          {queued.map((item, index) => (
            <div className="queued-message" data-testid="node-chat-queued-item" key={item.seq}>
              <div className="queued-message-body"><p>{item.text}</p></div>
              <span className="queued-message-order">{index + 1}</span>
            </div>
          ))}
        </div>
      )}
      <NodeChatQuestions taskId={taskId} questions={questions} onDone={onDone} />
    </>
  );
}

/**
 * The pause that stops this node's task, said the way the main conversation says
 * it: what happens to the turn in flight, and what happens to what was typed.
 */
export function NodeChatPaused() {
  return (
    <section className="conversation-alert" data-testid="node-chat-paused">
      <div className="conversation-pause-note">
        <Icon name="pause" size={15} />
        <span><strong>这个节点所在的任务已暂停。</strong> 正在跑的回合会在当前工具调用收尾后停下，不再发起新的模型请求；继续后会接着跑被停下的那个回合。</span>
      </div>
    </section>
  );
}
