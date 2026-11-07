package graph

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"encoding/json"
)

const assembleTeamUsage = `Usage: graphd assemble-team --url <console-url> --config <task.json> --out <new-team.json>

Assembles a reusable agent team from the capability library of a running Graph
console. It publishes one role recipe per role and writes the team definition
as an ordinary v2 graph definition.

Options:
  --url <url>         The running local Graph console (http://127.0.0.1:<port>)
  --config <path>     Team options JSON (required)
  --out <path>        Definition file to create (required; never overwritten)
  -h, --help          Print this help`

type assembleTeamCatalog struct {
	base         string
	cookie       string
	capabilities []CapabilityRecord
}

func (catalog *assembleTeamCatalog) Capability(id string, version string) *CapabilityRecord {
	return SelectCapabilityRecord(catalog.capabilities, id, version)
}

func (catalog *assembleTeamCatalog) SaveAgentCombination(combination AgentCombination) SavedAgentCombination {
	raw, err := catalog.post("/api/catalog/combinations", map[string]any{"combination": combination})
	if err != nil {
		Raise("internal", "The role recipe could not be published: "+err.Error())
	}
	saved := SavedAgentCombination{}
	if err := json.Unmarshal(raw, &saved); err != nil {
		Raise("internal", "The published role recipe could not be read: "+err.Error())
	}
	return saved
}

func (catalog *assembleTeamCatalog) get(path string) ([]byte, error) {
	request, err := http.NewRequest(http.MethodGet, catalog.base+path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Cookie", catalog.cookie)
	response, err := HTTPClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := ReadBody(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

func (catalog *assembleTeamCatalog) post(path string, payload any) ([]byte, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodPost, catalog.base+path, strings.NewReader(string(encoded)))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Cookie", catalog.cookie)
	request.Header.Set("Origin", catalog.base)
	request.Header.Set("Content-Type", "application/json")
	response, err := HTTPClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := ReadBody(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

func runAssembleTeam(args []string, cwd string) int {
	consoleURL := ""
	configPath := ""
	outputPath := ""
	for index := 0; index < len(args); index++ {
		argument := args[index]
		value := func() string {
			if index+1 >= len(args) {
				Raise("usage", argument+" requires a value")
			}
			index++
			return args[index]
		}
		switch argument {
		case "--url":
			consoleURL = value()
		case "--config":
			configPath = value()
		case "--out":
			outputPath = value()
		case "--help", "-h":
			fmt.Fprintln(os.Stdout, assembleTeamUsage)
			return 0
		default:
			Raise("usage", "Unknown argument: "+argument)
		}
	}
	if configPath == "" || outputPath == "" {
		fmt.Fprintln(os.Stderr, assembleTeamUsage)
		return 2
	}
	base := assembleTeamBase(consoleURL)
	output := resolvePath(cwd, outputPath)
	if _, err := os.Stat(output); err == nil {
		Raise("invalid_input", "The definition already exists: "+output)
	}
	raw, err := os.ReadFile(resolvePath(cwd, configPath))
	if err != nil {
		Raise("invalid_input", "The team options could not be read: "+err.Error())
	}
	options := MattTeamOptions{}
	if err := json.Unmarshal(raw, &options); err != nil {
		Raise("invalid_input", "The team options are not valid JSON: "+err.Error())
	}
	catalog, err := openAssembleTeamCatalog(base)
	if err != nil {
		Raise("invalid_input", "The Graph console could not be reached: "+err.Error())
	}
	definition := AssembleMattTeam(catalog, options)
	encoded, err := json.MarshalIndent(definition, "", "  ")
	if err != nil {
		Raise("internal", "The definition could not be written: "+err.Error())
	}
	if err := writeNewFile(output, string(encoded)+"\n", 0o644); err != nil {
		Raise("invalid_input", "The definition could not be created: "+err.Error())
	}
	recipes := make([]string, 0, len(definition.Nodes))
	for _, node := range definition.Nodes {
		recipes = append(recipes, node.Recipe)
	}
	fmt.Printf("Reusable team saved: %s\n", output)
	fmt.Printf("Published recipes: %s\n", strings.Join(recipes, ", "))
	return 0
}

func assembleTeamBase(raw string) string {
	if strings.TrimSpace(raw) == "" {
		Raise("usage", "The console URL is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil {
		Raise("invalid_input", "Use the local running Graph console URL")
	}
	host := parsed.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		Raise("invalid_input", "Use the local running Graph console URL")
	}
	return strings.TrimRight(parsed.String(), "/")
}

func openAssembleTeamCatalog(base string) (*assembleTeamCatalog, error) {
	response, err := HTTPClient.Get(base)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if _, err := ReadBody(response.Body); err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	cookie := ReadCookie(response.Header.Get("Set-Cookie"), sessionCookieName)
	if cookie == "" {
		return nil, fmt.Errorf("the console did not provide a local session cookie")
	}
	catalog := &assembleTeamCatalog{base: base, cookie: sessionCookieName + "=" + cookie}
	raw, err := catalog.get("/api/catalog")
	if err != nil {
		return nil, err
	}
	view := struct {
		Capabilities []CapabilityRecord `json:"capabilities"`
	}{}
	if err := json.Unmarshal(raw, &view); err != nil {
		return nil, err
	}
	catalog.capabilities = view.Capabilities
	return catalog, nil
}
