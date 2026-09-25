/**
 * The one rule for turning an id plus an optional version into a capability record.
 *
 * A capability that declares a package source holds whatever version the source resolved to, so a
 * caller's version is not a pin for it. Capability lookup, recipe validation and compilation all
 * share this selector, so the rule cannot drift between them again.
 */
import type { CapabilityRecord } from './capability-library.ts';

export function selectCapabilityRecord(
  records: readonly CapabilityRecord[],
  id: string,
  version?: string,
): CapabilityRecord | undefined {
  const matching = records.filter(item => item.id === id);
  if (!matching.length) return undefined;
  if (!version) return matching[matching.length - 1];
  const exact = matching.find(item => item.version === version);
  if (exact) return exact;
  const sourced = matching.filter(item => item.packageSource);
  return sourced.length ? sourced[sourced.length - 1] : undefined;
}
