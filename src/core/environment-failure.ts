/**
 * Failures that are the environment's fault rather than a verdict on the work.
 *
 * One predicate, used by everything that has to answer "can a rerun change this?". It was written
 * for `app:build` (HB-137): a download aborted mid-way fails the build for a reason the change
 * cannot be blamed for, and the same command passes on a plain rerun once the network recovers.
 *
 * Node execution failures needed the same answer: in the real state ledger `execution_failed` was
 * answered 105 times and every answer was `retry`, with about 101 of them a network blip, a rate
 * limit or a 5xx. That is not a judgement, so it should not wake a human-facing Agent.
 *
 * A network-ish pattern only decides when the output is non-empty: a failure that said nothing is
 * unknown, and unknown is not "blip".
 */
const ENVIRONMENT_FAILURE = /aborted pending request|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo|socket hang up|SSL_ERROR|ERR_SOCKET|Client network socket disconnected|TLS connection|Connection error|at capacity due to high demand|temporarily unavailable|socket disconnected|529|rate limit/i;

/** Whether a failure looks like an environment problem rather than a verdict on the code. */
export function isEnvironmentFailure(output: string) {
  return output.trim().length > 0 && ENVIRONMENT_FAILURE.test(output);
}
