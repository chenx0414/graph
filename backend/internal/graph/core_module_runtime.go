package graph

import (
	"encoding/json"
	"fmt"
	"sync"
)

// ModuleEvaluation is one judgment of a module.
type ModuleEvaluation struct {
	TransitionId string
	Emitted      bool
	Waiting      bool
	Triggered    bool
	Outputs      map[string]any
	Reasons      []string
}

type moduleEvalEnv struct {
	Inputs  map[string]any
	State   any
	Trigger string
	Limits  *ModuleLimits
	Entry   string
}

type moduleEvalFn func(moduleEvalEnv) ModuleEvaluationResult

// ModuleRuntime judges one revision's modules.
type ModuleRuntime struct {
	kernel          *KernelStore
	taskId          string
	RevisionVersion int
	compiled        *compiledModule
}

type compiledModule struct {
	trigger        string
	requiredInputs []string
	rules          []RuleDeclaration
	inputNames     []string
	updatedAt      string
}

var moduleSerialize = struct {
	mu    sync.Mutex
	tails map[string]*sync.Mutex
}{tails: map[string]*sync.Mutex{}}

func moduleLock(kernel *KernelStore, taskId, moduleId string) *sync.Mutex {
	key := fmt.Sprintf("%p\x00%s\x00%s", kernel.Store, taskId, moduleId)
	moduleSerialize.mu.Lock()
	defer moduleSerialize.mu.Unlock()
	lock := moduleSerialize.tails[key]
	if lock == nil {
		lock = &sync.Mutex{}
		moduleSerialize.tails[key] = lock
	}
	return lock
}

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

// ReopenAfterPending clears the latch after any judgment already queued for this module.
func (runtime *ModuleRuntime) ReopenAfterPending(moduleId string) ModuleEvaluation {
	lock := moduleLock(runtime.kernel, runtime.taskId, moduleId)
	lock.Lock()
	defer lock.Unlock()
	return runtime.kernel.ModuleTransaction(func() any { return runtime.Reopen(moduleId) }).(ModuleEvaluation)
}

// Reopen clears the latch and keeps the inputs.
func (runtime *ModuleRuntime) Reopen(moduleId string) ModuleEvaluation {
	compiled := runtime.compile(moduleId)
	graphDBExec(runtime.kernel.Db, "UPDATE kernel_modules SET triggered=0 WHERE task_id=? AND module_id=?", runtime.taskId, moduleId)
	_, state := runtime.environment(moduleId, compiled)
	runtime.kernel.RecordModuleTransition(runtime.taskId, ModuleTransitionInput{
		ModuleId: moduleId, InputName: "(reopen)", InputValue: nil, StateBefore: state, StateAfter: state,
		Outputs: map[string]any{}, RuleVersion: runtime.ruleVersion(moduleId), Reason: "reopen: latch cleared, inputs kept, no emit",
	})
	return ModuleEvaluation{Emitted: false, Waiting: false, Triggered: false, Outputs: map[string]any{}, Reasons: []string{}}
}

// DeliverCustom judges a command module in the isolated evaluator.
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

// DeliverOperation judges a host operation module.
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
	if _, ok := mapKeysSet(record["inputs"])[inputName]; !ok {
		Raise("invalid_input", fmt.Sprintf("Module %s has no input %s", moduleId, inputName))
	}
	control, _ := record["control"].(map[string]any)
	reopen, _ := control["reopen"].(string)
	if reopen == inputName {
		return runtime.kernel.ModuleTransaction(func() any {
			judged := runtime.acceptControl(moduleId, inputName, value)
			if deliveryId != "" {
				graphDBExec(runtime.kernel.Db, "UPDATE kernel_module_inbox SET processed=1 WHERE delivery_id=?", deliveryId)
			}
			return *judged
		}).(ModuleEvaluation)
	}
	runtime.kernel.SetModuleInput(runtime.taskId, moduleId, inputName, value, moduleRuntimeSource("deliver"))
	inputs := map[string]any{}
	for _, name := range mapKeysAny(record["inputs"]) {
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
		runtime.kernel.ModuleTransaction(func() any {
			runtime.kernel.RecordModuleTransition(runtime.taskId, ModuleTransitionInput{
				ModuleId: moduleId, InputName: inputName, InputValue: inputs, StateBefore: state, StateAfter: state,
				Outputs: map[string]any{}, RuleVersion: implementationVersion, Reason: reason,
			})
			if deliveryId != "" {
				graphDBExec(runtime.kernel.Db, "UPDATE kernel_module_inbox SET processed=1 WHERE delivery_id=?", deliveryId)
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
	recorded := runtime.kernel.ModuleTransaction(func() any {
		row := runtime.kernel.RecordModuleTransition(runtime.taskId, ModuleTransitionInput{
			ModuleId: moduleId, InputName: inputName, InputValue: inputs, StateBefore: state, StateAfter: result.State,
			Verdict: verdictPtr, Outputs: result.Outputs, RuleVersion: implementationVersion, Reason: reason,
		})
		if deliveryId != "" {
			graphDBExec(runtime.kernel.Db, "UPDATE kernel_module_inbox SET processed=1 WHERE delivery_id=?", deliveryId)
		}
		return row
	})
	return ModuleEvaluation{
		TransitionId: transitionField(recorded), Emitted: emitted, Triggered: runtime.latch(moduleId),
		Outputs: result.Outputs, Reasons: result.Diagnostics,
	}
}

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

func mapKeysAny(value any) []string {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	keys := make([]string, 0, len(record))
	for key := range record {
		keys = append(keys, key)
	}
	return keys
}

func mapKeysSet(value any) map[string]bool {
	set := map[string]bool{}
	for _, key := range mapKeysAny(value) {
		set[key] = true
	}
	return set
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
