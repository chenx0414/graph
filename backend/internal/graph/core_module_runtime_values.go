package graph

import (
	"encoding/json"
)

func (runtime *ModuleRuntime) record(moduleId string, inputs map[string]any, state any, merged MergedOutput, latch *string) string {
	inputName := "(no rule)"
	if len(merged.Reasons) > 0 {
		inputName = merged.Reasons[len(merged.Reasons)-1]
	}
	reason := "no rule matched"
	if latch != nil && *latch == "fired" {
		reason = "once fired"
	}
	if len(merged.Reasons) > 0 {
		reason = joinPipe(merged.Reasons)
	}
	verdictText := ""
	if merged.Emitted {
		names := make([]string, 0, len(merged.Outputs))
		for name := range merged.Outputs {
			names = append(names, name)
		}
		verdictText = joinComma(names)
	}
	var verdict *string
	if verdictText != "" {
		verdict = &verdictText
	}
	outputs := merged.Outputs
	if outputs == nil {
		outputs = map[string]any{}
	}
	recorded := runtime.kernel.RecordModuleTransition(runtime.taskId, ModuleTransitionInput{
		ModuleId: moduleId, InputName: inputName, InputValue: inputs, StateBefore: state, StateAfter: state,
		Verdict: verdict, Outputs: outputs, RuleVersion: runtime.ruleVersion(moduleId), Reason: reason,
	})
	return transitionField(recorded)
}

func moduleRecord(module ModuleDefinition) map[string]any {
	encoded, err := json.Marshal(module)
	if err != nil {
		panic(err)
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		panic(err)
	}
	if out == nil {
		return map[string]any{}
	}
	return out
}

func definitionRecord(definition GraphDefinition) map[string]any {
	encoded, err := json.Marshal(definition)
	if err != nil {
		panic(err)
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		panic(err)
	}
	if out == nil {
		return map[string]any{}
	}
	return out
}

func stringListAny(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	out := []string{}
	for _, item := range list {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func moduleLimits(value any) *ModuleLimits {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	limits := &ModuleLimits{}
	if number, ok := record["timeoutMs"].(float64); ok {
		value := int(number)
		limits.TimeoutMs = &value
	}
	if number, ok := record["memoryMb"].(float64); ok {
		value := int(number)
		limits.MemoryMb = &value
	}
	if number, ok := record["inputBytes"].(float64); ok {
		value := int(number)
		limits.InputBytes = &value
	}
	if number, ok := record["outputBytes"].(float64); ok {
		value := int(number)
		limits.OutputBytes = &value
	}
	if number, ok := record["stateBytes"].(float64); ok {
		value := int(number)
		limits.StateBytes = &value
	}
	return limits
}

func ruleMissing(rules []RuleDeclaration, inputs map[string]any) bool {
	for _, rule := range rules {
		for _, name := range rule.When.ReferencedInputs {
			if _, ok := inputs[name]; !ok {
				return true
			}
		}
	}
	return false
}

func joinPipe(values []string) string {
	out := ""
	for i, value := range values {
		if i > 0 {
			out += " | "
		}
		out += value
	}
	return out
}

func transitionField(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	var record map[string]any
	if err := json.Unmarshal(encoded, &record); err != nil {
		return ""
	}
	if id, ok := record["id"].(string); ok {
		return id
	}
	if id, ok := record["Id"].(string); ok {
		return id
	}
	return ""
}

// moduleRuntimeSource is the source label a module input was delivered with.
func moduleRuntimeSource(source string) *string { return &source }
