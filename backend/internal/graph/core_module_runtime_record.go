package graph

import (
	"fmt"
	"slices"
)

func (runtime *ModuleRuntime) ReopenAfterPending(moduleId string) ModuleEvaluation {
	lock := moduleLock(runtime.kernel, runtime.taskId, moduleId)
	lock.Lock()
	defer lock.Unlock()
	return runtime.kernel.ModuleTransaction(func(kernel *KernelStore) any { return runtime.Reopen(moduleId) }).(ModuleEvaluation)
}

func (runtime *ModuleRuntime) Reopen(moduleId string) ModuleEvaluation {
	compiled := runtime.compile(moduleId)
	runtime.kernel.ResetModuleTrigger(runtime.taskId, moduleId)
	_, state := runtime.environment(moduleId, compiled)
	runtime.kernel.RecordModuleTransition(runtime.taskId, ModuleTransitionInput{
		ModuleId: moduleId, InputName: "(reopen)", InputValue: nil, StateBefore: state, StateAfter: state,
		Outputs: map[string]any{}, RuleVersion: runtime.ruleVersion(moduleId), Reason: "reopen: latch cleared, inputs kept, no emit",
	})
	return ModuleEvaluation{Emitted: false, Waiting: false, Triggered: false, Outputs: map[string]any{}, Reasons: []string{}}
}

func (runtime *ModuleRuntime) DeliverCustom(moduleId, inputName string, value any, evaluate moduleEvalFn, deliveryId string) ModuleEvaluation {
	code := moduleRecord(runtime.module(moduleId))["code"]
	codeMap, _ := code.(map[string]any)
	entry, _ := codeMap["entry"].(string)
	if entry == "" {
		Raise("invalid_definition", "Command module "+moduleId+" declares no code entry")
	}
	version := int(asInt(codeMap["version"]))
	return runtime.deliverEvaluated(moduleId, inputName, value, func(env moduleEvalEnv) ModuleEvaluationResult {
		env.Entry = entry
		return evaluate(env)
	}, version, deliveryId)
}

func (runtime *ModuleRuntime) DeliverOperation(moduleId, inputName string, value any, evaluate moduleEvalFn, deliveryId string) ModuleEvaluation {
	operation := moduleRecord(runtime.module(moduleId))["operation"]
	operationMap, _ := operation.(map[string]any)
	if operationMap == nil {
		Raise("invalid_definition", "Module "+moduleId+" declares no host operation")
	}
	return runtime.deliverEvaluated(moduleId, inputName, value, evaluate, int(asInt(operationMap["version"])), deliveryId)
}

func (runtime *ModuleRuntime) deliverEvaluated(moduleId, inputName string, value any, evaluate moduleEvalFn, implementationVersion int, deliveryId string) ModuleEvaluation {
	lock := moduleLock(runtime.kernel, runtime.taskId, moduleId)
	lock.Lock()
	defer lock.Unlock()
	return runtime.deliverEvaluatedUnlocked(moduleId, inputName, value, evaluate, implementationVersion, deliveryId)
}

func (runtime *ModuleRuntime) deliverEvaluatedUnlocked(moduleId, inputName string, value any, evaluate moduleEvalFn, implementationVersion int, deliveryId string) ModuleEvaluation {
	module := runtime.module(moduleId)
	record := moduleRecord(module)
	if !slices.Contains(anySortedKeys(record["inputs"]), inputName) {
		Raise("invalid_input", fmt.Sprintf("Module %s has no input %s", moduleId, inputName))
	}
	control, _ := record["control"].(map[string]any)
	reopen, _ := control["reopen"].(string)
	if reopen == inputName {
		return runtime.kernel.ModuleTransaction(func(kernel *KernelStore) any {
			judged := runtime.acceptControl(moduleId, inputName, value)
			if deliveryId != "" {
				runtime.kernel.MarkDeliveryProcessed(deliveryId)
			}
			return *judged
		}).(ModuleEvaluation)
	}
	runtime.kernel.SetModuleInput(runtime.taskId, moduleId, inputName, value, moduleRuntimeSource("deliver"))
	inputs := map[string]any{}
	for _, name := range anySortedKeys(record["inputs"]) {
		row := runtime.kernel.ModuleInput(runtime.taskId, moduleId, name)
		if row != nil && row.Delivered {
			inputs[name] = row.Value
		}
	}
	stateRow, ok := graphDBRow(runtime.kernel.Db, "SELECT state FROM kernel_modules WHERE task_id=? AND module_id=?", runtime.taskId, moduleId)
	var state any
	if ok {
		state = runtime.kernel.Content.Decode(graphDBString(stateRow, "state"))
	}
	trigger, _ := record["trigger"].(string)
	if trigger == "" {
		trigger = module.Trigger
	}
	held := trigger == "once" && runtime.latch(moduleId)
	missing := []string{}
	for _, name := range stringListAny(record["requiredInputs"]) {
		if _, ok := inputs[name]; !ok {
			missing = append(missing, name)
		}
	}
	if held || len(missing) > 0 {
		reason := "once held"
		if len(missing) > 0 {
			reason = "waiting for " + joinComma(missing)
		}
		runtime.kernel.ModuleTransaction(func(kernel *KernelStore) any {
			runtime.kernel.RecordModuleTransition(runtime.taskId, ModuleTransitionInput{
				ModuleId: moduleId, InputName: inputName, InputValue: inputs, StateBefore: state, StateAfter: state,
				Outputs: map[string]any{}, RuleVersion: implementationVersion, Reason: reason,
			})
			if deliveryId != "" {
				runtime.kernel.MarkDeliveryProcessed(deliveryId)
			}
			return nil
		})
		return ModuleEvaluation{Waiting: len(missing) > 0, Triggered: held, Outputs: map[string]any{}, Reasons: []string{}}
	}
	limits := moduleLimits(record["limits"])
	result := evaluate(moduleEvalEnv{Inputs: inputs, State: state, Trigger: trigger, Limits: limits})
	if !result.OK {
		runtime.kernel.SetNodeQueuePaused(runtime.taskId, moduleId, true)
		message := result.Error
		if message == "" {
			message = "command module failed"
		}
		Raise("module_defect", message)
	}
	outputs, _ := record["outputs"].(map[string]any)
	protocols, _ := definitionRecord(runtime.definition())["protocols"].(map[string]any)
	for name, outputValue := range result.Outputs {
		output, _ := outputs[name].(map[string]any)
		if output == nil {
			runtime.kernel.SetNodeQueuePaused(runtime.taskId, moduleId, true)
			Raise("module_defect", "Unknown output "+name)
		}
		protocol, _ := output["protocol"].(string)
		spec, _ := protocols[protocol].(ProtocolSpec)
		if found := ValidateProtocolValue(spec, outputValue, moduleId+"."+name); found != nil {
			runtime.kernel.SetNodeQueuePaused(runtime.taskId, moduleId, true)
			Raise("module_defect", *found)
		}
	}
	emitted := len(result.Outputs) > 0
	verdict := ""
	if emitted {
		names := make([]string, 0, len(result.Outputs))
		for name := range result.Outputs {
			names = append(names, name)
		}
		verdict = joinComma(names)
	}
	reason := "command module evaluate()"
	if len(result.Diagnostics) > 0 {
		reason = joinPipe(result.Diagnostics)
	}
	var verdictPtr *string
	if verdict != "" {
		verdictPtr = &verdict
	}
	recorded := runtime.kernel.ModuleTransaction(func(kernel *KernelStore) any {
		row := runtime.kernel.RecordModuleTransition(runtime.taskId, ModuleTransitionInput{
			ModuleId: moduleId, InputName: inputName, InputValue: inputs, StateBefore: state, StateAfter: result.State,
			Verdict: verdictPtr, Outputs: result.Outputs, RuleVersion: implementationVersion, Reason: reason,
		})
		if deliveryId != "" {
			runtime.kernel.MarkDeliveryProcessed(deliveryId)
		}
		return row
	})
	return ModuleEvaluation{
		TransitionId: transitionField(recorded), Emitted: emitted, Triggered: runtime.latch(moduleId),
		Outputs: result.Outputs, Reasons: result.Diagnostics,
	}
}
