import { RuntimeError, type Json } from './types.ts';
import { parseRule, mergeRuleOutputs, parseEmit, RuleError, type RuleDeclaration } from './rule-engine.ts';
import type { KernelStore } from './kernel-store.ts';
import type { GraphDefinition } from './interface-spec.ts';

/**
 * A built-in router/command module, running its declared rules (Issue #1 §2, §4, §6, §9).
 *
 * The module keeps the latest value for each named input and a small latch. Its
 * trigger policy is a declaration:
 *   - `each`  re-judges on every accepted input update, held inputs included;
 *   - `once`  fires at most once until reopened; later updates only change state.
 *
 * State lives in the SAME durable store the kernel uses: `kernel_module_inputs`
 * (latest value per input, delivered or not) and `kernel_modules`
 * (state, rule version, triggered latch). Reopening clears the latch only.
 *
 * Rules themselves never run here — this module decides WHETHER a rule set fires
 * and records WHY. The evaluation code (for a main-authored extension module) runs
 * through the isolated `evaluateModule` process; both write the same transition.
 */

export interface ModuleEvaluation {
  emitted: boolean;
  /** True when the module has not received every input a rule needs. */
  waiting: boolean;
  triggered: boolean;
  outputs: Record<string, Json>;
  reasons: string[];
}

interface CompiledModule {
  trigger: 'each' | 'once';
  requiredInputs: string[];
  rules: RuleDeclaration[];
  inputNames: string[];
  updatedAt: string;
}

export class ModuleRuntime {
  private compiled: CompiledModule | undefined;

  constructor(
    private readonly kernel: KernelStore,
    private readonly taskId: string,
    private readonly revisionVersion: number,
  ) {}

  private definition(): GraphDefinition {
    const revision = this.kernel.revision(this.taskId, this.revisionVersion);
    if (!revision) throw new RuntimeError('invalid_definition', `Unknown revision ${this.revisionVersion}`);
    return revision.definition;
  }

  /** Compile the module's rules once; a rule defect is reported, not swallowed. */
  private compile(moduleId: string): CompiledModule {
    const definition = this.definition();
    const module = definition.modules[moduleId];
    if (!module) throw new RuntimeError('invalid_definition', `Revision ${this.revisionVersion} has no module ${moduleId}`);
    const signature = JSON.stringify(module);
    if (this.compiled && this.compiled.updatedAt === signature) return this.compiled;
    const rules: RuleDeclaration[] = (module.rules ?? []).map(rule => ({
      when: parseRule(rule.when),
      emit: parseEmit(rule.emit),
      reason: rule.when,
    }));
    // §4: a once-module with several inputs must name the inputs a rule needs, so
    // a missing field can never be read as false.
    if (module.trigger === 'once' && (module.requiredInputs?.length ?? 0) === 0) {
      const referenced = new Set(rules.flatMap(rule => rule.when.referencedInputs));
      if (referenced.size > 1) {
        throw new RuntimeError('invalid_definition', `once-module ${moduleId} reads ${referenced.size} inputs but declares no requiredInputs`);
      }
    }
    this.compiled = {
      trigger: module.trigger,
      requiredInputs: module.requiredInputs ?? [],
      rules,
      inputNames: Object.keys(module.inputs),
      updatedAt: signature,
    };
    return this.compiled;
  }

  /** The current latched state of the module. */
  private latch(moduleId: string): boolean {
    const row = this.kernel.db.prepare('SELECT triggered FROM kernel_modules WHERE task_id=? AND module_id=?').get(this.taskId, moduleId) as { triggered: number } | undefined;
    return row?.triggered === 1;
  }

  private ruleVersion(moduleId: string): number {
    const row = this.kernel.db.prepare('SELECT rule_version FROM kernel_modules WHERE task_id=? AND module_id=?').get(this.taskId, moduleId) as { rule_version: number } | undefined;
    return row?.rule_version ?? 1;
  }

  private environment(moduleId: string, compiled: CompiledModule): { inputs: Record<string, Json>; state: Json } {
    const inputs: Record<string, Json> = {};
    for (const name of compiled.inputNames) {
      const row = this.kernel.moduleInput(this.taskId, moduleId, name);
      if (row?.delivered) inputs[name] = row.value;
    }
    const stateRow = this.kernel.db.prepare('SELECT state FROM kernel_modules WHERE task_id=? AND module_id=?').get(this.taskId, moduleId) as { state: string } | undefined;
    return { inputs, state: stateRow ? JSON.parse(stateRow.state) as Json : null };
  }

  /** Accept one input update and judge (§2): `each` every time, `once` until latched. */
  deliver(moduleId: string, inputName: string, value: Json): ModuleEvaluation {
    // §9: the latest value is stored FIRST and the module is paused on a defect,
    // so a rule that cannot even be parsed keeps the input rather than losing it.
    const definition = this.definition();
    const module = definition.modules[moduleId];
    if (!module) throw new RuntimeError('invalid_definition', `Revision ${this.revisionVersion} has no module ${moduleId}`);
    if (!Object.keys(module.inputs).includes(inputName)) {
      throw new RuntimeError('invalid_input', `Module ${moduleId} has no input ${inputName}`);
    }
    this.kernel.setModuleInput(this.taskId, moduleId, inputName, value, 'deliver');
    try {
      this.compile(moduleId);
      return this.evaluate(moduleId);
    } catch (error) {
      this.kernel.setNodeQueuePaused(this.taskId, moduleId, true);
      throw error;
    }
  }

  /** Judge using the currently held inputs. `once` that already fired only updates state. */
  evaluate(moduleId: string): ModuleEvaluation {
    const compiled = this.compile(moduleId);
    const environment = this.environment(moduleId, compiled);
    const triggered = this.latch(moduleId);

    // §4: a once-module only judges once its required inputs are present, so a
    // missing field is never read as false.
    const missingRequired = compiled.requiredInputs.filter(name => !(name in environment.inputs));
    if (missingRequired.length) {
      this.record(moduleId, environment, { emitted: false, outputs: {}, reasons: [] }, null);
      return { emitted: false, waiting: true, triggered, outputs: {}, reasons: [] };
    }

    if (compiled.trigger === 'once' && triggered) {
      // Latched: state may change, but nothing is emitted and no judgment happens.
      this.record(moduleId, environment, { emitted: false, outputs: {}, reasons: [] }, null);
      return { emitted: false, waiting: false, triggered: true, outputs: {}, reasons: [] };
    }

    let merged;
    try {
      merged = mergeRuleOutputs(compiled.rules, environment);
    } catch (error) {
      // §9: an evaluation defect keeps the inputs and pauses the module.
      this.kernel.setNodeQueuePaused(this.taskId, moduleId, true);
      throw error instanceof RuleError ? error : new RuntimeError('module_defect', error instanceof Error ? error.message : String(error));
    }

    // A once-module that fired this time latches; nothing is judged again until reopened.
    this.record(moduleId, environment, merged, compiled.trigger === 'once' && merged.emitted ? 'fired' : null);
    return {
      emitted: merged.emitted,
      waiting: !merged.emitted && compiled.rules.some(rule => rule.when.referencedInputs.some(name => !(name in environment.inputs))),
      triggered: compiled.trigger === 'once' && merged.emitted ? true : triggered,
      outputs: merged.outputs,
      reasons: merged.reasons,
    };
  }

  /**
   * Clear the latch only (§2, §6): inputs are kept, nothing is emitted, and the
   * next delivery is what judges. Reopen is an explicit control action.
   */
  reopen(moduleId: string): ModuleEvaluation {
    const compiled = this.compile(moduleId);
    this.kernel.db.prepare('UPDATE kernel_modules SET triggered=0 WHERE task_id=? AND module_id=?').run(this.taskId, moduleId);
    // Record the reopen as its own transition, with a reason, so the explanation
    // shows the latch was cleared without an emit.
    const environment = this.environment(moduleId, compiled);
    this.kernel.recordModuleTransition(this.taskId, {
      moduleId, inputName: '(reopen)', inputValue: null,
      stateBefore: environment.state, stateAfter: environment.state,
      verdict: null, outputs: {}, ruleVersion: this.ruleVersion(moduleId),
      reason: 'reopen: latch cleared, inputs kept, no emit',
    });
    return { emitted: false, waiting: false, triggered: false, outputs: {}, reasons: [] };
  }

  /**
   * Accept one input and judge by a main-authored command module (§9).
   *
   * The module's `evaluate()` runs in its own ISOLATED process (§9, §15.7) through
   * the caller-injected evaluator; its outputs become a transition carrying the
   * code version, so a result can always be traced to the code that produced it.
   * A defect keeps the input and pauses the module.
   */
  async deliverCustom(
    moduleId: string,
    inputName: string,
    value: Json,
    evaluate: (input: { entry: string; inputs: Record<string, Json>; state: Json; trigger: 'each' | 'once' }) => Promise<{ ok: boolean; state: Json; outputs: Record<string, Json>; diagnostics: string[]; error?: string }>,
  ): Promise<ModuleEvaluation> {
    const definition = this.definition();
    const module = definition.modules[moduleId];
    if (!module) throw new RuntimeError('invalid_definition', `Revision ${this.revisionVersion} has no module ${moduleId}`);
    if (!module.code) throw new RuntimeError('invalid_definition', `Command module ${moduleId} declares no code entry`);
    if (!Object.keys(module.inputs).includes(inputName)) {
      throw new RuntimeError('invalid_input', `Module ${moduleId} has no input ${inputName}`);
    }
    // §9: the input is stored FIRST, so a defect keeps it rather than losing it.
    this.kernel.setModuleInput(this.taskId, moduleId, inputName, value, 'deliver');
    const inputs: Record<string, Json> = {};
    for (const name of Object.keys(module.inputs)) {
      const row = this.kernel.moduleInput(this.taskId, moduleId, name);
      if (row?.delivered) inputs[name] = row.value;
    }
    const stateRow = this.kernel.db.prepare('SELECT state FROM kernel_modules WHERE task_id=? AND module_id=?').get(this.taskId, moduleId) as { state: string } | undefined;
    const state = stateRow ? JSON.parse(stateRow.state) as Json : null;
    const result = await evaluate({ entry: module.code.entry, inputs, state, trigger: module.trigger });
    if (!result.ok) {
      this.kernel.setNodeQueuePaused(this.taskId, moduleId, true);
      throw new RuntimeError('module_defect', result.error ?? 'command module failed');
    }
    const emitted = Object.keys(result.outputs).length > 0;
    this.kernel.recordModuleTransition(this.taskId, {
      moduleId,
      inputName,
      inputValue: inputs as Json,
      stateBefore: state,
      stateAfter: result.state,
      verdict: emitted ? Object.keys(result.outputs).join(',') : null,
      outputs: result.outputs,
      // §9: the transition records the CODE version, not a rule version.
      ruleVersion: module.code.version,
      reason: result.diagnostics.length ? result.diagnostics.join(' | ') : 'command module evaluate()',
    });
    return {
      emitted,
      waiting: false,
      triggered: this.latch(moduleId),
      outputs: result.outputs,
      reasons: result.diagnostics,
    };
  }

  private record(
    moduleId: string,
    environment: { inputs: Record<string, Json>; state: Json },
    merged: { emitted: boolean; outputs: Record<string, Json>; reasons: string[] },
    latch: 'fired' | null,
  ): void {
    this.kernel.recordModuleTransition(this.taskId, {
      moduleId,
      inputName: merged.reasons.length ? merged.reasons[merged.reasons.length - 1]! : '(no rule)',
      inputValue: environment.inputs as Json,
      stateBefore: environment.state,
      stateAfter: environment.state,
      verdict: merged.emitted ? Object.keys(merged.outputs).join(',') : null,
      outputs: merged.outputs,
      ruleVersion: this.ruleVersion(moduleId),
      reason: merged.reasons.length ? merged.reasons.join(' | ') : (latch === 'fired' ? 'once fired' : 'no rule matched'),
    });
  }
}
