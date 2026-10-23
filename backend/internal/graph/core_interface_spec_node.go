package graph

import (
	"encoding/json"
	"regexp"
	"strings"
)

var interfaceSpecDeliverableSlug = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`)
var interfaceSpecSchemaKind = regexp.MustCompile(`^([a-z][a-z0-9._-]*)@([1-9]\d*)$`)

// interfaceSpecHarnessRoles are the role files a node's harness may replace.
var interfaceSpecHarnessRoles = map[string]bool{"common": true, "main": true, "worker": true, "reviewer": true}

// interfaceSpecValidateHarness checks the prompt overrides of one node.
//
// The keys name prompt files of the editable library. Only those files are
// replaceable: a harness changes what the agent is told, not what the host
// enforces.
func interfaceSpecValidateHarness(id string, raw any) {
	record, ok := raw.(map[string]any)
	if !ok {
		interfaceSpecInvalid("Node " + id + " harness must be an object of prompt key to text")
	}
	if len(record) == 0 {
		interfaceSpecInvalid("Node " + id + " harness must replace at least one prompt")
	}
	if len(record) > 6 {
		interfaceSpecInvalid("Node " + id + " harness replaces at most 6 prompts")
	}
	for key, value := range record {
		text, isString := value.(string)
		if !isString || strings.TrimSpace(text) == "" {
			interfaceSpecInvalid("Node " + id + " harness " + key + " must be a non-empty string")
		}
		if len(text) > 20_000 {
			interfaceSpecInvalid("Node " + id + " harness " + key + " must be at most 20000 characters")
		}
		switch {
		case strings.HasPrefix(key, "agents/") && strings.HasSuffix(key, ".md"):
			if !interfaceSpecHarnessKeyAgent(key) {
				interfaceSpecInvalid("Node " + id + " harness " + key + " must name an agent identity file")
			}
		case strings.HasPrefix(key, "rules/") && strings.HasSuffix(key, ".md"),
			strings.HasPrefix(key, "tools/") && strings.HasSuffix(key, ".md"):
			role := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(key, "rules/"), "tools/"), ".md")
			if !interfaceSpecHarnessRoles[role] {
				interfaceSpecInvalid("Node " + id + " harness " + key + " must name a common, main, worker or reviewer file")
			}
		case key == "runtime/node.md":
		default:
			interfaceSpecInvalid("Node " + id + " harness " + key + " is not a replaceable prompt file")
		}
	}
}

// interfaceSpecHarnessKeyAgent accepts an agent identity file name.
func interfaceSpecHarnessKeyAgent(key string) bool {
	id := strings.TrimSuffix(strings.TrimPrefix(key, "agents/"), ".md")
	return id != "" && !strings.ContainsAny(id, "/\\ \t")
}

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
		"harness": true,
	}
	for key := range node {
		if !allowed[key] {
			interfaceSpecInvalid("Node " + id + " has unsupported field " + key + "; use named interfaces and explicit edges for graph execution")
		}
	}
	if harness, ok := node["harness"]; ok && harness != nil {
		interfaceSpecValidateHarness(id, harness)
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
