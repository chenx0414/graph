import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Model contract check for the real M7 acceptance.
 *
 * Run this once after configuring the two model ids. It sends exactly one small
 * chat-completions request per model and records what the endpoint actually
 * answered: reported model name, text, usage fields and latency. Use the result
 * to judge whether the implementation and review models are real and distinct
 * before the full A13 run; two different aliases alone do not prove different
 * backends.
 *
 * Environment:
 *   GRAPH_M7_MODEL_ID / GRAPH_M7_MODEL_BASE_URL / GRAPH_M7_MODEL_API_KEY
 *   GRAPH_M7_REVIEW_MODEL_ID
 * Optional:
 *   GRAPH_M7_WORKDIR (default ../graph-m7-acceptance)
 *   GRAPH_M7_CONTRACT_REPORT (default <workdir>/contract-report.json)
 *
 * Exit codes: 0 both models answered with usable usage, 1 a model failed,
 * 2 configuration is missing. This check is not part of the automated suite.
 */
function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; see examples/m7-contract.ts for the accepted variables`);
  return value;
}

interface Check {
  id: string;
  status: number;
  reportedModel: string | null;
  content: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  latencyMs: number;
  ok: boolean;
  problems: string[];
}

async function checkModel(baseUrl: string, apiKey: string, id: string): Promise<Check> {
  const problems: string[] = [];
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let status = 0;
  let reportedModel: string | null = null;
  let content = '';
  let usage: Check['usage'] = null;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Reply with the single word ready.' }], max_tokens: 16, stream: false }),
    });
    status = response.status;
    const text = await response.text();
    if (text.length > 1_000_000) problems.push('response exceeded the size bound');
    const body = JSON.parse(text) as {
      model?: unknown; error?: { message?: unknown };
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
    };
    if (!response.ok) problems.push(`HTTP ${response.status}: ${String(body.error?.message ?? text.slice(0, 200))}`);
    if (typeof body.model === 'string') reportedModel = body.model;
    if (typeof body.choices?.[0]?.message?.content === 'string') content = body.choices[0].message.content;
    const prompt = body.usage?.prompt_tokens;
    const completion = body.usage?.completion_tokens;
    const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    if ([prompt, completion, cached].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) && typeof cached === 'number' && typeof prompt === 'number') {
      if (cached > prompt) problems.push('cached tokens exceed prompt tokens');
      usage = { input: (prompt as number) - cached, output: completion as number, cacheRead: cached, cacheWrite: 0 };
    } else if (response.ok) {
      problems.push('usage fields are missing or not integers');
    }
    if (!content.trim()) problems.push('empty completion text');
  } catch (error) {
    problems.push(`request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally { clearTimeout(timer); }
  return { id, status, reportedModel, content, usage, latencyMs: Date.now() - started, ok: problems.length === 0, problems };
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
  const sameReportedModel = Boolean(checks[0]!.reportedModel && checks[0]!.reportedModel === checks[1]!.reportedModel);
  const report = {
    baseUrl,
    checks: checks.map(check => ({ ...check, content: check.content.slice(0, 200) })),
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
