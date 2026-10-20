package graph

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
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

func orderedInteger(raw string) bool {
	if raw == "" || strings.ContainsAny(raw, ".eE") {
		return false
	}
	_, err := strconv.ParseInt(raw, 10, 64)
	return err == nil
}

type orderedField struct {
	key   string
	value *orderedJSON
}

type orderedJSON struct {
	kind byte
	b    bool
	num  string
	str  string
	arr  []*orderedJSON
	obj  []orderedField
}

func (value *orderedJSON) clone() *orderedJSON {
	if value == nil {
		return nil
	}
	out := *value
	if value.arr != nil {
		out.arr = make([]*orderedJSON, len(value.arr))
		for i, item := range value.arr {
			out.arr[i] = item.clone()
		}
	}
	if value.obj != nil {
		out.obj = make([]orderedField, len(value.obj))
		for i, field := range value.obj {
			out.obj[i] = orderedField{key: field.key, value: field.value.clone()}
		}
	}
	return &out
}

func (value *orderedJSON) get(key string) (*orderedJSON, bool) {
	for _, field := range value.obj {
		if field.key == key {
			return field.value, true
		}
	}
	return nil, false
}

func (value *orderedJSON) set(key string, next *orderedJSON) {
	for i := range value.obj {
		if value.obj[i].key == key {
			value.obj[i].value = next
			return
		}
	}
	value.obj = append(value.obj, orderedField{key: key, value: next})
}

func (value *orderedJSON) any() any {
	switch value.kind {
	case 'n':
		return nil
	case 'b':
		return value.b
	case 'f':
		number, err := strconv.ParseFloat(value.num, 64)
		if err != nil {
			panic(err)
		}
		return number
	case 's':
		return value.str
	case 'a':
		out := make([]any, len(value.arr))
		for i, item := range value.arr {
			out[i] = item.any()
		}
		return out
	default:
		out := map[string]any{}
		for _, field := range value.obj {
			out[field.key] = field.value.any()
		}
		return out
	}
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

func orderedFromAny(record map[string]any) *orderedJSON {
	encoded, err := json.Marshal(record)
	if err != nil {
		panic(err)
	}
	value, err := parseOrderedJSON(string(encoded))
	if err != nil {
		panic(err)
	}
	return value
}

func (value *orderedJSON) pretty(indent int) string {
	pad := strings.Repeat(" ", indent)
	inner := strings.Repeat(" ", indent+2)
	switch value.kind {
	case 'n':
		return "null"
	case 'b':
		if value.b {
			return "true"
		}
		return "false"
	case 'f':
		return value.num
	case 's':
		return orderedString(value.str)
	case 'a':
		if len(value.arr) == 0 {
			return "[]"
		}
		var buf strings.Builder
		buf.WriteString("[\n")
		for i, item := range value.arr {
			buf.WriteString(inner)
			buf.WriteString(item.pretty(indent + 2))
			if i+1 != len(value.arr) {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(pad)
		buf.WriteByte(']')
		return buf.String()
	default:
		if len(value.obj) == 0 {
			return "{}"
		}
		var buf strings.Builder
		buf.WriteString("{\n")
		for i, field := range value.obj {
			buf.WriteString(inner)
			buf.WriteString(orderedString(field.key))
			buf.WriteString(": ")
			buf.WriteString(field.value.pretty(indent + 2))
			if i+1 != len(value.obj) {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(pad)
		buf.WriteByte('}')
		return buf.String()
	}
}

func orderedString(value string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		panic(err)
	}
	return strings.TrimRight(buf.String(), "\n")
}

type orderedParser struct {
	text string
	i    int
}

func parseOrderedJSON(text string) (*orderedJSON, error) {
	parser := &orderedParser{text: text}
	parser.skip()
	value, err := parser.value()
	if err != nil {
		return nil, err
	}
	parser.skip()
	if parser.i != len(parser.text) {
		return nil, errors.New("trailing json")
	}
	return value, nil
}

func (parser *orderedParser) skip() {
	for parser.i < len(parser.text) {
		c := parser.text[parser.i]
		if c == ' ' || c == '\n' || c == '\r' || c == '\t' {
			parser.i++
			continue
		}
		break
	}
}

func (parser *orderedParser) value() (*orderedJSON, error) {
	parser.skip()
	if parser.i >= len(parser.text) {
		return nil, errors.New("unexpected end of json")
	}
	switch parser.text[parser.i] {
	case 'n':
		if !strings.HasPrefix(parser.text[parser.i:], "null") {
			return nil, errors.New("invalid json")
		}
		parser.i += 4
		return &orderedJSON{kind: 'n'}, nil
	case 't':
		if !strings.HasPrefix(parser.text[parser.i:], "true") {
			return nil, errors.New("invalid json")
		}
		parser.i += 4
		return &orderedJSON{kind: 'b', b: true}, nil
	case 'f':
		if !strings.HasPrefix(parser.text[parser.i:], "false") {
			return nil, errors.New("invalid json")
		}
		parser.i += 5
		return &orderedJSON{kind: 'b'}, nil
	case '"':
		text, err := parser.string()
		if err != nil {
			return nil, err
		}
		return &orderedJSON{kind: 's', str: text}, nil
	case '[':
		parser.i++
		var items []*orderedJSON
		parser.skip()
		if parser.i < len(parser.text) && parser.text[parser.i] == ']' {
			parser.i++
			return &orderedJSON{kind: 'a', arr: items}, nil
		}
		for {
			item, err := parser.value()
			if err != nil {
				return nil, err
			}
			items = append(items, item)
			parser.skip()
			if parser.i >= len(parser.text) {
				return nil, errors.New("unterminated array")
			}
			if parser.text[parser.i] == ']' {
				parser.i++
				break
			}
			if parser.text[parser.i] != ',' {
				return nil, errors.New("expected comma")
			}
			parser.i++
		}
		return &orderedJSON{kind: 'a', arr: items}, nil
	case '{':
		parser.i++
		var fields []orderedField
		parser.skip()
		if parser.i < len(parser.text) && parser.text[parser.i] == '}' {
			parser.i++
			return &orderedJSON{kind: 'o', obj: fields}, nil
		}
		for {
			parser.skip()
			if parser.i >= len(parser.text) || parser.text[parser.i] != '"' {
				return nil, errors.New("expected key")
			}
			key, err := parser.string()
			if err != nil {
				return nil, err
			}
			parser.skip()
			if parser.i >= len(parser.text) || parser.text[parser.i] != ':' {
				return nil, errors.New("expected colon")
			}
			parser.i++
			item, err := parser.value()
			if err != nil {
				return nil, err
			}
			fields = append(fields, orderedField{key: key, value: item})
			parser.skip()
			if parser.i >= len(parser.text) {
				return nil, errors.New("unterminated object")
			}
			if parser.text[parser.i] == '}' {
				parser.i++
				break
			}
			if parser.text[parser.i] != ',' {
				return nil, errors.New("expected comma")
			}
			parser.i++
		}
		return &orderedJSON{kind: 'o', obj: fields}, nil
	default:
		start := parser.i
		for parser.i < len(parser.text) {
			c := parser.text[parser.i]
			if c == ',' || c == ']' || c == '}' || c == ' ' || c == '\n' || c == '\r' || c == '\t' {
				break
			}
			parser.i++
		}
		if start == parser.i {
			return nil, errors.New("invalid json")
		}
		return &orderedJSON{kind: 'f', num: parser.text[start:parser.i]}, nil
	}
}

func (parser *orderedParser) string() (string, error) {
	if parser.text[parser.i] != '"' {
		return "", errors.New("expected string")
	}
	parser.i++
	var buf strings.Builder
	for parser.i < len(parser.text) {
		c := parser.text[parser.i]
		if c == '"' {
			parser.i++
			return buf.String(), nil
		}
		if c == '\\' {
			parser.i++
			if parser.i >= len(parser.text) {
				return "", errors.New("bad escape")
			}
			esc := parser.text[parser.i]
			parser.i++
			switch esc {
			case '"', '\\', '/':
				buf.WriteByte(esc)
			case 'b':
				buf.WriteByte('\b')
			case 'f':
				buf.WriteByte('\f')
			case 'n':
				buf.WriteByte('\n')
			case 'r':
				buf.WriteByte('\r')
			case 't':
				buf.WriteByte('\t')
			case 'u':
				if parser.i+4 > len(parser.text) {
					return "", errors.New("bad unicode escape")
				}
				n, err := strconv.ParseInt(parser.text[parser.i:parser.i+4], 16, 32)
				if err != nil {
					return "", err
				}
				parser.i += 4
				runeValue := rune(n)
				if !utf8.ValidRune(runeValue) {
					return "", errors.New("bad unicode escape")
				}
				buf.WriteRune(runeValue)
			default:
				return "", errors.New("bad escape")
			}
			continue
		}
		buf.WriteByte(c)
		parser.i++
	}
	return "", errors.New("unterminated string")
}
