package graph

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"encoding/json"
)

type AgentCombinationResourceRole string

type AgentCombinationMode string

type AgentCombinationResource struct {
	ResourceId string                       `json:"resourceId"`
	Version    string                       `json:"version,omitempty"`
	Role       AgentCombinationResourceRole `json:"role"`
	Required   bool                         `json:"required"`
}

type AgentCombination struct {
	Id               string                     `json:"id"`
	Name             string                     `json:"name"`
	Description      string                     `json:"description"`
	Mode             AgentCombinationMode       `json:"mode,omitempty"`
	Review           bool                       `json:"review"`
	Tags             []string                   `json:"tags"`
	SystemPrompt     string                     `json:"systemPrompt,omitempty"`
	Resources        []AgentCombinationResource `json:"resources"`
}

type AgentCombinationResolved struct {
	ResourceId string                       `json:"resourceId"`
	Version    string                       `json:"version"`
	Role       AgentCombinationResourceRole `json:"role"`
	Required   bool                         `json:"required"`
	Kind       string                       `json:"kind"`
	Name       string                       `json:"name"`
}

type AgentCombinationView struct {
	AgentCombination
	Status   string                     `json:"status"`
	Issues   []string                   `json:"issues"`
	Resolved []AgentCombinationResolved `json:"resolved"`
}

type AgentCombinationDocument struct {
	Version      int                `json:"version"`
	Combinations []AgentCombination `json:"combinations"`
}

type DefinitionSpec struct {
	SystemPrompt     string              `json:"systemPrompt,omitempty"`
	Capabilities     []CapabilityBinding `json:"capabilities,omitempty"`
	Prompts          *struct {
		Agent *CapabilityBinding `json:"agent,omitempty"`
		Tool  *CapabilityBinding `json:"tool,omitempty"`
	} `json:"prompts,omitempty"`
	Review   bool `json:"review,omitempty"`
	Snapshot Json `json:"snapshot,omitempty"`
}

type CapabilityBinding struct {
	Id      string `json:"id"`
	Version string `json:"version"`
}

var agentCombinationID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

var agentCombinationRoles = map[AgentCombinationResourceRole]bool{
	"identity": true, "tool": true, "skill": true, "mcp": true, "pi-extension": true, "extension": true,
}

var agentCombinationModes = map[AgentCombinationMode]bool{"main": true, "subagent": true}

func agentCombinationsText(value any, label string) string {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		Raise("invalid_agent_combination", label+" must be a nonempty string")
	}
	return strings.TrimSpace(text)
}

func agentCombinationsTextList(value any, label string) []string {
	if value == nil {
		return []string{}
	}
	items, ok := value.([]any)
	if !ok {
		Raise("invalid_agent_combination", label+" must be an array of nonempty strings")
	}
	seen := map[string]bool{}
	out := []string{}
	for _, item := range items {
		text, isString := item.(string)
		if !isString || strings.TrimSpace(text) == "" {
			Raise("invalid_agent_combination", label+" must be an array of nonempty strings")
		}
		trimmed := strings.TrimSpace(text)
		if seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

func agentCombinationInteger(value any) bool {
	number, ok := value.(float64)
	if !ok {
		if number, ok := value.(int); ok {
			return number >= 1
		}
		return false
	}
	return !math.IsNaN(number) && !math.IsInf(number, 0) && number == math.Trunc(number) && number >= 1 && math.Abs(number) <= maxSafeInteger
}

func ParseAgentCombinations(value any) AgentCombinationDocument {
	record, ok := value.(map[string]any)
	if !ok {
		if document, ok := value.(AgentCombinationDocument); ok {
			raw, err := json.Marshal(document)
			if err != nil {
				panic(err)
			}
			if err := json.Unmarshal(raw, &record); err != nil {
				panic(err)
			}
		} else {
			raw, err := json.Marshal(value)
			if err != nil {
				panic(err)
			}
			if err := json.Unmarshal(raw, &record); err != nil || record == nil {
				Raise("invalid_agent_combination", "Agent combinations must be an object")
			}
		}
	}
	if record == nil {
		Raise("invalid_agent_combination", "Agent combinations must be an object")
	}
	if !agentCombinationInteger(record["version"]) {
		Raise("invalid_agent_combination", "Agent combinations version must be a positive integer")
	}
	rawCombinations, ok := record["combinations"].([]any)
	if !ok {
		Raise("invalid_agent_combination", "combinations must be an array")
	}
	ids := map[string]bool{}
	combinations := make([]AgentCombination, 0, len(rawCombinations))
	for index, raw := range rawCombinations {
		entry, ok := raw.(map[string]any)
		if !ok {
			Raise("invalid_agent_combination", "combinations["+itoa(index)+"] must be an object")
		}
		id := agentCombinationsText(entry["id"], "combinations["+itoa(index)+"].id")
		if !agentCombinationID.MatchString(id) {
			Raise("invalid_agent_combination", "Agent combination id "+id+" is invalid")
		}
		if ids[id] {
			Raise("invalid_agent_combination", "Duplicate Agent combination id "+id)
		}
		ids[id] = true
		mode := AgentCombinationMode("")
		if _, present := entry["mode"]; present && entry["mode"] != nil {
			mode = AgentCombinationMode(agentCombinationsText(entry["mode"], "combinations["+itoa(index)+"].mode"))
			if !agentCombinationModes[mode] {
				Raise("invalid_agent_combination", "Agent combination "+id+" has unsupported mode "+string(mode))
			}
		}
		if mode == "main" && id != "main" {
			Raise("invalid_agent_combination", "The Main Agent recipe must use id \"main\"")
		}
		if review, present := entry["review"]; present && review != nil {
			if _, isBool := review.(bool); !isBool {
				Raise("invalid_agent_combination", "combinations["+itoa(index)+"].review must be a boolean")
			}
		}
		systemPrompt := ""
		if _, present := entry["systemPrompt"]; present && entry["systemPrompt"] != nil {
			prompt, isString := entry["systemPrompt"].(string)
			if !isString || strings.TrimSpace(prompt) == "" || len(prompt) > 40000 {
				Raise("invalid_agent_combination", "Agent combination "+id+" systemPrompt must contain 1–40000 characters")
			}
			systemPrompt = strings.TrimSpace(prompt)
		}
		resourcesRaw, isArray := entry["resources"].([]any)
		if !isArray || (len(resourcesRaw) == 0 && mode != "main" && systemPrompt == "") {
			Raise("invalid_agent_combination", "Agent combination "+id+" must include a resource or an inline system Prompt unless it is the Main Agent recipe")
		}
		seen := map[string]bool{}
		resources := []AgentCombinationResource{}
		for resourceIndex, rawResource := range resourcesRaw {
			resource, ok := rawResource.(map[string]any)
			if !ok {
				Raise("invalid_agent_combination", "combinations["+itoa(index)+"].resources["+itoa(resourceIndex)+"] must be an object")
			}
			resourceId := agentCombinationsText(resource["resourceId"], "combinations["+itoa(index)+"].resources["+itoa(resourceIndex)+"].resourceId")
			role := AgentCombinationResourceRole(agentCombinationsText(resource["role"], "combinations["+itoa(index)+"].resources["+itoa(resourceIndex)+"].role"))
			if !agentCombinationRoles[role] {
				Raise("invalid_agent_combination", "Agent combination "+id+" has unsupported resource role "+string(role))
			}
			if required, present := resource["required"]; present && required != nil {
				if _, isBool := required.(bool); !isBool {
					Raise("invalid_agent_combination", "combinations["+itoa(index)+"].resources["+itoa(resourceIndex)+"].required must be a boolean")
				}
			}
			version := ""
			if _, present := resource["version"]; present && resource["version"] != nil {
				version = agentCombinationsText(resource["version"], "combinations["+itoa(index)+"].resources["+itoa(resourceIndex)+"].version")
			}
			seenKey := string(role) + ":" + resourceId + "@"
			if version == "" {
				seenKey += "current"
			} else {
				seenKey += version
			}
			if seen[seenKey] {
				Raise("invalid_agent_combination", "Agent combination "+id+" repeats "+resourceId+" in role "+string(role))
			}
			seen[seenKey] = true
			required := true
			if resource["required"] == false {
				required = false
			}
			resources = append(resources, AgentCombinationResource{ResourceId: resourceId, Role: role, Required: required, Version: version})
		}
		if resources == nil {
			resources = []AgentCombinationResource{}
		}
		combinations = append(combinations, AgentCombination{
			Id: id, Name: agentCombinationsText(entry["name"], "combinations["+itoa(index)+"].name"),
			Description: agentCombinationsText(entry["description"], "combinations["+itoa(index)+"].description"),
			Mode:        mode, Review: entry["review"] == true,
			Tags:         agentCombinationsTextList(entry["tags"], "combinations["+itoa(index)+"].tags"),
			SystemPrompt: systemPrompt, Resources: resources,
		})
	}
	version, _ := record["version"].(float64)
	if version == 0 {
		if whole, ok := record["version"].(int); ok {
			version = float64(whole)
		}
	}
	return AgentCombinationDocument{Version: int(version), Combinations: combinations}
}

func ReadAgentCombinations(path string) AgentCombinationDocument {
	if _, err := os.Stat(path); err != nil {
		return AgentCombinationDocument{Version: 1, Combinations: []AgentCombination{}}
	}
	body, err := os.ReadFile(path)
	if err != nil {
		Raise("invalid_agent_combination", "Cannot read "+path+": "+err.Error())
	}
	var raw any
	if err := json.Unmarshal(body, &raw); err != nil {
		Raise("invalid_agent_combination", "Cannot read "+path+": "+err.Error())
	}
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		if _, ok := recovered.(*RuntimeError); ok {
			panic(recovered)
		}
		message := panicMessage(recovered)
		Raise("invalid_agent_combination", "Cannot read "+path+": "+message)
	}()
	return ParseAgentCombinations(raw)
}

func WriteAgentCombinations(path string, document AgentCombinationDocument) {
	parsed := ParseAgentCombinations(document)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		panic(err)
	}
	temporary := path + "." + itoa(os.Getpid()) + "." + itoa(int(NowMillis())) + ".tmp"
	body, err := json.MarshalIndent(parsed, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(temporary, append(body, '\n'), 0o600); err != nil {
		panic(err)
	}
	if err := os.Rename(temporary, path); err != nil {
		panic(err)
	}
}

func agentCombinationExpectedKind(role AgentCombinationResourceRole) string {
	if role == "identity" || role == "tool" {
		return "prompt"
	}
	if role == "pi-extension" {
		return "pi-extension"
	}
	if role == "extension" {
		return "extension"
	}
	return string(role)
}

func agentCombinationSelect(members []CapabilityRecord, member AgentCombinationResource) *CapabilityRecord {
	available := []CapabilityRecord{}
	for _, item := range members {
		if item.Status == "available" {
			available = append(available, item)
		}
	}
	return SelectCapabilityRecord(available, member.ResourceId, member.Version)
}

func agentCombinationRoleMatches(record CapabilityRecord, role AgentCombinationResourceRole) bool {
	if agentCombinationExpectedKind(role) != record.Kind {
		return false
	}
	if role == "identity" {
		return record.Role == "agent"
	}
	if role == "tool" {
		return record.Role == "tool"
	}
	return true
}

func ValidateAgentCombination(combination AgentCombination, capabilities []CapabilityRecord) AgentCombinationView {
	if combination.Mode == "main" && combination.Id != "main" {
		return AgentCombinationView{AgentCombination: combination, Status: "invalid", Issues: []string{"The Main Agent recipe must use id \"main\""}, Resolved: []AgentCombinationResolved{}}
	}
	issues := []string{}
	resolved := []AgentCombinationResolved{}
	identityCount := 0
	toolCount := 0
	for _, member := range combination.Resources {
		record := agentCombinationSelect(capabilities, member)
		if record == nil {
			if member.Required {
				suffix := ""
				if member.Version != "" {
					suffix = "@" + member.Version
				}
				issues = append(issues, "Missing required capability "+member.ResourceId+suffix+" ("+string(member.Role)+")")
			}
			continue
		}
		if !agentCombinationRoleMatches(*record, member.Role) {
			role := ""
			if record.Role != "" {
				role = "/" + record.Role
			}
			detail := "Capability " + record.Id + "@" + record.Version + " is " + record.Kind + role + ", not " + string(member.Role)
			if member.Required {
				issues = append(issues, detail)
			}
			continue
		}
		if member.Role == "identity" {
			identityCount++
		}
		if member.Role == "tool" {
			toolCount++
		}
		if member.Role == "identity" && identityCount > 1 {
			issues = append(issues, "Agent combination "+combination.Id+" has more than one identity prompt")
		}
		if member.Role == "tool" && toolCount > 1 {
			issues = append(issues, "Agent combination "+combination.Id+" has more than one tool prompt")
		}
		name := record.Id
		if record.Name != "" {
			name = record.Name
		}
		resolved = append(resolved, AgentCombinationResolved{
			ResourceId: record.Id, Version: record.Version, Role: member.Role, Required: member.Required, Kind: record.Kind, Name: name,
		})
	}
	if toolCount > 0 && identityCount == 0 && combination.SystemPrompt == "" {
		issues = append(issues, "Agent combination "+combination.Id+" binds a tool prompt without an identity prompt")
	}
	if combination.SystemPrompt != "" && identityCount > 0 {
		issues = append(issues, "Agent combination "+combination.Id+" cannot bind an identity Prompt and an inline system Prompt together")
	}
	status := "valid"
	if len(issues) > 0 {
		status = "invalid"
	}
	if resolved == nil {
		resolved = []AgentCombinationResolved{}
	}
	return AgentCombinationView{AgentCombination: combination, Status: status, Issues: issues, Resolved: resolved}
}

type CompiledAgentCombination struct {
	Definition DefinitionSpec
	View       AgentCombinationView
}

func CompileAgentCombinationDefinition(combination AgentCombination, capabilities []CapabilityRecord) CompiledAgentCombination {
	view := ValidateAgentCombination(combination, capabilities)
	if view.Status != "valid" {
		Raise("invalid_agent_combination", strings.Join(view.Issues, "; "))
	}
	definition := DefinitionSpec{}
	if combination.SystemPrompt != "" {
		definition.SystemPrompt = combination.SystemPrompt
	}
	if combination.Review {
		definition.Review = true
	}
	definition.Snapshot = map[string]any{
		"agentCombination": map[string]any{
			"id": combination.Id, "name": combination.Name, "description": combination.Description, "tags": combination.Tags,
			"mode": combination.Mode,
		},
	}
	if combination.Mode == "" {
		snapshot := definition.Snapshot.(map[string]any)["agentCombination"].(map[string]any)
		delete(snapshot, "mode")
	}
	executable := []CapabilityBinding{}
	for _, member := range view.Resolved {
		binding := CapabilityBinding{Id: member.ResourceId, Version: member.Version}
		if member.Role == "identity" || member.Role == "tool" {
			if definition.Prompts == nil {
				definition.Prompts = &struct {
					Agent *CapabilityBinding `json:"agent,omitempty"`
					Tool  *CapabilityBinding `json:"tool,omitempty"`
				}{}
			}
			copy := binding
			if member.Role == "identity" {
				definition.Prompts.Agent = &copy
			} else {
				definition.Prompts.Tool = &copy
			}
			continue
		}
		executable = append(executable, binding)
	}
	if len(executable) > 0 {
		definition.Capabilities = executable
	}
	return CompiledAgentCombination{Definition: definition, View: view}
}
