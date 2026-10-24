// The scripted model of a harness-obedient agent.
//
// The frozen cases are judged by a model that does not know the answers: it
// follows the harness. For every step of a case it asks two questions - does
// the harness offer the tool this step needs, and does the harness tell it how
// that tool is meant to be used - and it acts only when both are true. A
// harness that stops offering a tool, or stops saying how to use it, leaves the
// agent without a way to act, and the case fails.
//
// That is the whole point of the gate: it is the harness, not the model, that
// is under test. The model is deliberately dull so that a red verdict points
// at the harness.

import { createServer } from 'node:http';

/**
 * The harness rules a step may rely on. Each one is a line the shipped prompt
 * library really carries; a step that finds its rule missing reports it, and
 * the gate names the missing rule instead of guessing.
 */
export const BEHAVIOR_RULES = {
  read: 'Use read to examine files',
  edit: 'Use edit for precise changes',
  evidence: 'Use tool results as evidence',
};

/** The tools a step may need, by the harness rule that governs them. */
export function behaviorToolFor(rule) {
  if (rule === 'read') return 'read';
  if (rule === 'edit') return 'edit';
  return '';
}

/**
 * The prompt the harness assembled for this turn. The agent reads it the way
 * any agent does: it is told what it may use and how.
 */
export function behaviorPromptText(messages) {
  const parts = [];
  for (const message of messages ?? []) {
    if (message.role !== 'system' && message.role !== 'developer') continue;
    parts.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''));
  }
  return parts.join('\n');
}

/** The tools the harness offered for this turn. */
export function behaviorOfferedTools(body) {
  const names = [];
  for (const tool of body?.tools ?? []) {
    const name = tool?.function?.name;
    if (typeof name === 'string' && name) names.push(name);
  }
  return names;
}

/** How many steps of the case the agent already performed. */
export function behaviorStepsDone(messages) {
  let done = 0;
  for (const message of messages ?? []) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) done++;
  }
  return done;
}

/**
 * The decision for one step: the tool call to make, or why it cannot be made.
 */
export function behaviorDecision(caseScript, step, promptText, offered) {
  if (!step) return { kind: 'answer' };
  const rule = BEHAVIOR_RULES[step.rule];
  if (rule && !promptText.includes(rule)) return { kind: 'blocked', reason: `the harness no longer says "${rule}"` };
  const tool = step.tool || behaviorToolFor(step.rule);
  if (tool && !offered.includes(tool)) return { kind: 'blocked', reason: `the harness no longer offers the ${tool} tool` };
  return { kind: 'call', tool, arguments: step.arguments ?? {} };
}

/**
 * What the agent said last. When it stopped without acting, this is the
 * reason it gave, and the gate shows it: the agent says what the harness no
 * longer tells it. The words are the ones the provider sent, because a turn
 * that ends the conversation is never asked back.
 */
export function behaviorLastWords(answers) {
  for (let index = (answers?.length ?? 0) - 1; index >= 0; index--) {
    const answer = answers[index];
    if (typeof answer === 'string' && answer.trim()) return answer.trim();
  }
  return '';
}

/**
 * A provider that answers as the harness-obedient agent: one tool call per
 * case step, then a plain answer. It reads the harness's own prompt, so the
 * same case behaves differently when the harness behaves differently.
 */
export async function startBehaviorProvider(caseScript) {
  const requests = [];
  const answers = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push(body);
    const promptText = behaviorPromptText(body.messages);
    const offered = behaviorOfferedTools(body);
    const done = behaviorStepsDone(body.messages);
    const step = (caseScript.steps ?? [])[done];
    const decision = behaviorDecision(caseScript, step, promptText, offered);
    const delta = { role: 'assistant' };
    if (decision.kind === 'call') {
      delta.tool_calls = [{
        index: 0,
        id: `harness-step-${done}`,
        type: 'function',
        function: { name: decision.tool, arguments: JSON.stringify(decision.arguments) },
      }];
    } else {
      delta.content = decision.kind === 'blocked'
        ? `I cannot continue: ${decision.reason}.`
        : 'The change is in place and verified against the result I read back.';
      answers.push(delta.content);
    }
    const finishReason = decision.kind === 'call' ? 'tool_calls' : 'stop';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'response', choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    baseUrl,
    requests,
    answers,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
