package graph

import (
	"encoding/json"
	"fmt"
)

func NewModuleRuntime(kernel *KernelStore, taskId string, revisionVersion int) *ModuleRuntime {
	return &ModuleRuntime{kernel: kernel, taskId: taskId, RevisionVersion: revisionVersion}
}

func (runtime *ModuleRuntime) definition() GraphDefinition {
	revision := runtime.kernel.Revision(runtime.taskId, runtime.RevisionVersion)
	if revision == nil {
		Raise("invalid_definition", fmt.Sprintf("Unknown revision %d", runtime.RevisionVersion))
	}
	return revision.Definition
}

func (runtime *ModuleRuntime) compile(moduleId string) compiledModule {
	module := runtime.module(moduleId)
	encoded, err := json.Marshal(module)
	if err != nil {
		panic(err)
	}
	signature := string(encoded)
	if runtime.compiled != nil && runtime.compiled.updatedAt == signature {
		return *runtime.compiled
	}
	record := moduleRecord(module)
	rules := []RuleDeclaration{}
	if rawRules, ok := record["rules"].([]any); ok {
		for _, item := range rawRules {
			rule, ok := item.(map[string]any)
			if !ok {
				continue
			}
			when, _ := rule["when"].(string)
			emit, _ := rule["emit"].(map[string]any)
			rules = append(rules, RuleDeclaration{When: ParseRule(when), Emit: ParseEmit(emit), Reason: when})
		}
	}
	trigger, _ := record["trigger"].(string)
	if trigger == "" {
		trigger = module.Trigger
	}
	required := stringListAny(record["requiredInputs"])
	if trigger == "once" && len(required) == 0 {
		referenced := map[string]bool{}
		for _, rule := range rules {
			for _, name := range rule.When.ReferencedInputs {
				referenced[name] = true
			}
		}
		if len(referenced) > 1 {
			Raise("invalid_definition", fmt.Sprintf("once-module %s reads %d inputs but declares no requiredInputs", moduleId, len(referenced)))
		}
	}
	runtime.compiled = &compiledModule{
		trigger: trigger, requiredInputs: required, rules: rules, inputNames: mapKeysAny(record["inputs"]), updatedAt: signature,
	}
	return *runtime.compiled
}

func (runtime *ModuleRuntime) module(moduleId string) ModuleDefinition {
	definition := runtime.definition()
	module, ok := definition.Modules[moduleId]
	if !ok {
		Raise("invalid_definition", fmt.Sprintf("Revision %d has no module %s", runtime.RevisionVersion, moduleId))
	}
	return module
}

func (runtime *ModuleRuntime) latch(moduleId string) bool {
	row, ok := graphDBRow(runtime.kernel.Db, "SELECT triggered FROM kernel_modules WHERE task_id=? AND module_id=?", runtime.taskId, moduleId)
	return ok && graphDBInt(row, "triggered") == 1
}

func (runtime *ModuleRuntime) ruleVersion(moduleId string) int {
	row, ok := graphDBRow(runtime.kernel.Db, "SELECT rule_version FROM kernel_modules WHERE task_id=? AND module_id=?", runtime.taskId, moduleId)
	if !ok {
		return 1
	}
	return int(graphDBInt(row, "rule_version"))
}

func (runtime *ModuleRuntime) environment(moduleId string, compiled compiledModule) (map[string]any, any) {
	inputs := map[string]any{}
	for _, name := range compiled.inputNames {
		row := runtime.kernel.ModuleInput(runtime.taskId, moduleId, name)
		if row != nil && row.Delivered {
			inputs[name] = row.Value
		}
	}
	row, ok := graphDBRow(runtime.kernel.Db, "SELECT state FROM kernel_modules WHERE task_id=? AND module_id=?", runtime.taskId, moduleId)
	if !ok {
		return inputs, nil
	}
	return inputs, runtime.kernel.Content.Decode(graphDBString(row, "state"))
}

func (runtime *ModuleRuntime) acceptControl(moduleId, inputName string, value any) *ModuleEvaluation {
	record := moduleRecord(runtime.module(moduleId))
	inputs, _ := record["inputs"].(map[string]any)
	ref, ok := inputs[inputName].(map[string]any)
	if !ok {
		Raise("invalid_input", fmt.Sprintf("Module %s has no input %s", moduleId, inputName))
	}
	protocolName, _ := ref["protocol"].(string)
	protocols := definitionRecord(runtime.definition())["protocols"]
	protocolMap, _ := protocols.(map[string]any)
	protocolSpec, _ := protocolMap[protocolName].(ProtocolSpec)
	if defect := ValidateProtocolValue(protocolSpec, value, moduleId+"."+inputName); defect != nil {
		Raise("invalid_input", *defect)
	}
	control, _ := record["control"].(map[string]any)
	reopen, _ := control["reopen"].(string)
	if reopen == inputName {
		evaluation := runtime.Reopen(moduleId)
		return &evaluation
	}
	return nil
}
