import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Model contract check for the real M7 acceptance.
 *
 * Run this once after configuring the two model ids. It sends two small
 * chat-completions requests per model: a plain answer probe and a function
 * calling probe. The report records what the endpoint actually answered:
 * reported model name, text, reasoning presence, tool calls, usage fields and
 * latency. Use it to judge whether the implementation and review models are
 * real, distinct, and able to drive the Graph tools before the full A13 run;
 * two different aliases alone do not prove different backends.
 *
 * Environment:
 *   GRAPH_M7_MODEL_ID / GRAPH_M7_MODEL_BASE_URL / GRAPH_M7_MODEL_API_KEY
 *   GRAPH_M7_REVIEW_MODEL_ID
 * Optional:
 *   GRAPH_M7_WORKDIR (default ../graph-m7-acceptance)
 *   GRAPH_M7_CONTRACT_REPORT (default <workdir>/contract-report.json)
 *
 * Exit codes: 0 both models answered both probes with usable usage, 1 a probe
 * failed, 2 configuration is missing. This check is not part of the automated
 * suite.
 */
function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; see examples/m7-contract.ts for the accepted variables`);
  return value;
}

interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Probe {
  status: number;
  reportedModel: string | null;
  content: string;
  finishReason: string | null;
  reasoning: boolean;
  toolCalls: { name: string; arguments: string }[];
  usage: Usage | null;
  problems: string[];
}
interface Check { id: string; latencyMs: number; plain: Probe; tools: Probe; ok: boolean; problems: string[] }

type Body = {
  model?: unknown; error?: { message?: unknown };
  choices?: { message?: { content?: unknown; reasoning?: unknown; tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[] }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown }; completion_tokens_details?: { reasoning_tokens?: unknown } };
};

async function post(baseUrl: string, apiKey: string, body: unknown): Promise<{ status: number; parsed: Body; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Body = {};
    try { parsed = JSON.parse(text) as Body; }
    catch { /* a non-JSON body is reported through the status and empty fields */ }
    return { status: response.status, parsed, text };
  } finally { clearTimeout(timer); }
}

function probe(status: number, body: Body, text: string): Probe {
  const problems: string[] = [];
  const message = body.choices?.[0]?.message;
  const content = typeof message?.content === 'string' ? message.content : '';
  const finishReason = typeof body.choices?.[0]?.finish_reason === 'string' ? body.choices[0].finish_reason : null;
  const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens;
  const reasoning = Boolean(message?.reasoning) || (typeof reasoningTokens === 'number' && reasoningTokens > 0);
  const toolCalls = (Array.isArray(message?.tool_calls) ? message.tool_calls : []).map(call => ({
    name: typeof call?.function?.name === 'string' ? call.function.name : '',
    arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : '',
  }));
  const prompt = body.usage?.prompt_tokens;
  const completion = body.usage?.completion_tokens;
  const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  let usage: Usage | null = null;
  if ([prompt, completion, cached].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) && typeof prompt === 'number' && typeof completion === 'number') {
    if ((cached as number) > prompt) problems.push('cached tokens exceed prompt tokens');
    usage = { input: prompt - (cached as number), output: completion, cacheRead: cached as number, cacheWrite: 0 };
  } else if (status >= 200 && status < 300) {
    problems.push('usage fields are missing or not integers');
  }
  if (status < 200 || status >= 300) problems.push(`HTTP ${status}: ${String(body.error?.message ?? text.slice(0, 200))}`);
  return { status, reportedModel: typeof body.model === 'string' ? body.model : null, content: content.slice(0, 200), finishReason, reasoning, toolCalls, usage, problems };
}

async function checkModel(baseUrl: string, apiKey: string, id: string): Promise<Check> {
  const started = Date.now();
  const plainResponse = await post(baseUrl, apiKey, {
    model: id, messages: [{ role: 'user', content: 'Reply with the single word ready.' }], max_tokens: 256, stream: false,
  });
  const plain = probe(plainResponse.status, plainResponse.parsed, plainResponse.text);
  if (!plain.content.trim()) plain.problems.push('empty completion text');
  if (plain.finishReason === 'length') plain.problems.push('plain probe hit the output limit');
  const toolsResponse = await post(baseUrl, apiKey, {
    model: id, messages: [{ role: 'user', content: 'Use the emit_token tool with token set to ready.' }], max_tokens: 256, stream: false,
    tools: [{ type: 'function', function: { name: 'emit_token', description: 'Emit one token', parameters: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } } }],
    tool_choice: 'auto',
  });
  const tools = probe(toolsResponse.status, toolsResponse.parsed, toolsResponse.text);
  if (!tools.toolCalls.length) tools.problems.push('model did not return a tool call');
  else {
    if (tools.toolCalls[0]!.name !== 'emit_token') tools.problems.push(`unexpected tool ${tools.toolCalls[0]!.name || '(unnamed)'}`);
    try { JSON.parse(tools.toolCalls[0]!.arguments); }
    catch { tools.problems.push('tool arguments are not valid JSON'); }
  }
  const problems = [...plain.problems.map(item => `plain: ${item}`), ...tools.problems.map(item => `tools: ${item}`)];
  return { id, latencyMs: Date.now() - started, plain, tools, ok: problems.length === 0, problems };
}

async function main() {
  const baseUrl = required('GRAPH_M7_MODEL_BASE_URL');
  const apiKey = required('GRAPH_M7_MODEL_API_KEY');
  const implementationId = required('GRAPH_M7_MODEL_ID');
  const reviewId = required('GRAPH_M7_REVIEW_MODEL_ID');
  if (reviewId === implementationId) throw new Error('GRAPH_M7_REVIEW_MODEL_ID must differ from GRAPH_M7_MODEL_ID so the review is independent');
  const workDir = resolve(process.env.GRAPH_M7_WORKDIR?.trim() || join(process.cwd(), '..', 'graph-m7-acceptance'));
  const reportPath = process.env.GRAPH_M7_CONTRACT_REPORT?.trim() || join(workDir, 'contract-report.json');
  await mkdir(workDir, { recursive: true });

  const checks = [await checkModel(baseUrl, apiKey, implementationId), await checkModel(baseUrl, apiKey, reviewId)];
  const sameReportedModel = Boolean(checks[0]!.plain.reportedModel && checks[0]!.plain.reportedModel === checks[1]!.plain.reportedModel);
  const report = {
    baseUrl,
    checks,
    sameReportedModel,
    note: sameReportedModel
      ? 'Both ids report the same model name; independence of the review cannot be inferred from the aliases.'
      : 'Reported model names differ or were not echoed; judge independence from the provider configuration.',
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  return checks.every(check => check.ok) ? 0 : 1;
}

main().then(code => process.exit(code ?? 0)).catch(error => { console.error(String(error)); process.exit(2); });
