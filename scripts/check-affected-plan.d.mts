export interface CheckPlan {
  label: string;
  files: string[];
}

export interface CheckPlanInput {
  changed: string[];
  exists?: (path: string) => boolean;
  forced?: boolean;
  storeKeeper?: string;
}

export declare const WEB: string[];
export declare const STORE: RegExp;
export declare const STORE_KEEPER: string;
export declare function selectCheckPlan(input: CheckPlanInput): CheckPlan;
