package graph

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"encoding/json"
)

// CredentialConfig names an environment variable. The secret value is never stored.
type CredentialConfig struct {
	DisplayName        string `json:"displayName,omitempty"`
	SecretRef          string `json:"secretRef"`
	SharedLimitGroupId string `json:"sharedLimitGroupId,omitempty"`
	Platform           string `json:"platform,omitempty"`
}

// LimitsConfig is the token-cap table. A nil default budget means unlimited.
type LimitsConfig struct {
	Credentials         map[string]int `json:"credentials"`
	SharedGroups        map[string]int `json:"sharedGroups"`
}

// GraphModels is the configured directory and grade preferences.
type GraphModels struct {
	Entries     []ConfiguredModel   `json:"entries"`
	Preferences map[string][]string `json:"preferences"`
}

// GraphCodemode is the codemode block of the configuration.
//
// The kernel has codemode built in, and Graph offers it by default: the
// sandbox changes how a call is written, not whether it is admitted, so a
// session that never asked for one still gets the same admission. The
// configuration turns it off when a deployment wants the model to call
// tools one by one.
type GraphCodemode struct {
	Enabled bool `json:"enabled"`
	// TimeoutMs is the deadline of one script, in milliseconds. Zero is the
	// kernel's own default.
	TimeoutMs *int `json:"timeoutMs,omitempty"`
}

// ConfiguredModel is a ModelEntry that always names its credential.
// ID, BaseURL, API, CredentialID and ModelID mirror the embedded entry for callers
// that spell those fields the way server_start.go does.
type ConfiguredModel struct {
	ModelEntry
	ID           string `json:"-"`
	BaseURL      string `json:"-"`
	API          string `json:"-"`
	CredentialID string `json:"-"`
	ModelID      string `json:"-"`
}

// GraphConfig is the versioned on-disk configuration.
type GraphConfig struct {
	Path                  *string                     `json:"path"`
	Configured            bool                        `json:"configured"`
	Projects              []ProjectConfig             `json:"projects"`
	Models                *GraphModels                `json:"models"`
	Credentials           map[string]CredentialConfig `json:"credentials"`
	Limits                LimitsConfig                `json:"limits"`
	Access                AccessPolicy                `json:"access"`
	PiExtensionAutoUpdate bool                        `json:"piExtensionAutoUpdate"`
	Codemode              GraphCodemode               `json:"codemode"`
}

// CredentialSecret is one resolved environment binding.
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

// EmptyGraphConfig is the unconfigured document.
func EmptyGraphConfig() GraphConfig {
	return GraphConfig{
		Path: nil, Configured: false, Projects: []ProjectConfig{}, Models: nil,
		Credentials:           map[string]CredentialConfig{},
		Limits:                LimitsConfig{Credentials: map[string]int{}, SharedGroups: map[string]int{}},
		Access:                FullAccessPolicy(),
		PiExtensionAutoUpdate: true,
	}
}

// DefaultConfigPath is graph.config.json beside the working directory.
func DefaultConfigPath(cwd string) string {
	return filepath.Join(cwd, "graph.config.json")
}

// DefaultStateDir follows XDG_STATE_HOME, then ~/.local/state/graph.
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
