/** One unambiguous rendering for possibly multi-currency costs.
 *
 * Lives outside the React files so a plain module (the task card) can format a cost
 * without importing JSX, and so there is only ever one implementation of the wording. */
export function costText(cost: { unknown?: boolean; amounts?: Record<string, number>; amount?: number | null } | null | undefined) {
  if (!cost) return '无记录';
  const amounts = cost.amounts ?? (typeof cost.amount === 'number' ? { '': cost.amount } : {});
  const entries = Object.entries(amounts).filter(([, value]) => value !== 0 || Object.keys(amounts).length === 1);
  const body = entries.map(([currency, value]) => `${Number(value.toFixed(6))}${currency ? ` ${currency}` : ''}`).join(' + ');
  if (cost.unknown && !body) return '费用未知';
  if (cost.unknown) return `${body}（另有未知价格调用）`;
  return body || '无记录';
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
  return value.toLocaleString('en-US');
}
