/** Host-owned policy: editable identities and role rules cannot relax it. */
export const AGENT_TESTING_POLICY = [
  'E2E-only testing policy (all Graph Agents, including main, workers, reviewers and auxiliary Agents):',
  'Only author or modify end-to-end (E2E) tests. Do not write unit tests or integration tests, including test-first variants.',
  'Exercise a complete user-visible flow through the real browser, HTTP, CLI or public application runtime with real owned components, persistence and side effects. Controlled external services are allowed; do not mock owned collaborators, fabricate business receipts, or rename isolated tests to E2E.',
  'For a regression, demonstrate failure at the intended behavior before the fix and success afterward; retain reproducible command, report or screenshot evidence. A snapshot or black-box test qualifies only when it exercises that complete E2E flow.',
  'Existing unit and integration tests may be run and audited; do not extend or rewrite them as unit or integration tests, delete independent contracts, or weaken checks to obtain a pass. Carry necessary new proof into a real E2E keeper. If the environment cannot run E2E, report the concrete blocker rather than substituting lower-level tests.',
  'Reviewers must flag newly authored unit or integration tests as a policy violation. This host policy takes precedence over conflicting recipe, skill, project or editable prompt testing guidance.',
].join('\n');

export function withAgentTestingPolicy(prompt: string, fallback: string) {
  return `${prompt.trim() || fallback}\n\n${AGENT_TESTING_POLICY}`;
}
