package graph

import (
	"fmt"
	"regexp"
	"strings"

	"encoding/json"
)

type CapabilityConfigField struct {
	Env    string `json:"env"`
	Label  string `json:"label"`
	Secret bool   `json:"secret"`
	Reason string `json:"reason"`
}

type CapabilityConfigView struct {
	Id         string                  `json:"id"`
	Version    string                  `json:"version"`
	Name       string                  `json:"name"`
	Kind       string                  `json:"kind"`
	Source     string                  `json:"source"`
	Fields     []CapabilityConfigField `json:"fields"`
	Configured []string                `json:"configured"`
	Missing    []string                `json:"missing"`
	Ready      bool                    `json:"ready"`
	Error      string                  `json:"error,omitempty"`
}

var (
	envRefPattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`)
	secretEnv     = regexp.MustCompile(`(?i)(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)`)
	secretReason  = regexp.MustCompile(`(?i)authorization|api[-_ ]?key|token|password|secret`)
)

func capabilityConfigEnvRefs(value any) []string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	matches := envRefPattern.FindAllStringSubmatch(text, -1)
	var refs []string
	for _, match := range matches {
		name := match[1]
		if name == "" {
			name = match[2]
		}
		if name != "" {
			refs = append(refs, name)
		}
	}
	return refs
}

func capabilityConfigFieldName(env string) string {
	words := strings.Split(strings.ToLower(env), "_")
	for i, word := range words {
		if word == "" {
			continue
		}
		words[i] = strings.ToUpper(word[:1]) + word[1:]
	}
	return strings.Join(words, " ")
}

func capabilityConfigSecret(env, reason string) bool {
	return secretEnv.MatchString(env) || secretReason.MatchString(reason)
}

func capabilityConfigObject(value any) map[string]any {
	if value == nil {
		return nil
	}
	if object, ok := value.(map[string]any); ok {
		return object
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var object map[string]any
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil
	}
	return object
}

func CapabilityConfigViewOf(record CapabilityRecord, values map[string]string) (view CapabilityConfigView) {
	defer func() {
		if recovered := recover(); recovered != nil {
			message := fmt.Sprint(recovered)
			if err, ok := recovered.(error); ok {
				message = err.Error()
			}
			view = CapabilityConfigView{
				Id: record.Id, Version: record.Version, Name: capabilityConfigName(record), Kind: record.Kind, Source: record.Source,
				Fields: []CapabilityConfigField{}, Configured: []string{}, Missing: []string{}, Ready: false, Error: message,
			}
		}
	}()
	manifest := capabilityConfigObject(nil)
	snapshot := capabilityConfigObject(record.Snapshot)
	if snapshot != nil {
		manifest = capabilityConfigObject(snapshot["manifest"])
	}
	if manifest == nil {
		manifest = capabilityConfigObject(ReadCapabilityManifest(record.Source))
	}
	fields := []CapabilityConfigField{}
	seen := map[string]bool{}
	add := func(env, reason string) {
		if env == "" || seen[env] {
			return
		}
		seen[env] = true
		fields = append(fields, CapabilityConfigField{
			Env: env, Label: capabilityConfigFieldName(env), Secret: capabilityConfigSecret(env, reason), Reason: reason,
		})
	}
	for _, header := range sortedKeys(stringMap(manifest["headersEnv"])) {
		add(stringMap(manifest["headersEnv"])[header], "请求头 "+header)
	}
	for _, name := range sortedKeys(stringMap(manifest["env"])) {
		for _, env := range capabilityConfigEnvRefs(stringMap(manifest["env"])[name]) {
			add(env, "环境变量 "+name)
		}
	}
	for _, arg := range stringList(manifest["args"]) {
		for _, env := range capabilityConfigEnvRefs(arg) {
			add(env, "启动参数")
		}
	}
	for _, domain := range stringList(manifest["networkDomains"]) {
		for _, env := range capabilityConfigEnvRefs(domain) {
			add(env, "网络域名")
		}
	}
	provisioning := capabilityConfigObject(manifest["provisioning"])
	for _, domain := range stringList(provisioning["domains"]) {
		for _, env := range capabilityConfigEnvRefs(domain) {
			add(env, "预置网络域名")
		}
	}
	for _, env := range capabilityConfigEnvRefs(manifest["url"]) {
		add(env, "远程地址")
	}
	configured := []string{}
	missing := []string{}
	for _, field := range fields {
		if strings.TrimSpace(values[field.Env]) != "" {
			configured = append(configured, field.Env)
		} else {
			missing = append(missing, field.Env)
		}
	}
	if configured == nil {
		configured = []string{}
	}
	if missing == nil {
		missing = []string{}
	}
	return CapabilityConfigView{
		Id: record.Id, Version: record.Version, Name: capabilityConfigName(record), Kind: record.Kind, Source: record.Source,
		Fields: fields, Configured: configured, Missing: missing, Ready: len(missing) == 0,
	}
}

func capabilityConfigName(record CapabilityRecord) string {
	if record.Name != "" {
		return record.Name
	}
	return record.Id
}

func stringMap(value any) map[string]string {
	out := map[string]string{}
	switch typed := value.(type) {
	case map[string]string:
		return typed
	case map[string]any:
		for key, item := range typed {
			if text, ok := item.(string); ok {
				out[key] = text
			}
		}
	}
	return out
}

func stringList(value any) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		var out []string
		for _, item := range typed {
			if text, ok := item.(string); ok {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

func CapabilityConfigViews(records []CapabilityRecord, values map[string]string) []CapabilityConfigView {
	views := []CapabilityConfigView{}
	for _, record := range records {
		view := CapabilityConfigViewOf(record, values)
		if len(view.Fields) > 0 || view.Error != "" {
			views = append(views, view)
		}
	}
	return views
}
