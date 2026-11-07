package graph

import (
	"regexp"
	"sync"
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
	Recipe       string `json:"recipe"`
	Task         string `json:"task"`
	Instructions string `json:"instructions,omitempty"`
	Harness     map[string]string      `json:"harness,omitempty"`
	Workspace   *NodeWorkspace         `json:"workspace,omitempty"`
	Access      map[string]any         `json:"access,omitempty"`
	Acceptance  []string               `json:"acceptance,omitempty"`
	Submission  NodeSubmission         `json:"submission"`
	Deliverable *NodeDeliverable       `json:"deliverable,omitempty"`
	Integrate   *bool                  `json:"integrate,omitempty"`
	Inputs      map[string]ProtocolRef `json:"inputs"`
	Outputs     map[string]ProtocolRef `json:"outputs"`
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

func interfaceSpecJSONEqual(left, right any) bool {
	return jsonStringify(left) == jsonStringify(right)
}

func interfaceSpecPattern(pattern string) (*regexp.Regexp, error) {
	interfaceSpecPatternsMutex.Lock()
	defer interfaceSpecPatternsMutex.Unlock()
	if compiled, ok := interfaceSpecPatterns[pattern]; ok {
		return compiled, nil
	}
	compiled, err := regexp.Compile(pattern)
	if err != nil {
		return nil, err
	}
	if len(interfaceSpecPatterns) >= 256 {
		interfaceSpecPatterns = map[string]*regexp.Regexp{}
	}
	interfaceSpecPatterns[pattern] = compiled
	return compiled, nil
}

var interfaceSpecPatterns = map[string]*regexp.Regexp{}

var interfaceSpecPatternsMutex sync.Mutex

func interfaceSpecTypeNames(value any) ([]string, bool) {
	switch typed := value.(type) {
	case string:
		return []string{typed}, true
	case []any:
		names := []string{}
		for _, item := range typed {
			name, _ := item.(string)
			names = append(names, name)
		}
		return names, true
	}
	return nil, false
}

func interfaceSpecTypeKnown(name string) bool {
	switch name {
	case "object", "array", "string", "boolean", "null", "number", "integer":
		return true
	}
	return false
}
