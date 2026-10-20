package graph

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
)

const INTERFACE_SCHEMA_VERSION = 2

type ProtocolSpec = map[string]any

type ProtocolRef struct {
	Protocol string `json:"protocol"`
	Version  *int   `json:"version,omitempty"`
}

type NodeBudget struct {
	Tokens *int `json:"tokens"`
}

type NodeRetry struct {
	Automatic *int `json:"automatic,omitempty"`
	Resubmit  *int `json:"resubmit,omitempty"`
}

type ExecutionSettings struct {
	Model  *string     `json:"model,omitempty"`
	Retry  *NodeRetry  `json:"retry,omitempty"`
	Budget *NodeBudget `json:"budget,omitempty"`
}

type NodeWorkspace struct {
	Base string `json:"base"`
	Path string `json:"path,omitempty"`
}

type NodeSubmission struct {
	Required      []string `json:"required,omitempty"`
	RequiredAnyOf []string `json:"requiredAnyOf,omitempty"`
}

type NodeDeliverable struct {
	Path      string `json:"path"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Title     string `json:"title,omitempty"`
	Summary   string `json:"summary,omitempty"`
	Schema    string `json:"schema,omitempty"`
}

type NodeDefinition struct {
	Recipe       string                 `json:"recipe"`
	Task         string                 `json:"task"`
	Instructions string                 `json:"instructions,omitempty"`
	Workspace    *NodeWorkspace         `json:"workspace,omitempty"`
	Access       map[string]any         `json:"access,omitempty"`
	Acceptance   []string               `json:"acceptance,omitempty"`
	Submission   NodeSubmission         `json:"submission"`
	Deliverable  *NodeDeliverable       `json:"deliverable,omitempty"`
	Inputs       map[string]ProtocolRef `json:"inputs"`
	Outputs      map[string]ProtocolRef `json:"outputs"`
	ExecutionSettings
}

type ModuleControl struct {
	Reopen string `json:"reopen"`
}

type ModuleLimits struct {
	TimeoutMs   *int `json:"timeoutMs,omitempty"`
	MemoryMb    *int `json:"memoryMb,omitempty"`
	InputBytes  *int `json:"inputBytes,omitempty"`
	OutputBytes *int `json:"outputBytes,omitempty"`
	StateBytes  *int `json:"stateBytes,omitempty"`
}

type ModuleRule struct {
	When string         `json:"when"`
	Emit map[string]any `json:"emit"`
}

type ModuleCode struct {
	Entry   string `json:"entry"`
	Version int    `json:"version"`
}

type ModuleOperation struct {
	Action    string   `json:"action"`
	Version   int      `json:"version"`
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	Output    string   `json:"output"`
	TimeoutMs *int     `json:"timeoutMs,omitempty"`
	Sandbox   *bool    `json:"sandbox,omitempty"`
}

type ModuleDefinition struct {
	Type           string                 `json:"type"`
	Trigger        string                 `json:"trigger"`
	Inputs         map[string]ProtocolRef `json:"inputs"`
	Outputs        map[string]ProtocolRef `json:"outputs"`
	RequiredInputs []string               `json:"requiredInputs,omitempty"`
	Control        *ModuleControl         `json:"control,omitempty"`
	Limits         *ModuleLimits          `json:"limits,omitempty"`
	Rules          []ModuleRule           `json:"rules,omitempty"`
	Code           *ModuleCode            `json:"code,omitempty"`
	Operation      *ModuleOperation       `json:"operation,omitempty"`
}

type EdgeDefinition struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Enabled bool   `json:"enabled"`
}

type GraphIo struct {
	To       string `json:"to"`
	Protocol string `json:"protocol"`
	Version  *int   `json:"version,omitempty"`
}

type GraphOutput struct {
	From     string `json:"from"`
	Protocol string `json:"protocol"`
	Version  *int   `json:"version,omitempty"`
}

type CompletionDeclaration struct {
	On    string `json:"on"`
	Drain *bool  `json:"drain,omitempty"`
}

type AcceptanceCriterion struct {
	Id          string `json:"id"`
	Description string `json:"description"`
	Kind        string `json:"kind"`
	Module      string `json:"module,omitempty"`
	Node        string `json:"node,omitempty"`
}

type GraphTemplate struct {
	Version    int             `json:"version"`
	Definition GraphDefinition `json:"definition"`
}

type GraphInstance struct {
	Template string `json:"template"`
	Version  int    `json:"version"`
}

type SubgraphInstanceBinding struct {
	Template string                 `json:"template"`
	Version  int                    `json:"version"`
	Inputs   map[string]GraphIo     `json:"inputs"`
	Outputs  map[string]GraphOutput `json:"outputs"`
}

type GraphDefinition struct {
	SchemaVersion     int                                `json:"schemaVersion"`
	Name              string                             `json:"name"`
	Protocols         map[string]ProtocolSpec            `json:"protocols"`
	Nodes             map[string]NodeDefinition          `json:"nodes"`
	Modules           map[string]ModuleDefinition        `json:"modules"`
	Edges             map[string]EdgeDefinition          `json:"edges"`
	Inputs            map[string]GraphIo                 `json:"inputs"`
	Outputs           map[string]GraphOutput             `json:"outputs"`
	Completion        *CompletionDeclaration             `json:"completion,omitempty"`
	Acceptance        []AcceptanceCriterion              `json:"acceptance,omitempty"`
	Defaults          *ExecutionSettings                 `json:"defaults,omitempty"`
	Subgraphs         []string                           `json:"subgraphs,omitempty"`
	Templates         map[string]GraphTemplate           `json:"templates,omitempty"`
	Instances         map[string]GraphInstance           `json:"instances,omitempty"`
	SubgraphInstances map[string]SubgraphInstanceBinding `json:"subgraphInstances,omitempty"`
}

func interfaceSpecInvalid(reason string) {
	Raise("invalid_definition", reason)
}

func interfaceSpecIsRecord(value any) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	return record, ok
}

func interfaceSpecAsMap(value any) map[string]any {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		interfaceSpecInvalid("Definition must be a JSON object")
	}
	return record
}

func interfaceSpecVersionIs(value any, want float64) bool {
	number, ok := asFloat(value)
	return ok && number == want
}

func interfaceSpecSafeNonNegative(value any) bool {
	return isSafeInteger(value) && asFloatMust(value) >= 0
}

func asFloatMust(value any) float64 {
	number, _ := asFloat(value)
	return number
}

func interfaceSpecSplitEndpoint(endpoint string) (string, string) {
	dot := strings.Index(endpoint, ".")
	if dot <= 0 || dot == len(endpoint)-1 {
		interfaceSpecInvalid("Endpoint " + endpoint + " must be \"<node>.<port>\"")
	}
	return endpoint[:dot], endpoint[dot+1:]
}

func interfaceSpecRefVersion(ref map[string]any) float64 {
	if _, ok := ref["version"]; !ok || ref["version"] == nil {
		return 1
	}
	return asFloatMust(ref["version"])
}

func interfaceSpecProtocolKey(ref map[string]any) string {
	return fmt.Sprintf("%v@%v", ref["protocol"], interfaceSpecRefVersion(ref))
}

func interfaceSpecAssertSame(definition map[string]any, from, to map[string]any, where string) {
	if from == nil {
		interfaceSpecInvalid(where + " names an unknown source endpoint")
	}
	if to == nil {
		interfaceSpecInvalid(where + " names an unknown target endpoint")
	}
	if interfaceSpecProtocolKey(from) != interfaceSpecProtocolKey(to) {
		interfaceSpecInvalid(where + " connects " + interfaceSpecProtocolKey(from) + " to " + interfaceSpecProtocolKey(to) + "; both ends must reference the same protocol id and version")
	}
	protocols, _ := definition["protocols"].(map[string]any)
	name, _ := from["protocol"].(string)
	if _, ok := protocols[name]; !ok {
		interfaceSpecInvalid(where + " references undeclared protocol " + name)
	}
}

func interfaceSpecAssertDeclared(definition map[string]any, ref map[string]any, where string) {
	if ref == nil {
		return
	}
	protocols, _ := definition["protocols"].(map[string]any)
	name, _ := ref["protocol"].(string)
	if _, ok := protocols[name]; !ok {
		interfaceSpecInvalid(where + " references undeclared protocol " + name)
	}
}

func interfaceSpecEndpointRef(definition map[string]any, endpoint, kind string) map[string]any {
	owner, port := interfaceSpecSplitEndpoint(endpoint)
	nodes, _ := definition["nodes"].(map[string]any)
	if node, ok := nodes[owner].(map[string]any); ok {
		side := "outputs"
		if kind == "input" {
			side = "inputs"
		}
		ports, _ := node[side].(map[string]any)
		ref, _ := ports[port].(map[string]any)
		return ref
	}
	modules, _ := definition["modules"].(map[string]any)
	if module, ok := modules[owner].(map[string]any); ok {
		side := "outputs"
		if kind == "input" {
			side = "inputs"
		}
		ports, _ := module[side].(map[string]any)
		ref, _ := ports[port].(map[string]any)
		return ref
	}
	return nil
}

func interfaceSpecValidateSettings(scope string, settings map[string]any) {
	if _, ok := settings["model"]; ok && settings["model"] != nil {
		model, isString := settings["model"].(string)
		if !isString || strings.TrimSpace(model) == "" {
			interfaceSpecInvalid(scope + " model must name a configured connection")
		}
	}
	if _, ok := settings["retry"]; ok && settings["retry"] != nil {
		retry, ok := settings["retry"].(map[string]any)
		if !ok {
			interfaceSpecInvalid(scope + " retry must be an object")
		}
		for key, count := range retry {
			if (key != "automatic" && key != "resubmit") || !interfaceSpecSafeNonNegative(count) {
				interfaceSpecInvalid(scope + " retry." + key + " must be a non-negative integer limit")
			}
		}
	}
	if _, ok := settings["budget"]; ok && settings["budget"] != nil {
		budget, ok := settings["budget"].(map[string]any)
		if !ok {
			interfaceSpecInvalid(scope + " budget.tokens must be a non-negative integer or null")
		}
		for key := range budget {
			if key != "tokens" {
				interfaceSpecInvalid(scope + " budget.tokens must be a non-negative integer or null")
			}
		}
		tokens := budget["tokens"]
		if tokens != nil && !interfaceSpecSafeNonNegative(tokens) {
			interfaceSpecInvalid(scope + " budget.tokens must be a non-negative integer or null")
		}
	}
}

var interfaceSpecDeliverableSlug = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`)
var interfaceSpecSchemaKind = regexp.MustCompile(`^([a-z][a-z0-9._-]*)@([1-9]\d*)$`)

func interfaceSpecValidateNode(definition map[string]any, id string, node map[string]any) {
	if node == nil {
		interfaceSpecInvalid("Node " + id + " must be an object")
	}
	if _, ok := node["command"]; ok {
		interfaceSpecInvalid("Node " + id + " is an agent; declare host commands in an operation module")
	}
	allowed := map[string]bool{
		"recipe": true, "task": true, "instructions": true, "acceptance": true, "inputs": true, "outputs": true,
		"submission": true, "model": true, "retry": true, "budget": true, "deliverable": true, "workspace": true, "access": true,
	}
	for key := range node {
		if !allowed[key] {
			interfaceSpecInvalid("Node " + id + " has unsupported field " + key + "; use named interfaces and explicit edges for graph execution")
		}
	}
	recipe, _ := node["recipe"].(string)
	if strings.TrimSpace(recipe) == "" {
		interfaceSpecInvalid("Node " + id + " requires an agent recipe")
	}
	task, _ := node["task"].(string)
	if strings.TrimSpace(task) == "" {
		interfaceSpecInvalid("Node " + id + " requires a task")
	}
	if _, ok := node["instructions"]; ok && node["instructions"] != nil {
		text, isString := node["instructions"].(string)
		if !isString || strings.TrimSpace(text) == "" {
			interfaceSpecInvalid("Node " + id + " instructions must be a non-empty string")
		}
	}
	interfaceSpecValidateSettings("Node "+id, node)
	if workspace, ok := node["workspace"]; ok && workspace != nil {
		record, ok := workspace.(map[string]any)
		base, _ := record["base"].(string)
		if !ok || !map[string]bool{"auto": true, "project": true, "worktree": true}[base] {
			interfaceSpecInvalid("Node " + id + " workspace requires base:auto|project|worktree")
		}
		for key := range record {
			if key != "base" && key != "path" {
				interfaceSpecInvalid("Node " + id + " workspace requires base:auto|project|worktree")
			}
		}
		if path, present := record["path"]; present && path != nil {
			text, isString := path.(string)
			if !isString || strings.TrimSpace(text) == "" || strings.HasPrefix(text, "/") || strings.ContainsAny(text, "\\\x00") {
				interfaceSpecInvalid("Node " + id + " workspace.path must remain relative to its declared base")
			}
			for _, part := range strings.Split(text, "/") {
				if part == ".." || part == "" {
					interfaceSpecInvalid("Node " + id + " workspace.path must remain relative to its declared base")
				}
			}
		}
	}
	if access, ok := node["access"]; ok && access != nil {
		shape, err := json.Marshal(FullAccessPolicy())
		if err != nil {
			panic(err)
		}
		var sample map[string]any
		if err := json.Unmarshal(shape, &sample); err != nil {
			panic(err)
		}
		var strict func(value any, shape map[string]any, path string)
		strict = func(value any, shape map[string]any, path string) {
			record, ok := value.(map[string]any)
			if !ok {
				interfaceSpecInvalid(path + " must be an object")
			}
			for key, child := range record {
				sampleChild, known := shape[key]
				if !known {
					interfaceSpecInvalid(path + " has unsupported field " + key)
				}
				if nested, ok := sampleChild.(map[string]any); ok {
					strict(child, nested, path+"."+key)
				}
			}
		}
		strict(access, sample, "Node "+id+" access")
		mode, _ := access.(map[string]any)["mode"].(string)
		if mode != "standard" && mode != "full" {
			interfaceSpecInvalid("Node " + id + " access requires mode:standard|full")
		}
		func() {
			defer func() {
				recovered := recover()
				if recovered == nil {
					return
				}
				if re, ok := recovered.(*RuntimeError); ok {
					interfaceSpecInvalid(re.Message)
				}
				interfaceSpecInvalid(panicMessage(recovered))
			}()
			ParseAccessPolicy(access, "Node "+id+" access")
		}()
	}
	inputs, _ := node["inputs"].(map[string]any)
	for port, ref := range inputs {
		record, _ := ref.(map[string]any)
		interfaceSpecAssertDeclared(definition, record, "Node "+id+" input "+port)
	}
	outputs, _ := node["outputs"].(map[string]any)
	for port, ref := range outputs {
		record, _ := ref.(map[string]any)
		interfaceSpecAssertDeclared(definition, record, "Node "+id+" output "+port)
	}
	submission, _ := node["submission"].(map[string]any)
	for _, required := range interfaceSpecStrings(submission["required"]) {
		if _, ok := outputs[required]; !ok {
			interfaceSpecInvalid("Node " + id + " requires undeclared output " + required)
		}
	}
	for _, anyOf := range interfaceSpecStrings(submission["requiredAnyOf"]) {
		if _, ok := outputs[anyOf]; !ok {
			interfaceSpecInvalid("Node " + id + " requiredAnyOf names undeclared output " + anyOf)
		}
	}
	if deliverable, ok := node["deliverable"]; ok && deliverable != nil {
		record, ok := deliverable.(map[string]any)
		if !ok {
			interfaceSpecInvalid("Node " + id + " deliverable must be an object")
		}
		path, _ := record["path"].(string)
		if strings.TrimSpace(path) == "" {
			interfaceSpecInvalid("Node " + id + " deliverable requires a path")
		}
		if strings.HasPrefix(path, "/") {
			interfaceSpecInvalid("Node " + id + " deliverable path must be a relative path inside the workspace")
		}
		for _, part := range regexp.MustCompile(`[\\/]`).Split(path, -1) {
			if part == ".." || part == "" {
				interfaceSpecInvalid("Node " + id + " deliverable path must be a relative path inside the workspace")
			}
		}
		namespace, _ := record["namespace"].(string)
		if !map[string]bool{"plans": true, "research": true, "reviews": true, "deliverables": true, "summaries": true}[namespace] {
			interfaceSpecInvalid("Node " + id + " deliverable namespace must be plans, research, reviews, deliverables or summaries")
		}
		if schema, present := record["schema"]; present && schema != nil {
			text, isString := schema.(string)
			if !isString || !interfaceSpecSchemaKind.MatchString(text) {
				interfaceSpecInvalid("Node " + id + " deliverable schema must be kind@version")
			}
		}
		name, _ := record["name"].(string)
		if !interfaceSpecDeliverableSlug.MatchString(strings.ToLower(name)) {
			interfaceSpecInvalid("Node " + id + " deliverable name must be a lowercase slug")
		}
	}
}

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
			if !isSafeInteger(timeout) || number < 1 || number > 86400000 {
				interfaceSpecInvalid("Module " + id + " has invalid operation timeout")
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

// ParseGraphDefinition accepts one whole v2 definition. Any defect refuses the whole definition.
// TODO(port): Go map iteration is not JSON insertion order, so the first reported defect can differ when several keys are wrong.
func ParseGraphDefinition(input any, depth ...int) GraphDefinition {
	level := 0
	if len(depth) > 0 {
		level = depth[0]
	}
	if level > 32 {
		interfaceSpecInvalid("Subgraph expansion exceeds 32 levels or contains recursive definitions")
	}
	raw := interfaceSpecAsMap(input)
	if !interfaceSpecVersionIs(raw["schemaVersion"], INTERFACE_SCHEMA_VERSION) {
		interfaceSpecInvalid(fmt.Sprintf("schemaVersion must be %d; JSON is the only formal format", INTERFACE_SCHEMA_VERSION))
	}
	name, _ := raw["name"].(string)
	if strings.TrimSpace(name) == "" {
		interfaceSpecInvalid("Definition requires a name")
	}
	for _, key := range []string{"protocols", "nodes", "modules", "edges", "inputs", "outputs"} {
		if raw[key] == nil {
			raw[key] = map[string]any{}
		}
		if _, ok := raw[key].(map[string]any); !ok {
			interfaceSpecInvalid("protocols, nodes, modules, edges, inputs and outputs must be maps")
		}
	}
	for _, pair := range []struct {
		key, what string
	}{{"protocols", "Protocol"}, {"nodes", "Node"}, {"modules", "Module"}, {"edges", "Edge"}} {
		record := raw[pair.key].(map[string]any)
		for key := range record {
			if strings.TrimSpace(key) == "" {
				interfaceSpecInvalid(pair.what + " id must not be blank")
			}
		}
	}
	if defaults, ok := raw["defaults"]; ok && defaults != nil {
		record, ok := defaults.(map[string]any)
		if !ok {
			interfaceSpecInvalid("Graph defaults must contain model, retry or budget settings")
		}
		for key := range record {
			if key != "model" && key != "retry" && key != "budget" {
				interfaceSpecInvalid("Graph defaults must contain model, retry or budget settings")
			}
		}
		interfaceSpecValidateSettings("Graph defaults", record)
	}
	definition := map[string]any{
		"schemaVersion": float64(INTERFACE_SCHEMA_VERSION),
		"name":          raw["name"],
		"protocols":     raw["protocols"],
		"nodes":         raw["nodes"],
		"modules":       raw["modules"],
		"edges":         raw["edges"],
		"inputs":        raw["inputs"],
		"outputs":       raw["outputs"],
	}
	if raw["defaults"] != nil {
		definition["defaults"] = raw["defaults"]
	}
	if raw["acceptance"] != nil {
		definition["acceptance"] = jsonClone(raw["acceptance"])
	}
	if completion, ok := raw["completion"].(map[string]any); ok {
		definition["completion"] = completion
	}
	if subgraphs, ok := raw["subgraphs"].([]any); ok {
		definition["subgraphs"] = subgraphs
	}
	if instances, ok := raw["subgraphInstances"].(map[string]any); ok {
		definition["subgraphInstances"] = instances
	}
	if raw["instances"] != nil {
		instances, instancesOK := raw["instances"].(map[string]any)
		templates, templatesOK := raw["templates"].(map[string]any)
		if !instancesOK || !templatesOK {
			interfaceSpecInvalid("Subgraph instances and templates must be maps")
		}
		definition["nodes"] = interfaceSpecCloneMap(definition["nodes"].(map[string]any))
		definition["modules"] = interfaceSpecCloneMap(definition["modules"].(map[string]any))
		definition["edges"] = interfaceSpecCloneMap(definition["edges"].(map[string]any))
		definition["protocols"] = interfaceSpecCloneMap(definition["protocols"].(map[string]any))
		definition["inputs"] = interfaceSpecCloneMap(definition["inputs"].(map[string]any))
		definition["outputs"] = interfaceSpecCloneMap(definition["outputs"].(map[string]any))
		if definition["subgraphInstances"] == nil {
			definition["subgraphInstances"] = map[string]any{}
		} else {
			definition["subgraphInstances"] = interfaceSpecCloneMap(definition["subgraphInstances"].(map[string]any))
		}
		for id, value := range instances {
			nodes := definition["nodes"].(map[string]any)
			modules := definition["modules"].(map[string]any)
			if id == "" || strings.ContainsAny(id, "./") || nodes[id] != nil || modules[id] != nil {
				interfaceSpecInvalid("Invalid or conflicting subgraph instance " + id)
			}
			record, ok := value.(map[string]any)
			templateName, _ := record["template"].(string)
			if !ok || templateName == "" || !isSafeInteger(record["version"]) || asFloatMust(record["version"]) < 1 {
				interfaceSpecInvalid("Subgraph " + id + " must pin a template and positive version")
			}
			declaration, _ := templates[templateName].(map[string]any)
			if declaration == nil || !interfaceSpecVersionIs(declaration["version"], asFloatMust(record["version"])) {
				interfaceSpecInvalid("Subgraph " + id + " template version is unavailable")
			}
			template := ParseGraphDefinition(declaration["definition"], level+1)
			expanded := ExpandSubgraph(ExpandInput{Instance: id, Template: template, TemplateVersion: int(asFloatMust(record["version"]))})
			protocols := definition["protocols"].(map[string]any)
			for name, protocol := range template.Protocols {
				if existing, ok := protocols[name]; ok && jsonStringify(existing) != jsonStringify(protocol) {
					interfaceSpecInvalid("Subgraph " + id + " conflicts with protocol " + name)
				}
				protocols[name] = protocol
			}
			for name, node := range expanded.Nodes {
				if nodes[name] != nil || modules[name] != nil {
					interfaceSpecInvalid("Duplicate expanded node " + name)
				}
				nodes[name] = node
			}
			for name, module := range expanded.Modules {
				if nodes[name] != nil || modules[name] != nil {
					interfaceSpecInvalid("Duplicate expanded module " + name)
				}
				modules[name] = module
			}
			edges := definition["edges"].(map[string]any)
			for name, edge := range expanded.Edges {
				key := id + "/" + name
				if edges[key] != nil {
					interfaceSpecInvalid("Duplicate expanded edge " + key)
				}
				edges[key] = edge
			}
			bindings := definition["subgraphInstances"].(map[string]any)
			bindings[id] = map[string]any{"template": templateName, "version": record["version"], "inputs": expanded.Inputs, "outputs": expanded.Outputs}
			for nestedID, nested := range template.SubgraphInstances {
				inputs := map[string]any{}
				for port, io := range nested.Inputs {
					io.To = id + "/" + io.To
					inputs[port] = io
				}
				outputs := map[string]any{}
				for port, io := range nested.Outputs {
					io.From = id + "/" + io.From
					outputs[port] = io
				}
				bindings[id+"/"+nestedID] = map[string]any{"template": nested.Template, "version": nested.Version, "inputs": inputs, "outputs": outputs}
			}
		}
		resolve := func(reference, kind string) string {
			dot := strings.Index(reference, ".")
			if dot < 0 {
				return reference
			}
			bindings := definition["subgraphInstances"].(map[string]any)
			instance, _ := bindings[reference[:dot]].(map[string]any)
			if instance == nil {
				if typed, ok := bindings[reference[:dot]].(SubgraphInstanceBinding); ok {
					port := reference[dot+1:]
					if kind == "input" {
						mapped, ok := typed.Inputs[port]
						if !ok {
							interfaceSpecInvalid("Unknown subgraph " + kind + " " + reference)
						}
						return mapped.To
					}
					mapped, ok := typed.Outputs[port]
					if !ok {
						interfaceSpecInvalid("Unknown subgraph " + kind + " " + reference)
					}
					return mapped.From
				}
				return reference
			}
			port := reference[dot+1:]
			side := "outputs"
			field := "from"
			if kind == "input" {
				side = "inputs"
				field = "to"
			}
			ports, _ := instance[side].(map[string]any)
			mapped, _ := ports[port].(map[string]any)
			if mapped == nil {
				interfaceSpecInvalid("Unknown subgraph " + kind + " " + reference)
			}
			text, _ := mapped[field].(string)
			return text
		}
		edges := definition["edges"].(map[string]any)
		for name, value := range edges {
			edge, ok := value.(map[string]any)
			if !ok {
				if typed, ok := value.(EdgeDefinition); ok {
					typed.From = resolve(typed.From, "output")
					typed.To = resolve(typed.To, "input")
					edges[name] = typed
				}
				continue
			}
			from, _ := edge["from"].(string)
			to, _ := edge["to"].(string)
			edge["from"] = resolve(from, "output")
			edge["to"] = resolve(to, "input")
		}
		for _, io := range definition["inputs"].(map[string]any) {
			record, ok := io.(map[string]any)
			if !ok {
				continue
			}
			target, _ := record["to"].(string)
			record["to"] = resolve(target, "input")
		}
		for _, io := range definition["outputs"].(map[string]any) {
			record, ok := io.(map[string]any)
			if !ok {
				continue
			}
			target, _ := record["from"].(string)
			record["from"] = resolve(target, "output")
		}
		keys := []string{}
		for key := range definition["subgraphInstances"].(map[string]any) {
			keys = append(keys, key)
		}
		definition["subgraphs"] = keys
	}
	if definition["acceptance"] != nil {
		items, ok := definition["acceptance"].([]any)
		if !ok || len(items) > 100 {
			interfaceSpecInvalid("Graph acceptance must be a list of at most 100 criteria")
		}
		ids := map[string]bool{}
		modules := definition["modules"].(map[string]any)
		nodes := definition["nodes"].(map[string]any)
		for _, item := range items {
			record, ok := item.(map[string]any)
			id, _ := record["id"].(string)
			description, _ := record["description"].(string)
			if !ok || strings.TrimSpace(id) == "" || ids[id] || strings.TrimSpace(description) == "" {
				interfaceSpecInvalid("Acceptance criteria require unique ids and descriptions")
			}
			ids[id] = true
			kind, _ := record["kind"].(string)
			allowed := []string{"id", "description", "kind"}
			if kind == "check" {
				moduleName, _ := record["module"].(string)
				module, _ := modules[moduleName].(map[string]any)
				if module == nil || module["type"] != "operation" {
					interfaceSpecInvalid("Acceptance " + id + " must name a host operation module")
				}
				allowed = append(allowed, "module")
			} else if kind == "review" {
				nodeName, _ := record["node"].(string)
				node, _ := nodes[nodeName].(map[string]any)
				recipe, _ := node["recipe"].(string)
				if strings.TrimSpace(recipe) == "" {
					interfaceSpecInvalid("Acceptance " + id + " must name an agent reviewer")
				}
				allowed = append(allowed, "node")
			} else if kind != "human" {
				interfaceSpecInvalid("Acceptance has unknown kind")
			}
			for key := range record {
				if !interfaceSpecContains(allowed, key) {
					interfaceSpecInvalid("Acceptance " + id + " has unknown fields")
				}
			}
		}
	}
	protocols := definition["protocols"].(map[string]any)
	for id, protocol := range protocols {
		func() {
			defer func() {
				recovered := recover()
				if recovered == nil {
					return
				}
				message := panicMessage(recovered)
				if re, ok := recovered.(*RuntimeError); ok {
					message = re.Message
				}
				interfaceSpecInvalid("Protocol " + id + " has an invalid schema: " + message)
			}()
			record, ok := protocol.(map[string]any)
			if !ok {
				record = interfaceSpecAsMap(protocol)
			}
			interfaceSpecCompile(record)
		}()
	}
	nodes := definition["nodes"].(map[string]any)
	for id, node := range nodes {
		record, ok := node.(map[string]any)
		if !ok {
			record = interfaceSpecAsMap(node)
			nodes[id] = record
		}
		interfaceSpecValidateNode(definition, id, record)
	}
	modules := definition["modules"].(map[string]any)
	for id, module := range modules {
		record, ok := module.(map[string]any)
		if !ok {
			record = interfaceSpecAsMap(module)
			modules[id] = record
		}
		interfaceSpecValidateModule(definition, id, record)
	}
	edges := definition["edges"].(map[string]any)
	for id, edgeValue := range edges {
		edge, ok := edgeValue.(map[string]any)
		if !ok {
			edge = interfaceSpecAsMap(edgeValue)
			edges[id] = edge
		}
		enabled, isBool := edge["enabled"].(bool)
		if !isBool || !enabled && edge["enabled"] != false {
			interfaceSpecInvalid("Edge " + id + " enabled must be an explicit boolean")
		}
		if _, isBool := edge["enabled"].(bool); !isBool {
			interfaceSpecInvalid("Edge " + id + " enabled must be an explicit boolean")
		}
		fromText, _ := edge["from"].(string)
		toText, _ := edge["to"].(string)
		from := interfaceSpecEndpointRef(definition, fromText, "output")
		to := interfaceSpecEndpointRef(definition, toText, "input")
		if from == nil {
			interfaceSpecInvalid("Edge " + id + " names unknown output endpoint " + fromText)
		}
		if to == nil {
			interfaceSpecInvalid("Edge " + id + " names unknown input endpoint " + toText)
		}
		interfaceSpecAssertSame(definition, from, to, "Edge "+id)
	}
	for name, io := range definition["inputs"].(map[string]any) {
		record, _ := io.(map[string]any)
		if record == nil {
			record = interfaceSpecAsMap(io)
		}
		target, _ := record["to"].(string)
		ref := interfaceSpecEndpointRef(definition, target, "input")
		if ref == nil {
			interfaceSpecInvalid("Graph input " + name + " names unknown endpoint " + target)
		}
		promised := map[string]any{"protocol": record["protocol"]}
		if record["version"] != nil {
			promised["version"] = record["version"]
		}
		interfaceSpecAssertSame(definition, promised, ref, "Graph input "+name)
	}
	for name, io := range definition["outputs"].(map[string]any) {
		record, _ := io.(map[string]any)
		if record == nil {
			record = interfaceSpecAsMap(io)
		}
		target, _ := record["from"].(string)
		ref := interfaceSpecEndpointRef(definition, target, "output")
		if ref == nil {
			interfaceSpecInvalid("Graph output " + name + " names unknown endpoint " + target)
		}
		promised := map[string]any{"protocol": record["protocol"]}
		if record["version"] != nil {
			promised["version"] = record["version"]
		}
		interfaceSpecAssertSame(definition, ref, promised, "Graph output "+name)
	}
	if completion, ok := definition["completion"].(map[string]any); ok {
		on, _ := completion["on"].(string)
		outputs := definition["outputs"].(map[string]any)
		if _, known := outputs[on]; !known {
			interfaceSpecInvalid("completion.on names undeclared graph output " + on)
		}
	}
	encoded, err := json.Marshal(definition)
	if err != nil {
		panic(err)
	}
	var parsed GraphDefinition
	if err := json.Unmarshal(encoded, &parsed); err != nil {
		panic(err)
	}
	if parsed.Protocols == nil {
		parsed.Protocols = map[string]ProtocolSpec{}
	}
	if parsed.Nodes == nil {
		parsed.Nodes = map[string]NodeDefinition{}
	}
	if parsed.Modules == nil {
		parsed.Modules = map[string]ModuleDefinition{}
	}
	if parsed.Edges == nil {
		parsed.Edges = map[string]EdgeDefinition{}
	}
	if parsed.Inputs == nil {
		parsed.Inputs = map[string]GraphIo{}
	}
	if parsed.Outputs == nil {
		parsed.Outputs = map[string]GraphOutput{}
	}
	return parsed
}

type interfaceSpecError struct {
	Keyword      string
	InstancePath string
	Message      string
	Params       map[string]any
}

var interfaceSpecKeywords = map[string]bool{
	"type": true, "properties": true, "required": true, "additionalProperties": true, "items": true,
	"minLength": true, "maxLength": true, "minimum": true, "maximum": true, "minItems": true, "maxItems": true,
	"enum": true, "const": true, "pattern": true, "version": true, "description": true, "title": true,
	"default": true, "examples": true, "$schema": true, "$id": true, "$comment": true, "format": true,
	"$ref": true, "anyOf": true, "oneOf": true, "allOf": true, "not": true, "if": true, "then": true, "else": true,
}

var interfaceSpecValidators []struct {
	signature string
	schema    map[string]any
}

func interfaceSpecCompile(spec map[string]any) map[string]any {
	signature := jsonStringify(spec)
	for _, cached := range interfaceSpecValidators {
		if cached.signature == signature {
			return cached.schema
		}
	}
	for key, value := range spec {
		if !interfaceSpecKeywords[key] {
			panic(fmt.Errorf("strict mode: unknown keyword: %q", key))
		}
		if key == "version" {
			if _, ok := value.(float64); !ok {
				panic(fmt.Errorf("keyword \"version\" value must be number"))
			}
		}
	}
	if len(interfaceSpecValidators) >= 1000 {
		interfaceSpecValidators = interfaceSpecValidators[1:]
	}
	interfaceSpecValidators = append(interfaceSpecValidators, struct {
		signature string
		schema    map[string]any
	}{signature, spec})
	return spec
}

func interfaceSpecCheck(schema map[string]any, value any, path string) *interfaceSpecError {
	if schema == nil {
		return nil
	}
	if types, ok := schema["type"].([]any); ok {
		matched := false
		names := []string{}
		for _, item := range types {
			name, _ := item.(string)
			names = append(names, name)
			if interfaceSpecTypeOK(name, value) {
				matched = true
			}
		}
		if !matched {
			return &interfaceSpecError{Keyword: "type", InstancePath: path, Message: "must be " + strings.Join(names, ","), Params: map[string]any{"type": strings.Join(names, ",")}}
		}
	} else if name, ok := schema["type"].(string); ok && !interfaceSpecTypeOK(name, value) {
		return &interfaceSpecError{Keyword: "type", InstancePath: path, Message: "must be " + name, Params: map[string]any{"type": name}}
	}
	if required, ok := schema["required"].([]any); ok {
		record, _ := value.(map[string]any)
		for _, item := range required {
			name, _ := item.(string)
			if record == nil || record[name] == nil && !interfaceSpecHasKey(record, name) {
				return &interfaceSpecError{Keyword: "required", InstancePath: path, Message: "must have required property '" + name + "'", Params: map[string]any{"missingProperty": name}}
			}
		}
	}
	if limit, ok := schema["minLength"].(float64); ok {
		text, _ := value.(string)
		if utf16Len(text) < int(limit) {
			return &interfaceSpecError{Keyword: "minLength", InstancePath: path, Message: fmt.Sprintf("must NOT have fewer than %v characters", limit)}
		}
	}
	if limit, ok := schema["minimum"].(float64); ok {
		number, ok := asFloat(value)
		if ok && number < limit {
			return &interfaceSpecError{Keyword: "minimum", InstancePath: path, Message: fmt.Sprintf("must be >= %v", limit)}
		}
	}
	if name, _ := schema["type"].(string); name == "integer" {
		if !interfaceSpecTypeOK("integer", value) {
			return &interfaceSpecError{Keyword: "type", InstancePath: path, Message: "must be integer", Params: map[string]any{"type": "integer"}}
		}
	}
	if properties, ok := schema["properties"].(map[string]any); ok {
		if record, ok := value.(map[string]any); ok {
			for key, child := range record {
				childSchema, ok := properties[key].(map[string]any)
				if !ok {
					continue
				}
				if err := interfaceSpecCheck(childSchema, child, path+"/"+interfaceSpecEscape(key)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func interfaceSpecHasKey(record map[string]any, key string) bool {
	if record == nil {
		return false
	}
	_, ok := record[key]
	return ok
}

func interfaceSpecEscape(key string) string {
	return strings.NewReplacer("~", "~0", "/", "~1").Replace(key)
}

func interfaceSpecTypeOK(name string, value any) bool {
	switch name {
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "string":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "null":
		return value == nil
	case "number":
		_, ok := asFloat(value)
		return ok
	case "integer":
		number, ok := asFloat(value)
		return ok && number == math.Trunc(number) && !math.IsNaN(number) && !math.IsInf(number, 0)
	default:
		return false
	}
}

// ValidateProtocolValue checks one value against the receiving protocol and never rewrites it.
func ValidateProtocolValue(spec ProtocolSpec, value Json, path string) *string {
	defer func() {
		_ = recover()
	}()
	validate := interfaceSpecCompile(spec)
	if err := interfaceSpecCheck(validate, value, ""); err == nil {
		return nil
	} else {
		hint := ""
		if spec["type"] == "object" && err.Keyword == "type" && err.InstancePath == "" && err.Params["type"] == "object" {
			if _, isString := value.(string); isString {
				hint = " Received a string; pass the object directly as the JSON value, not as a JSON-encoded string."
			}
		}
		root := path
		if root == "" {
			root = "(root)"
		}
		message := root + err.InstancePath + ": " + err.Message + hint
		return &message
	}
}
