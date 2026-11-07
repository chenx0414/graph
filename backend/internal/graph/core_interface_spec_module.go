package graph

import (
	"fmt"
	"strings"

	"encoding/json"
)

const moduleOperationDefaultTimeoutMs = 15 * 60_000

const moduleOperationMaxTimeoutMs = 1_800_000

func interfaceSpecStrings(value any) []string {
	items, _ := value.([]any)
	out := []string{}
	for _, item := range items {
		text, _ := item.(string)
		out = append(out, text)
	}
	return out
}

func interfaceSpecValidateModule(definition map[string]any, id string, module map[string]any) {
	kind, _ := module["type"].(string)
	if kind != "router" && kind != "command" && kind != "operation" {
		interfaceSpecInvalid("Module " + id + " has unsupported type " + fmt.Sprint(module["type"]))
	}
	if kind == "operation" {
		operation, _ := module["operation"].(map[string]any)
		outputs, _ := module["outputs"].(map[string]any)
		args, argsOK := operation["args"].([]any)
		argsOK = argsOK && interfaceSpecArgs(args)
		output, _ := operation["output"].(string)
		command, _ := operation["command"].(string)
		_, outputKnown := outputs[output]
		if operation == nil || operation["action"] != "workspace.command" || !isSafeInteger(operation["version"]) || asFloatMust(operation["version"]) < 1 || strings.TrimSpace(command) == "" || !argsOK || !outputKnown {
			interfaceSpecInvalid("Module " + id + " requires a versioned workspace.command operation and declared output")
		}
		for key := range operation {
			if !map[string]bool{"action": true, "version": true, "command": true, "args": true, "output": true, "timeoutMs": true, "sandbox": true}[key] {
				interfaceSpecInvalid("Module " + id + " has unsupported operation field " + key)
			}
		}
		if timeout, ok := operation["timeoutMs"]; ok && timeout != nil {
			number := asFloatMust(timeout)
			if !isSafeInteger(timeout) || number < 1 || number > moduleOperationMaxTimeoutMs {
				interfaceSpecInvalid("Module " + id + " has invalid operation timeout: timeoutMs must be between 1 and " +
					itoa(moduleOperationMaxTimeoutMs) + "ms (the default is " + itoa(moduleOperationDefaultTimeoutMs) + "ms)")
			}
		}
		if sandbox, ok := operation["sandbox"]; ok && sandbox != nil {
			if _, isBool := sandbox.(bool); !isBool {
				interfaceSpecInvalid("Module " + id + " sandbox must be boolean")
			}
		}
		rules, _ := module["rules"].([]any)
		if module["code"] != nil || len(rules) > 0 {
			interfaceSpecInvalid("Module " + id + " operation cannot also declare code or rules")
		}
	}
	trigger, _ := module["trigger"].(string)
	if trigger != "each" && trigger != "once" {
		interfaceSpecInvalid("Module " + id + " trigger must be each or once")
	}
	inputs, _ := module["inputs"].(map[string]any)
	for port, ref := range inputs {
		record, _ := ref.(map[string]any)
		interfaceSpecAssertDeclared(definition, record, "Module "+id+" input "+port)
	}
	outputs, _ := module["outputs"].(map[string]any)
	for port, ref := range outputs {
		record, _ := ref.(map[string]any)
		interfaceSpecAssertDeclared(definition, record, "Module "+id+" output "+port)
	}
	for _, input := range interfaceSpecStrings(module["requiredInputs"]) {
		if _, ok := inputs[input]; !ok {
			interfaceSpecInvalid("Module " + id + " requiredInputs names undeclared input " + input)
		}
	}
	if control, ok := module["control"].(map[string]any); ok {
		reopen, _ := control["reopen"].(string)
		if _, known := inputs[reopen]; !known || interfaceSpecContains(interfaceSpecStrings(module["requiredInputs"]), reopen) {
			interfaceSpecInvalid("Module " + id + " reopen control must name an input excluded from requiredInputs")
		}
	}
	if limits, ok := module["limits"].(map[string]any); ok {
		for name, limit := range limits {
			if !map[string]bool{"timeoutMs": true, "memoryMb": true, "inputBytes": true, "outputBytes": true, "stateBytes": true}[name] || !isSafeInteger(limit) || asFloatMust(limit) < 1 {
				interfaceSpecInvalid("Module " + id + " has invalid resource limit " + name)
			}
			if name == "memoryMb" && (asFloatMust(limit) < 64 || asFloatMust(limit) > 16384) {
				interfaceSpecInvalid("Module " + id + " memoryMb must be between 64 and 16384")
			}
		}
	}
	rules, _ := module["rules"].([]any)
	for index, raw := range rules {
		rule, _ := raw.(map[string]any)
		when, _ := rule["when"].(string)
		if strings.TrimSpace(when) == "" {
			interfaceSpecInvalid("Module " + id + " rule " + itoa(index) + " requires a when expression")
		}
		emit, ok := rule["emit"].(map[string]any)
		if !ok {
			interfaceSpecInvalid("Module " + id + " rule " + itoa(index) + " requires an emit map")
		}
		for port := range emit {
			if _, known := outputs[port]; !known {
				interfaceSpecInvalid("Module " + id + " rule " + itoa(index) + " emits undeclared output " + port)
			}
		}
	}
}

func interfaceSpecArgs(args []any) bool {
	for _, arg := range args {
		if _, ok := arg.(string); !ok {
			return false
		}
	}
	return true
}

func interfaceSpecContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func interfaceSpecCloneMap(value map[string]any) map[string]any {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		panic(err)
	}
	return out
}
