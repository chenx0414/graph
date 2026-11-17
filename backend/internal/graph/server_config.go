package graph

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"encoding/json"
)

type CredentialConfig struct {
	DisplayName        string `json:"displayName,omitempty"`
	SecretRef          string `json:"secretRef"`
	SharedLimitGroupId string `json:"sharedLimitGroupId,omitempty"`
	Platform           string `json:"platform,omitempty"`
}

type LimitsConfig struct {
	Credentials         map[string]int `json:"credentials"`
	SharedGroups        map[string]int `json:"sharedGroups"`
	AgentExecutions     int            `json:"agentExecutions"`
	ProgramExecutions   int            `json:"programExecutions"`
	MaxAgents           int            `json:"maxAgents"`
	SpawnDepth          int            `json:"spawnDepth"`
	ChildrenPerAgent    int            `json:"childrenPerAgent"`
}

type GraphModels struct {
	Entries []ConfiguredModel `json:"entries"`
}

type GraphCodemode struct {
	Enabled bool `json:"enabled"`
	TimeoutMs *int `json:"timeoutMs,omitempty"`
}

type ConfiguredModel struct {
	ModelEntry
	ID           string `json:"-"`
	BaseURL      string `json:"-"`
	API          string `json:"-"`
	CredentialID string `json:"-"`
	ModelID      string `json:"-"`
}

type GraphConfig struct {
	Path                  *string                     `json:"path"`
	Configured            bool                        `json:"configured"`
	Projects              []ProjectConfig             `json:"projects"`
	Models                *GraphModels                `json:"models"`
	Credentials           map[string]CredentialConfig `json:"credentials"`
	Limits                LimitsConfig                `json:"limits"`
	MasterModel           string                      `json:"masterModel"`
	PiExtensionAutoUpdate bool                        `json:"piExtensionAutoUpdate"`
	Codemode              GraphCodemode               `json:"codemode"`
}

type CredentialSecret struct {
	Configured bool
	SecretRef  string
	Value      *string
}

var (
	configSecretRef = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	configFieldLead = regexp.MustCompile(`^[A-Za-z0-9_$.\[\]-]+`)
	configHeader    = regexp.MustCompile(`^[A-Za-z0-9!#$%&'*+.^_` + "`" + `|~-]+$`)
)

func configInvalid(message string) {
	field := message
	if lead := configFieldLead.FindString(message); lead != "" {
		field = lead
	}
	RaiseField("invalid_config", message, field)
}

const (
	DefaultMaxAgents        = 1024
	DefaultSpawnDepth       = 4
	DefaultChildrenPerAgent = 16
)

func EmptyGraphConfig() GraphConfig {
	return GraphConfig{
		Path: nil, Configured: false, Projects: []ProjectConfig{}, Models: nil,
		Credentials: map[string]CredentialConfig{},
		Limits: LimitsConfig{
			Credentials:       map[string]int{},
			SharedGroups:      map[string]int{},
			AgentExecutions:   DefaultAgentExecutions,
			ProgramExecutions: DefaultProgramExecutions,
			MaxAgents:         DefaultMaxAgents,
			SpawnDepth:        DefaultSpawnDepth,
			ChildrenPerAgent:  DefaultChildrenPerAgent,
		},
		PiExtensionAutoUpdate: true,
	}
}

func DefaultConfigPath(cwd string) string {
	return filepath.Join(cwd, "graph.config.json")
}

func DefaultStateDir(env map[string]string) string {
	home := strings.TrimSpace(env["HOME"])
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	base := strings.TrimSpace(env["XDG_STATE_HOME"])
	if base == "" {
		base = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(base, "graph")
}

func asObject(value any, path string) map[string]any {
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		configInvalid(path + " must be an object")
	}
	return object
}

func configAsArray(value any, path string) []any {
	items, ok := value.([]any)
	if !ok {
		configInvalid(path + " must be an array")
	}
	return items
}

func configAsString(value any, path string) string {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		configInvalid(path + " must be a nonempty string")
	}
	return strings.TrimSpace(text)
}

func configOptionalBool(value any, path string, present bool) *bool {
	if !present {
		return nil
	}
	flag, ok := value.(bool)
	if !ok {
		configInvalid(path + " must be a boolean")
	}
	return &flag
}

func configFiniteInt(value any) (int, bool) {
	switch n := value.(type) {
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n > 9007199254740991 || n < -9007199254740991 {
			return 0, false
		}
		return int(n), true
	case int:
		return n, true
	case int64:
		if n > 9007199254740991 || n < -9007199254740991 {
			return 0, false
		}
		return int(n), true
	case json.Number:
		parsed, err := n.Float64()
		if err != nil {
			return 0, false
		}
		return configFiniteInt(parsed)
	default:
		return 0, false
	}
}
