import { taskCard, type CardTask, type TaskCard } from './task-card.ts';

/**
 * The end-of-task card: run time, total cost and the result, shown once per finished task.
 * It reads only the conversation view the console already polls, so it can never drift from
 * the ledger, and it renders nothing for a task that has not ended.
 */
export function TaskEndCard({ task }: { task: CardTask }) {
  const card = taskCard(task);
  if (!card) return null;
  return (
    <section
      className="task-end-card"
      data-testid="task-end-card"
      data-outcome={card.outcome}
      aria-label={`任务结束：${card.request}`}
    >
      <header className="task-end-card-head">
        <span className="task-end-card-title">{card.request}</span>
        <span className="task-end-card-outcome" data-testid="task-end-outcome">{card.outcomeLabel}</span>
      </header>
      <dl className="task-end-card-facts">
        <div>
          <dt>费用</dt>
          <dd data-testid="task-end-cost">{card.usage.costText}</dd>
        </div>
        <div>
          <dt>token</dt>
          <dd data-testid="task-end-tokens">{card.usage.tokensText}</dd>
        </div>
        <div>
          <dt>节点</dt>
          <dd data-testid="task-end-nodes">{card.nodes.map(node => `${node.id} ${node.status}`).join(' · ')}</dd>
        </div>
      </dl>
      {card.delivery && (
        <div className="task-end-card-delivery" data-testid="task-end-delivery">
          <div>交付 {card.delivery.integrationSha.slice(0, 10)}{card.delivery.targetBranch ? ` → ${card.delivery.targetBranch}` : ''}</div>
          {card.delivery.acceptance.length > 0 && (
            <div className="muted">通过验收：{card.delivery.acceptance.join('、')}</div>
          )}
        </div>
      )}
    </section>
  );
}

export type { TaskCard };
