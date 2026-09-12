/** Lowercase, dedupe and strip leading dots from granted domain entries. */
export function normalizeDomains(domains: string[] | undefined) {
  return [...new Set((domains ?? []).map(domain => domain.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))];
}

/** A granted domain matches itself and any subdomain. */
export function allowedDomain(domains: string[], hostname: string) {
  const host = hostname.toLowerCase();
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}
