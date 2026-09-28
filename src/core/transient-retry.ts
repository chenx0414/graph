import { isEnvironmentFailure } from './environment-failure.ts';

/**
 * Whether a node execution failure retries itself or wakes the main Agent.
 *
 * The real ledger made the case: `execution_failed` was answered 105 times, every answer was
 * `retry`, and about 101 of those were a blip the harness could have absorbed by itself. So a
 * failure the environment caused is retried here, with a bound, and only a verdict — or a bound
 * that ran out — reaches main.
 *
 * The bound is what keeps this from being a loop: a permanently broken endpoint still ends up in
 * front of main, and it says the bound ran out instead of inviting another blind retry.
 */
export const MAX_TRANSIENT_RETRIES = 2;

export interface RetryDecision {
  retry: boolean;
  /** The attempt this failure was, and the one a retry would be. */
  attempt: number;
  /** Why main is woken, or why the harness retries. Never empty: a failure is always explained. */
  reason: string;
  /** True when the only thing left to do was wake main because the bound ran out. */
  exhausted: boolean;
}

/**
 * `attempt` is 1 for the first failure. A transient failure up to MAX_TRANSIENT_RETRIES retries
 * itself; anything else — a verdict, an unexplained failure, or an exhausted bound — wakes main.
 */
export function retryDecision(input: { output: string; attempt: number }): RetryDecision {
  const attempt = Math.max(1, Math.floor(input.attempt));
  if (!input.output.trim()) {
    // Silence is not a blip: without a reason to believe a rerun differs, retrying is a guess.
    return { retry: false, attempt, reason: '节点失败但没有输出，无法判断是否为环境问题，交 main 诊断。', exhausted: false };
  }
  if (!isEnvironmentFailure(input.output)) {
    return { retry: false, attempt, reason: '这是对代码/结果的判断，不是环境问题；重试不会有不同结论，交 main 处理。', exhausted: false };
  }
  if (attempt > MAX_TRANSIENT_RETRIES) {
    return {
      retry: false,
      attempt,
      exhausted: true,
      reason: `环境问题已自动重试 ${MAX_TRANSIENT_RETRIES} 次仍未成功（第 ${attempt} 次失败），交 main 处理。`,
    };
  }
  return {
    retry: true,
    attempt,
    exhausted: false,
    reason: `环境问题（网络/限流/上游），harness 自动重试第 ${attempt} 次（上限 ${MAX_TRANSIENT_RETRIES}）。`,
  };
}
