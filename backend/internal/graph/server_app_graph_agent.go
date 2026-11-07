package graph

import (
	"strconv"
	"strings"
)

type appGraphCapability struct {
	ID      string  `json:"id"`
	Version string  `json:"version"`
	Role    string  `json:"role"`
	Kind    *string `json:"kind"`
	Name    string  `json:"name"`
	Status  string  `json:"status"`
	Source  *string `json:"source"`
}

type appGraphExperience struct {
	Task    TalentStats `json:"task"`
	Samples []any       `json:"samples"`
}

type appGraphAgent struct {
	ID               string               `json:"id"`
	Version          int                  `json:"version"`
	Name             string               `json:"name"`
	Description      string               `json:"description"`
	Review           bool                 `json:"review"`
	Capabilities     []appGraphCapability `json:"capabilities"`
	Experience       appGraphExperience   `json:"experience"`
}

func (app *GraphApp) appGraphAgentDetail(definitionVersion string) any {
	if definitionVersion == "" {
		return nil
	}
	index := strings.LastIndex(definitionVersion, "@")
	if index <= 0 {
		return nil
	}
	id := definitionVersion[:index]
	version, err := strconv.Atoi(definitionVersion[index+1:])
	if err != nil || version < 0 {
		return nil
	}
	detail, ok := app.recoverValue(func() any {
		return app.runtime.Catalog().Definition(id + "@" + strconv.Itoa(version))
	})
	if !ok {
		return nil
	}
	definition := detail.(CatalogDefinition)
	view, ok := app.runtime.Talent(id, &version, false).(map[string]any)
	if !ok {
		return nil
	}
	talentDetail, _ := view["detail"].(map[string]any)
	experience, _ := view["experience"].(TalentExperience)
	if talentDetail == nil {
		return nil
	}
	snapshot, _ := talentDetail["snapshot"].(map[string]any)
	combination, _ := snapshot["agentCombination"].(map[string]any)
	name := id
	if combination != nil {
		if value, ok := combination["name"].(string); ok && value != "" {
			name = value
		}
	}
	description := ""
	if value, ok := talentDetail["description"].(string); ok {
		description = value
	}
	if combination != nil {
		if value, ok := combination["description"].(string); ok && value != "" {
			description = value
		}
	}
	review := false
	if value, ok := talentDetail["review"].(bool); ok {
		review = value
	}
	samples := []any{}
	for _, sample := range experience.Samples {
		samples = append(samples, sample)
	}
	if len(samples) > 5 {
		samples = samples[len(samples)-5:]
	}
	reversed := make([]any, 0, len(samples))
	for index := len(samples) - 1; index >= 0; index-- {
		reversed = append(reversed, samples[index])
	}
	return appGraphAgent{
		ID: id, Version: version, Name: name, Description: description,
		Review: review,
		Capabilities: app.appGraphAgentCapabilities(definition),
		Experience:   appGraphExperience{Task: experience.Task, Samples: reversed},
	}
}

func (app *GraphApp) appGraphAgentCapabilities(definition CatalogDefinition) []appGraphCapability {
	capabilities := []appGraphCapability{}
	bound := []struct {
		binding CapabilityBinding
		role    string
	}{}
	for _, capability := range definition.Capabilities {
		bound = append(bound, struct {
			binding CapabilityBinding
			role    string
		}{capability, "capability"})
	}
	if definition.Prompts != nil {
		if definition.Prompts.Agent != nil {
			bound = append(bound, struct {
				binding CapabilityBinding
				role    string
			}{*definition.Prompts.Agent, "agent"})
		}
		if definition.Prompts.Tool != nil {
			bound = append(bound, struct {
				binding CapabilityBinding
				role    string
			}{*definition.Prompts.Tool, "tool"})
		}
	}
	for _, item := range bound {
		record := app.runtime.Catalog().Capability(item.binding.Id, item.binding.Version)
		view := appGraphCapability{
			ID: item.binding.Id, Version: item.binding.Version, Role: item.role,
			Kind: nil, Name: item.binding.Id, Status: "missing", Source: nil,
		}
		if record != nil {
			kind := record.Kind
			view.Kind = &kind
			if record.Name != "" {
				view.Name = record.Name
			}
			if record.Status != "" {
				view.Status = record.Status
			}
			source := record.Source
			view.Source = &source
		}
		capabilities = append(capabilities, view)
	}
	return capabilities
}
