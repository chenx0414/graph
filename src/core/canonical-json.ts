import { RuntimeError } from './types.ts';

export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === 'object' && item) {
      return Object.fromEntries(Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, normalize((item as Record<string, unknown>)[key])]));
    }
    throw new RuntimeError('invalid_input', 'Expected JSON data');
  };
  return JSON.stringify(normalize(value));
}
