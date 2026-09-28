/**
 * How far a subagent may reach when it talks to another Agent.
 *
 * The user's decision: subagents of one graph talk to each other, and to nobody else. That one
 * constraint does the job the removed chain/ceiling guards used to do — a subagent cannot command
 * another graph because it cannot name one. Main is not narrowed here: it reaches any conversation
 * legitimately, and its own guard lives in `conversation-tools.ts`.
 */

export interface SameGraphReachAttempt {
  /** The graph task the speaking node belongs to. */
  callerTask: string;
  /** The node that is speaking. */
  callerNode: string;
  /** The task the target node belongs to. */
  targetTask: string;
  /** The node being addressed. */
  targetNode: string;
  /** The target task's nodes, when the caller supplied them, so a typo is caught rather than sent. */
  knownNodes?: readonly string[];
  /** Existing task ids, when the caller supplied them. */
  knownTasks?: readonly string[];
}

/** Why this reach is refused, or null when the peer is in the same graph. */
export function sameGraphReach(attempt: SameGraphReachAttempt): string | null {
  if (attempt.knownTasks && !attempt.knownTasks.includes(attempt.targetTask)) {
    return `没有这个任务：${attempt.targetTask}。`;
  }
  if (attempt.targetTask !== attempt.callerTask) {
    // This is the constraint, not a courtesy: naming another graph is exactly what a subagent may
    // not do, and saying why keeps the model from retrying the same call.
    return 'subagent 只能和同一张图里的节点通信：跨图请把结果回报给 main。';
  }
  if (attempt.targetNode === attempt.callerNode) {
    return '这是你自己的节点：结果直接写进交付，不要发消息给自己。';
  }
  if (attempt.knownNodes && !attempt.knownNodes.includes(attempt.targetNode)) {
    return `这张图里没有节点 ${attempt.targetNode}。`;
  }
  return null;
}
