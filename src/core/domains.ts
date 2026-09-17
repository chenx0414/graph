const IPV4_PART = /^\d{1,3}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function ipv4(value: string) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => IPV4_PART.test(part) && Number(part) <= 255);
}

/** Validate one capability-declared domain pattern. Wildcards are limited to a leading `*.`. */
export function normalizeDomainPattern(value: string) {
  let pattern = value.trim().toLowerCase().replace(/^\./, '');
  if (!pattern || pattern === '*' || /[\s/@:/?]/.test(pattern)) throw new Error(`Invalid domain pattern: ${value}`);
  const wildcard = pattern.startsWith('*.');
  if (wildcard) pattern = pattern.slice(2);
  if (!pattern || pattern.includes('*') || pattern.length > 253) throw new Error(`Invalid domain pattern: ${value}`);
  if (ipv4(pattern)) {
    if (wildcard) throw new Error(`IPv4 addresses cannot use a wildcard: ${value}`);
    return pattern;
  }
  if (wildcard && !pattern.includes('.')) throw new Error(`Wildcard domain is too broad: ${value}`);
  if (!wildcard && pattern !== 'localhost' && !pattern.includes('.')) throw new Error(`Invalid domain pattern: ${value}`);
  const labels = pattern.split('.');
  if (labels.some(label => !LABEL.test(label))) throw new Error(`Invalid domain pattern: ${value}`);
  return wildcard ? `*.${pattern}` : pattern;
}

/** Lowercase, dedupe and strip leading dots from granted domain entries. */
export function normalizeDomains(domains: string[] | undefined) {
  return [...new Set((domains ?? []).map(domain => domain.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))];
}

/** A granted domain matches itself and any subdomain; `*.example.com` matches subdomains only. */
export function allowedDomain(domains: string[], hostname: string) {
  const host = hostname.toLowerCase();
  return domains.some(domain => {
    if (domain.startsWith('*.')) {
      const base = domain.slice(2);
      return base.length > 0 && host.endsWith(`.${base}`);
    }
    return host === domain || host.endsWith(`.${domain}`);
  });
}
