package graph

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type ConfigSnapshot struct {
	Revision int         `json:"revision"`
	Config   GraphConfig `json:"config"`
}

type ConfigSaveResult struct {
	Revision int         `json:"revision"`
	Config   GraphConfig `json:"config"`
	Applied  bool        `json:"applied"`
	Reason   *string     `json:"reason,omitempty"`
}

type ConfigApproval struct {
	Applied bool
	Reason  *string
}

type ConfigStore struct {
	Path     string
	revision int
	StateDir string
}

func OpenConfigStore(path string) *ConfigStore {
	current := readConfigRevision(path)
	return &ConfigStore{Path: path, revision: current.revision}
}

func (store *ConfigStore) OwnStateDir(dir string) *ConfigStore {
	store.StateDir = dir
	return store
}

func liveApplicationConfigPath() string {
	home := strings.TrimSpace(os.Getenv("HOME"))
	if home == "" {
		resolved, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		home = resolved
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Graph", "graph.config.json")
	case "windows":
		if appData := strings.TrimSpace(os.Getenv("APPDATA")); appData != "" {
			return filepath.Join(appData, "Graph", "graph.config.json")
		}
		return ""
	default:
		return filepath.Join(home, ".config", "Graph", "graph.config.json")
	}
}

func (store *ConfigStore) liveConfigRefusal() string {
	live := liveApplicationConfigPath()
	if live == "" || !configSamePath(store.Path, live) {
		return ""
	}
	claimed := filepath.Join(filepath.Dir(live), "state")
	if store.StateDir != "" && configSamePath(store.StateDir, claimed) {
		return ""
	}
	return "The live application configuration " + live + " is not writable from here: it belongs to the Graph " +
		"installation whose state directory is " + claimed + ". A daemon started for a test, a check or a node writes " +
		"only the --config file it was given; change the live configuration from the app's settings page."
}

func configSamePath(left, right string) bool {
	return configResolvedPath(left) == configResolvedPath(right)
}

func configResolvedPath(path string) string {
	cleaned := filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		return resolved
	}
	if resolved, err := filepath.EvalSymlinks(filepath.Dir(cleaned)); err == nil {
		return filepath.Join(resolved, filepath.Base(cleaned))
	}
	return cleaned
}

func (store *ConfigStore) Revision() int { return store.revision }

func (store *ConfigStore) Snapshot() ConfigSnapshot {
	current := readConfigRevision(store.Path)
	store.revision = current.revision
	return ConfigSnapshot{Revision: store.revision, Config: LoadGraphConfig(store.Path)}
}

func (store *ConfigStore) Save(document any, expectedRevision int, env map[string]string, approve func(GraphConfig, int) ConfigApproval) ConfigSaveResult {
	if refusal := store.liveConfigRefusal(); refusal != "" {
		Raise("config_protected", refusal)
	}
	lockPath := store.Path + ".lock"
	var lock *os.File
	var err error
	for attempt := 0; attempt < 40; attempt++ {
		lock, err = os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) {
			panic(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if lock == nil {
		Raise("config_locked", "Config is locked by another editor: "+store.Path)
	}
	defer func() {
		_ = lock.Close()
		_ = os.Remove(lockPath)
	}()
	current := readConfigRevision(store.Path)
	if current.revision != expectedRevision {
		Raise("config_conflict", "Config changed: expected revision "+itoa(expectedRevision)+", found "+itoa(current.revision)+"; reload before saving")
	}
	next := configDocument(document)
	next.set("version", &orderedJSON{kind: 'f', num: "1"})
	next.set("revision", &orderedJSON{kind: 'f', num: itoa(current.revision + 1)})
	parsed := ParseGraphConfig(next.any(), store.Path)
	if env != nil {
		AssertCredentialGroups(parsed, env)
	}
	if approve != nil {
		verdict := approve(parsed, current.revision+1)
		if !verdict.Applied {
			result := ConfigSaveResult{Revision: current.revision, Config: parsed, Applied: false}
			if verdict.Reason != nil && *verdict.Reason != "" {
				result.Reason = verdict.Reason
			}
			return result
		}
	}
	temporary := store.Path + "." + itoa(os.Getpid()) + "." + graphUUID() + ".tmp"
	payload := []byte(next.pretty(0) + "\n")
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		panic(err)
	}
	if err := os.Rename(temporary, store.Path); err != nil {
		panic(err)
	}
	store.revision = current.revision + 1
	return ConfigSaveResult{Revision: store.revision, Config: parsed, Applied: true}
}

func SanitizeConfig(config GraphConfig, env map[string]string) map[string]any {
	var models any
	if config.Models != nil {
		entries := make([]any, len(config.Models.Entries))
		for i, entry := range config.Models.Entries {
			encoded, err := json.Marshal(entry)
			if err != nil {
				panic(err)
			}
			var record map[string]any
			if err := json.Unmarshal(encoded, &record); err != nil {
				panic(err)
			}
			record["thinkingOptions"] = ThinkingOptionsFor(entry.ModelEntry)
			entries[i] = record
		}
		models = map[string]any{"entries": entries}
	}
	credentials := map[string]any{}
	for id, credential := range config.Credentials {
		view := map[string]any{"secretRef": credential.SecretRef, "configured": strings.TrimSpace(env[credential.SecretRef]) != ""}
		if credential.DisplayName != "" {
			view["displayName"] = credential.DisplayName
		}
		if credential.Platform != "" {
			view["platform"] = credential.Platform
		}
		if credential.SharedLimitGroupId != "" {
			view["sharedLimitGroupId"] = credential.SharedLimitGroupId
		}
		credentials[id] = view
	}
	return map[string]any{
		"path": config.Path, "configured": config.Configured, "piExtensionAutoUpdate": config.PiExtensionAutoUpdate,
		"projects": config.Projects, "models": models, "credentials": credentials, "limits": config.Limits,
		"access": config.Access,
	}
}

type configRevision struct {
	revision int
	document *orderedJSON
}

func readConfigRevision(path string) configRevision {
	text, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	value, err := parseOrderedJSON(string(text))
	if err != nil {
		panic(err)
	}
	if value.kind != 'o' {
		panic(errors.New("config document must be an object"))
	}
	raw, ok := value.get("revision")
	revision := 0
	if ok {
		if raw.kind != 'f' || !orderedInteger(raw.num) || strings.HasPrefix(raw.num, "-") {
			Raise("invalid_config", path+": revision must be a nonnegative integer")
		}
		n, err := strconv.Atoi(raw.num)
		if err != nil {
			Raise("invalid_config", path+": revision must be a nonnegative integer")
		}
		revision = n
	}
	return configRevision{revision: revision, document: value}
}

func configDocument(document any) *orderedJSON {
	switch typed := document.(type) {
	case *orderedJSON:
		if typed != nil && typed.kind == 'o' {
			return typed.clone()
		}
	case map[string]any:
		return orderedFromAny(typed)
	case json.RawMessage:
		if value, err := parseOrderedJSON(string(typed)); err == nil && value.kind == 'o' {
			return value
		}
	case []byte:
		if value, err := parseOrderedJSON(string(typed)); err == nil && value.kind == 'o' {
			return value
		}
	case string:
		if value, err := parseOrderedJSON(typed); err == nil && value.kind == 'o' {
			return value
		}
	}
	return &orderedJSON{kind: 'o'}
}
