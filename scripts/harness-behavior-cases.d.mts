export interface BehaviorStep {
  /** The harness rule the step relies on. */
  rule: 'read' | 'edit' | 'evidence';
  /** The tool the step uses. */
  tool: string;
  /** The arguments the tool is called with. */
  arguments: Record<string, unknown>;
}

export interface BehaviorCase {
  /** The tools that have to appear, in this order. */
  expected: string[];
  /** The tools that must not appear. */
  forbidden: string[];
  steps: BehaviorStep[];
}

export declare const behaviorCases: Record<string, BehaviorCase>;
