export declare const EXPLAIN_BUDGET_PER_FILE: number
export declare const TOTAL_BUDGET: number
export declare function isDirective(text: string): boolean
export declare function scanText(text: string, lang: string): { directive: number; explanatory: number; lines: number }
export declare function scanRepo(root?: string): Array<{ path: string; directive: number; explanatory: number }>
export declare function compareExplanatory(before: string, after: string, lang: string): 'ok' | 'added'
