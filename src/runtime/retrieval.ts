import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../core/types.ts';
import { allowedDomain, normalizeDomains } from './domains.ts';
import type { RestrictedGate } from './restricted-process.ts';

export interface RetrievalResult {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml)|.*\+json)/;

function checkedUrl(value: string, domains: string[], unrestricted = false) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RuntimeError('retrieval_denied', `Not a valid URL: ${value}`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RuntimeError('retrieval_denied', `Only http and https retrieval is allowed: ${url.protocol}`);
  if (url.username || url.password) throw new RuntimeError('retrieval_denied', 'URLs with embedded credentials are not allowed');
  if (!unrestricted && !allowedDomain(domains, url.hostname)) throw new RuntimeError('retrieval_denied', `Host ${url.hostname} is not in the granted retrieval domains`);
  return url;
}

async function readBody(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        const keep = Math.max(0, value.byteLength - (size - maxBytes));
        text += decoder.decode(value.subarray(0, keep), { stream: true });
        truncated = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  return { text, truncated };
}

/**
 * Controlled read broker for granted retrieval domains.
 *
 * The Pi worker asks for a URL; the host validates protocol, credentials and
 * the domain allowlist before one gated request goes out. Redirects are refused
 * so a granted host cannot forward the call to an unlisted one, response types
 * are limited to textual content, and the body is bounded. Each attempt passes
 * the same send gate as model calls, so pause and budget stop the next fetch.
 */
export function createRetrievalBroker(input: { domains: string[]; gate: RestrictedGate; unrestricted?: boolean; timeoutMs?: number; maxBytes?: number }) {
  const domains = normalizeDomains(input.domains);
  return {
    domains,
    async fetch(urlText: string): Promise<RetrievalResult> {
      const url = checkedUrl(urlText, domains, input.unrestricted === true);
      const invocationId = randomUUID();
      let failure: unknown;
      let result: RetrievalResult | undefined;
      await input.gate.dispatch(invocationId, 0, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
        try {
          const response = await fetch(url, { redirect: 'error', signal: controller.signal, headers: { accept: 'text/*, application/json;q=0.9, application/xml;q=0.8' } });
          if (!response.ok) throw new RuntimeError('retrieval_failed', `Retrieval answered HTTP ${response.status}`);
          const contentType = response.headers.get('content-type') ?? '';
          if (!TEXTUAL.test(contentType)) throw new RuntimeError('retrieval_failed', `Refusing non-textual content type ${contentType || 'unknown'}`);
          const { text, truncated } = await readBody(response, input.maxBytes ?? 1_000_000);
          result = { url: url.href, status: response.status, contentType, text, truncated };
        } catch (error) {
          failure = error instanceof RuntimeError ? error : new RuntimeError('retrieval_failed', `Retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          clearTimeout(timer);
          input.gate.settle(invocationId, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        }
      });
      if (failure) throw failure;
      return result!;
    },
  };
}
