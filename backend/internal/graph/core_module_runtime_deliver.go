package graph

import (
	"fmt"
)

// Deliver stores one input and judges it.
func (runtime *ModuleRuntime) Deliver(moduleId, inputName string, value any) ModuleEvaluation {
	record := moduleRecord(runtime.module(moduleId))
	if _, ok := mapKeysSet(record["inputs"])[inputName]; !ok {
		Raise("invalid_input", fmt.Sprintf("Module %s has no input %s", moduleId, inputName))
	}
	if control := runtime.acceptControl(moduleId, inputName, value); control != nil {
		return *control
	}
	runtime.kernel.SetModuleInput(runtime.taskId, moduleId, inputName, value, moduleRuntimeSource("deliver"))
	var evaluation ModuleEvaluation
	if err := portRecover(func() {
		runtime.compile(moduleId)
		evaluation = runtime.Evaluate(moduleId)
	}); err != nil {
		runtime.kernel.SetNodeQueuePaused(runtime.taskId, moduleId, true)
		panic(err)
	}
	return evaluation
}

// ConsumeDelivery judges one inbox row and marks it processed.
func (runtime *ModuleRuntime) ConsumeDelivery(moduleId, inputName string, value any, deliveryId string) ModuleEvaluation {
	var evaluation ModuleEvaluation
	if err := portRecover(func() {
		evaluation = runtime.kernel.ModuleTransaction(func() any {
			control := runtime.acceptControl(moduleId, inputName, value)
			if control == nil {
				runtime.kernel.SetModuleInput(runtime.taskId, moduleId, inputName, value, moduleRuntimeSource("delivery:"+deliveryId))
			}
			var judged ModuleEvaluation
			if control != nil {
				judged = *control
			} else {
				judged = runtime.Evaluate(moduleId)
			}
			graphDBExec(runtime.kernel.Db, "UPDATE kernel_module_inbox SET processed=1 WHERE delivery_id=?", deliveryId)
			return judged
		}).(ModuleEvaluation)
	}); err != nil {
		runtime.kernel.SetModuleInput(runtime.taskId, moduleId, inputName, value, moduleRuntimeSource("delivery:"+deliveryId))
		runtime.kernel.SetNodeQueuePaused(runtime.taskId, moduleId, true)
		panic(err)
	}
	return evaluation
}

// Evaluate judges the inputs currently held.
func (runtime *ModuleRuntime) Evaluate(moduleId string) ModuleEvaluation {
	compiled := runtime.compile(moduleId)
	inputs, state := runtime.environment(moduleId, compiled)
	triggered := runtime.latch(moduleId)
	missing := []string{}
	for _, name := range compiled.requiredInputs {
		if _, ok := inputs[name]; !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		runtime.record(moduleId, inputs, state, MergedOutput{}, nil)
		return ModuleEvaluation{Waiting: true, Triggered: triggered, Outputs: map[string]any{}, Reasons: []string{}}
	}
	if compiled.trigger == "once" && triggered {
		runtime.record(moduleId, inputs, state, MergedOutput{}, nil)
		return ModuleEvaluation{Triggered: true, Outputs: map[string]any{}, Reasons: []string{}}
	}
	var merged MergedOutput
	if err := portRecover(func() { merged = MergeRuleOutputs(compiled.rules, RuleEnvironment{Inputs: inputs, State: state}) }); err != nil {
		runtime.kernel.SetNodeQueuePaused(runtime.taskId, moduleId, true)
		if _, ok := err.(*RuleError); ok {
			panic(err)
		}
		Raise("module_defect", err.Error())
	}
	var latch *string
	if compiled.trigger == "once" && merged.Emitted {
		fired := "fired"
		latch = &fired
	}
	transitionId := runtime.record(moduleId, inputs, state, merged, latch)
	waiting := !merged.Emitted && ruleMissing(compiled.rules, inputs)
	nextTriggered := triggered
	if compiled.trigger == "once" && merged.Emitted {
		nextTriggered = true
	}
	return ModuleEvaluation{TransitionId: transitionId, Emitted: merged.Emitted, Waiting: waiting, Triggered: nextTriggered, Outputs: merged.Outputs, Reasons: merged.Reasons}
}
