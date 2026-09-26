/**
 * Promoting a project skill into the capability library.
 *
 * A skill that proved itself in one project is worth reusing elsewhere, but the library is a different
 * kind of store: entries are versioned by content digest, carry a manifest, and are only active once a
 * recipe references them. Promotion therefore copies and declares — it never binds, because binding is
 * the user's decision.
 */

export interface PromotionResult {
  promoted: { id: string; version: string; path: string; replaced: boolean };
  bindHint: string;
}

export function promoteProjectSkill(input: {
  projectRoot: string;
  skillId: string;
  capabilityRoot: string;
}): PromotionResult {
  void input;
  throw new Error('not implemented');
}
