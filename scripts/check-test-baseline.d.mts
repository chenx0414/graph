export interface SuiteCounts { files: number; tests: number }
export interface BaselineResult { ok: boolean; write: boolean; message: string }
export function compareBaseline(baseline: unknown, current: SuiteCounts, update?: boolean): BaselineResult;
export function readRunReport(path?: string): SuiteCounts;
