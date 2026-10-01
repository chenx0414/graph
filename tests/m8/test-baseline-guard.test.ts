import { describe, expect, test } from 'vitest';
import { compareBaseline } from '../../scripts/check-test-baseline.mjs';

/**
 * HB-255 — the gate must not silently lose tests.
 *
 * Phase 5a (d53e1a6) committed two source files with NO tests and `node --run check`
 * still went green, because the suite only asserted "everything passed": the count
 * fell from 1622 to 1609 and nothing noticed.
 *
 * Failure modes first (R24):
 *   B1  equal or higher counts pass, and growth rewrites the baseline upward
 *   B2  a lower file or test count fails and names the delta
 *   B3  a missing baseline is written and passes (fresh checkout / first run)
 *   B4  GRAPH_UPDATE_BASELINE=1 lowers the baseline deliberately and says so
 *   B5  a malformed baseline fails loudly instead of passing
 */

describe('check-test-baseline — the gate cannot lose tests silently (HB-255)', () => {
  test('B1: growth passes and rewrites the baseline upward', () => {
    const result = compareBaseline({ files: 240, tests: 1622 }, { files: 241, tests: 1623 });
    expect(result.ok).toBe(true);
    expect(result.write).toBe(true);
    expect(result.message).toMatch(/increased|higher/);
  });

  test('B1: an unchanged count passes without rewriting', () => {
    const result = compareBaseline({ files: 241, tests: 1623 }, { files: 241, tests: 1623 });
    expect(result.ok).toBe(true);
    expect(result.write).toBe(false);
  });

  test('B2: fewer tests fails and names the missing count', () => {
    const result = compareBaseline({ files: 240, tests: 1622 }, { files: 239, tests: 1609 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/1609/);
    expect(result.message).toMatch(/1622/);
    expect(result.message).toMatch(/file/);
  });

  test('B2: a lower file count alone also fails', () => {
    const result = compareBaseline({ files: 240, tests: 1622 }, { files: 239, tests: 1622 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/file/);
  });

  test('B3: a missing baseline is written and passes', () => {
    const result = compareBaseline(null, { files: 1, tests: 1 });
    expect(result.ok).toBe(true);
    expect(result.write).toBe(true);
    expect(result.message).toMatch(/baseline/i);
  });

  test('B4: an explicit update lowers the baseline and says so', () => {
    const result = compareBaseline({ files: 240, tests: 1622 }, { files: 239, tests: 1609 }, true);
    expect(result.ok).toBe(true);
    expect(result.write).toBe(true);
    expect(result.message).toMatch(/lowered|update/i);
  });

  test('B5: a malformed baseline fails loudly', () => {
    const result = compareBaseline({ files: 'many', tests: null }, { files: 1, tests: 1 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/malformed|invalid/i);
  });
});
