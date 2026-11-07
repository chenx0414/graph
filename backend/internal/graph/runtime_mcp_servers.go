package graph

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"encoding/json"
)

type McpServerRef struct {
	Name       string `json:"name"`
	Definition any    `json:"definition"`
}

type McpFact struct {
	Id      string
	Version string
	Kind    string
	Path    string
	Role    string
}

func McpServersFor(facts []McpFact, secrets map[string]string) []McpServerRef {
	servers := []McpServerRef{}
	for _, fact := range facts {
		if fact.Kind != "mcp" || (fact.Role != "" && fact.Role != "tool") || fact.Path == "" || strings.TrimSpace(fact.Id) == "" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(fact.Path, "capability.json"))
		if err != nil {
			panic(err)
		}
		var manifest any
		if err := json.Unmarshal(raw, &manifest); err != nil {
			panic(err)
		}
		declaration, _ := manifest.(map[string]any)
		if declaration == nil {
			declaration = map[string]any{}
		}
		input := McpAdapterServerDeclaration{}
		if value, ok := declaration["command"]; ok {
			input.Command = value
		}
		if value, ok := declaration["args"]; ok {
			input.Args = value
		}
		if value, ok := declaration["url"]; ok {
			input.Url = value
		}
		if value, ok := declaration["headers"]; ok {
			input.Headers = value
		}
		if value, ok := declaration["headersEnv"]; ok {
			input.HeadersEnv = value
		}
		if value, ok := declaration["env"]; ok {
			input.Env = value
		}
		definition := McpServerDefinitionFrom(input, secrets, fact.Path)
		if definition == nil {
			continue
		}
		servers = append(servers, McpServerRef{Name: McpAdapterServerName(fact.Id), Definition: definition})
	}
	return servers
}

type McpServerDefinition struct {
	Command    string
	Args       []string
	Env        map[string]string
	InheritEnv *bool
	Url        string
	Headers    map[string]string
}

type McpAdapterServerDeclaration struct {
	Command    any
	Args       any
	Url        any
	Headers    any
	HeadersEnv any
	Env        any
}

func mcpLiteralValue(value string) string {
	if strings.HasPrefix(value, "!") {
		return "!" + value
	}
	return value
}

func mcpStringMap(source any, label string) map[string]string {
	if source == nil {
		return nil
	}
	switch typed := source.(type) {
	case map[string]string:
		return typed
	case map[string]any:
		out := map[string]string{}
		for key, value := range typed {
			text, ok := value.(string)
			if !ok {
				Raise("capability_unavailable", label+" must be a string map")
			}
			out[key] = text
		}
		return out
	default:
		Raise("capability_unavailable", label+" must be a string map")
	}
	return nil
}

func mcpStringList(source any, label string) []string {
	if source == nil {
		return nil
	}
	switch typed := source.(type) {
	case []string:
		return typed
	case []any:
		out := make([]string, len(typed))
		for i, value := range typed {
			text, ok := value.(string)
			if !ok {
				Raise("capability_unavailable", label+" must be a list of strings")
			}
			out[i] = text
		}
		return out
	default:
		Raise("capability_unavailable", label+" must be a list of strings")
	}
	return nil
}

func mcpLookup(secrets map[string]string, name string) (string, bool) {
	if secrets != nil {
		if value, ok := secrets[name]; ok {
			return value, true
		}
	}
	return os.LookupEnv(name)
}

func HeaderValues(headers, headersEnv any, secrets map[string]string) map[string]string {
	values := map[string]string{}
	merge := func(source any, resolveValue func(string) string, label string) {
		mapped := mcpStringMap(source, label)
		if mapped == nil {
			return
		}
		for header, value := range mapped {
			values[header] = mcpLiteralValue(resolveValue(value))
		}
	}
	merge(headers, func(value string) string { return value }, "MCP manifest headers")
	merge(headersEnv, func(name string) string {
		value, ok := mcpLookup(secrets, name)
		if !ok || value == "" {
			Raise("capability_unavailable", "MCP manifest requires environment variable "+name)
		}
		return value
	}, "MCP manifest headersEnv")
	return values
}

var (
	mcpBraceVar  = regexp.MustCompile(`^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$`)
	mcpDollarVar = regexp.MustCompile(`^\$([A-Za-z_][A-Za-z0-9_]*)$`)
)

func mcpWholeReference(value string) string {
	if match := mcpBraceVar.FindStringSubmatch(value); match != nil {
		return match[1]
	}
	if match := mcpDollarVar.FindStringSubmatch(value); match != nil {
		return match[1]
	}
	return ""
}

func EnvironmentValues(env any, secrets map[string]string) map[string]string {
	mapped := mcpStringMap(env, "MCP manifest env")
	if mapped == nil {
		return nil
	}
	values := map[string]string{}
	for name, rawValue := range mapped {
		if reference := mcpWholeReference(rawValue); reference != "" {
			value, ok := mcpLookup(secrets, reference)
			if !ok {
				Raise("capability_unavailable", "MCP manifest requires environment variable "+reference)
			}
			values[name] = mcpLiteralValue(value)
			continue
		}
		values[name] = mcpLiteralValue(rawValue)
	}
	return values
}

func McpAdapterServerName(id string) string {
	return id
}

func McpServerDefinitionFrom(declaration McpAdapterServerDeclaration, secrets map[string]string, capabilityDir string) *McpServerDefinition {
	urlText, _ := declaration.Url.(string)
	urlText = strings.TrimSpace(urlText)
	if urlText != "" {
		parsed, err := url.Parse(urlText)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			Raise("capability_unavailable", "Remote MCP url is invalid: "+urlText)
		}
		if parsed.Scheme != "https" && parsed.Scheme != "http" {
			Raise("capability_unavailable", "Remote MCP supports http and https, not "+parsed.Scheme+":")
		}
		if parsed.User != nil {
			Raise("capability_unavailable", "Remote MCP urls cannot embed credentials")
		}
		headers := HeaderValues(declaration.Headers, declaration.HeadersEnv, secrets)
		definition := &McpServerDefinition{Url: urlText}
		if len(headers) > 0 {
			definition.Headers = headers
		}
		return definition
	}
	command, _ := declaration.Command.(string)
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}
	args := mcpStringList(declaration.Args, "MCP manifest args")
	var resolved []string
	if args != nil {
		resolved = make([]string, len(args))
		for i, value := range args {
			resolved[i] = mcpDeclaredArg(capabilityDir, value, secrets)
		}
	}
	env := EnvironmentValues(declaration.Env, secrets)
	inherit := false
	definition := &McpServerDefinition{Command: command, InheritEnv: &inherit}
	if resolved != nil {
		definition.Args = resolved
	}
	if env != nil {
		definition.Env = env
	}
	return definition
}

func mcpDeclaredArg(capabilityDir, value string, secrets map[string]string) (out string) {
	relative := strings.HasPrefix(value, "./") || strings.HasPrefix(value, "../")
	if relative && capabilityDir == "" {
		Raise("capability_unavailable", "MCP manifest declares a capability directory-relative arg but the capability directory is unknown")
	}
	defer func() {
		if rec := recover(); rec != nil {
			if _, ok := rec.(*RuntimeError); ok {
				panic(rec)
			}
			message := ""
			if err, ok := rec.(error); ok {
				message = err.Error()
			} else {
				message = panicText(rec)
			}
			Raise("capability_unavailable", message)
		}
	}()
	return ResolveManifestArg(capabilityDir, value, secrets)
}

func ResolveManifestArg(snapshot, value string, env map[string]string) string {
	if reference := mcpWholeReference(value); reference != "" {
		resolved, ok := env[reference]
		if !ok {
			resolved, ok = os.LookupEnv(reference)
		}
		if !ok {
			panic(mcpMissingEnv(reference))
		}
		return resolved
	}
	if strings.HasPrefix(value, "./") || strings.HasPrefix(value, "../") {
		return filepath.Join(snapshot, value)
	}
	return value
}

type mcpEnvError struct{ name string }

func (err mcpEnvError) Error() string {
	return "Environment variable " + err.name + " is not set"
}

func mcpMissingEnv(name string) error { return mcpEnvError{name: name} }
