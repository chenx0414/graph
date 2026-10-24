package graph

// The configuration document the daemon runs on, and the revisions
// of it.
//
// A save is checked against the revision the caller saw, so two
// people saving at once cannot quietly overwrite each other.
import (
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

// ConfigSnapshot is one read of the on-disk configuration.

type ConfigSnapshot struct {
	Revision int         `json:"revision"`
	Config   GraphConfig `json:"config"`
}

// ConfigSaveResult is the outcome of one atomic save.

type ConfigSaveResult struct {
	Revision int         `json:"revision"`
	Config   GraphConfig `json:"config"`
	Applied  bool        `json:"applied"`
	Reason   *string     `json:"reason,omitempty"`
}

// ConfigApproval is the live candidate verdict. A rejection leaves the file untouched.

type ConfigApproval struct {
	Applied bool
	Reason  *string
}

// ConfigStore is a file-backed configuration with a monotonic revision and a cross-process lock.

type ConfigStore struct {
	Path     string
	revision int
}

// OpenConfigStore reads the current revision and returns the store.

func OpenConfigStore(path string) *ConfigStore {
	current := readConfigRevision(path)
	return &ConfigStore{Path: path, revision: current.revision}
}

// Revision is the revision last observed by this store.

func (store *ConfigStore) Revision() int { return store.revision }

// Snapshot re-reads the file and the parsed configuration.

func (store *ConfigStore) Snapshot() ConfigSnapshot {
	current := readConfigRevision(store.Path)
	store.revision = current.revision
	return ConfigSnapshot{Revision: store.revision, Config: LoadGraphConfig(store.Path)}
}

// Save replaces the document when expectedRevision still matches.
// A nil env skips credential-group checks. A nil approve skips the live verdict.

func (store *ConfigStore) Save(document any, expectedRevision int, env map[string]string, approve func(GraphConfig, int) ConfigApproval) ConfigSaveResult {
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

// SanitizeConfig is the browser view. Secret values are never included.

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
			record["tier"] = ModelTier(entry.Grade)
			record["thinkingOptions"] = ThinkingOptionsFor(entry.ModelEntry)
			entries[i] = record
		}
		models = map[string]any{"entries": entries, "preferences": config.Models.Preferences}
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
		"access": config.Access, "skills": config.Skills,
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
