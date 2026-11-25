package graph

import (
	"encoding/json"
)

type SavedAgentCombination struct {
	Combination  AgentCombinationView `json:"combination"`
	Definition   *CompiledDefinition  `json:"definition,omitempty"`
	CompileError *string              `json:"compileError,omitempty"`
}

type PublishedDefinition struct {
	Id      string
	Version int64
	Key     string
}

type CompiledDefinition struct {
	Combination       AgentCombinationView `json:"combination"`
	DefinitionId      string               `json:"definitionId"`
	DefinitionVersion string               `json:"definitionVersion"`
	Version           int64                `json:"version"`
}

type CatalogOptions struct {
	CapabilityRoot string
	RecipesPath    string
	Projects       func() []ProjectConfig
}

type Catalog struct {
	store   *TaskStore
	library *CapabilityLibrary
}

func NewCatalog(store *TaskStore, options CatalogOptions) *Catalog {
	return &Catalog{
		store: store,
		library: NewCapabilityLibrary(CapabilityLibraryOptions{
			CapabilityRoot: options.CapabilityRoot,
			RecipesPath:    options.RecipesPath,
			Projects:       options.Projects,
		}),
	}
}

func (catalog *Catalog) RefreshCapabilities() any {
	return catalog.library.RefreshCapabilities()
}

func (catalog *Catalog) Refresh() any {
	return catalog.library.Refresh()
}

func (catalog *Catalog) CapabilityRootPath() string {
	return catalog.library.CapabilityRootPath()
}

func (catalog *Catalog) AgentCombinationFilePath() string {
	return catalog.library.AgentCombinationFilePath()
}

func (catalog *Catalog) AgentCombinationError() *string {
	return catalog.library.AgentCombinationError()
}

func (catalog *Catalog) assertBinding(label string, binding *CapabilityBinding) {
	if binding == nil {
		return
	}
	if trimSpace(binding.Id) == "" || trimSpace(binding.Version) == "" {
		Raise("invalid_input", label+" requires capability id and version")
	}
}

func (catalog *Catalog) PublishDefinition(id string, spec DefinitionSpec) PublishedDefinition {
	if trimSpace(id) == "" {
		Raise("invalid_input", "A definition id is required")
	}
	for i := range spec.Capabilities {
		binding := spec.Capabilities[i]
		catalog.assertBinding("Capability binding", &binding)
	}
	if spec.Prompts != nil {
		catalog.assertBinding("Agent prompt binding", spec.Prompts.Agent)
		catalog.assertBinding("Tool prompt binding", spec.Prompts.Tool)
		if spec.Prompts.Agent == nil && spec.Prompts.Tool != nil {
			Raise("invalid_input", "A tool prompt binding requires an agent prompt binding")
		}
	}
	row := kernelRow(catalog.store.DB, "SELECT COALESCE(MAX(version),0)+1 AS version FROM definitions WHERE id=?", id)
	version := kernelInt(row["version"])
	kernelExec(catalog.store.DB, "INSERT INTO definitions VALUES(?,?,?)", id, version, CanonicalJSON(spec))
	return PublishedDefinition{Id: id, Version: version, Key: id + "@" + itoa(int(version))}
}

func (catalog *Catalog) EnsureDefinition(id string, spec DefinitionSpec) PublishedDefinition {
	if trimSpace(id) == "" {
		Raise("invalid_input", "A definition id is required")
	}
	latest := kernelRow(catalog.store.DB, "SELECT version,spec FROM definitions WHERE id=? ORDER BY version DESC LIMIT 1", id)
	desired := CanonicalJSON(spec)
	if latest != nil {
		var parsed any
		if err := json.Unmarshal([]byte(kernelString(latest["spec"])), &parsed); err != nil {
			panic(err)
		}
		if CanonicalJSON(parsed) == desired {
			version := kernelInt(latest["version"])
			return PublishedDefinition{Id: id, Version: version, Key: id + "@" + itoa(int(version))}
		}
	}
	return catalog.PublishDefinition(id, spec)
}

func (catalog *Catalog) HasDefinition(key string) bool {
	id, version := ParseDefinitionVersion(key)
	return kernelRow(catalog.store.DB, "SELECT 1 FROM definitions WHERE id=? AND version=?", id, version) != nil
}

type CatalogDefinition struct {
	Id      string
	Version int
	DefinitionSpec
}

func (catalog *Catalog) Definition(key string) CatalogDefinition {
	id, version := ParseDefinitionVersion(key)
	row := kernelRow(catalog.store.DB, "SELECT spec FROM definitions WHERE id=? AND version=?", id, version)
	if row == nil {
		Raise("not_found", "Unknown Agent definition "+key)
	}
	var spec DefinitionSpec
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
		panic(err)
	}
	return CatalogDefinition{Id: id, Version: version, DefinitionSpec: spec}
}

func (catalog *Catalog) AgentCombinations() []AgentCombinationView {
	return catalog.library.AgentCombinations()
}

func (catalog *Catalog) AgentCombination(id string) *AgentCombinationView {
	return catalog.library.AgentCombination(id)
}

func (catalog *Catalog) SearchAgentCombinations(input AgentCombinationSearchInput) any {
	return catalog.library.SearchAgentCombinations(input)
}

func (catalog *Catalog) SaveAgentCombination(combination AgentCombination) (saved SavedAgentCombination) {
	view := catalog.library.SaveAgentCombination(combination)
	saved.Combination = view
	defer func() {
		if recovered := recover(); recovered != nil {
			message := panicText(recovered)
			saved.CompileError = &message
			saved.Definition = nil
		}
	}()
	compiled := catalog.CompileAgentCombination(view.Id)
	saved.Definition = &compiled
	return saved
}

type UpdatedAgentCombination struct {
	Combination AgentCombinationView `json:"combination"`
	Definition  CompiledDefinition   `json:"definition"`
}

func (catalog *Catalog) UpdateAgentCombinationDescription(id, description string) UpdatedAgentCombination {
	combination := catalog.library.UpdateAgentCombinationDescription(id, description)
	return UpdatedAgentCombination{Combination: combination, Definition: catalog.CompileAgentCombination(id)}
}

func (catalog *Catalog) DeleteAgentCombination(id string) any {
	return catalog.library.DeleteAgentCombination(id)
}

func (catalog *Catalog) CompileAgentCombination(id string) CompiledDefinition {
	compiled := catalog.library.CompileAgentCombination(id)
	published := catalog.EnsureDefinition(id, compiled.Definition)
	return CompiledDefinition{
		Combination:       compiled.View,
		DefinitionId:      published.Id,
		DefinitionVersion: published.Key,
		Version:           published.Version,
	}
}

func (catalog *Catalog) Capability(id string, version ...string) *CapabilityRecord {
	if len(version) == 0 {
		return catalog.library.Capability(id, "")
	}
	return catalog.library.Capability(id, version[0])
}

func (catalog *Catalog) UpsertCapabilityBundle(input CapabilityBundleInput) any {
	return catalog.library.UpsertCapabilityBundle(input)
}

func (catalog *Catalog) SearchCapabilities(input CapabilitySearchInput) any {
	return catalog.library.Search(input)
}

func (catalog *Catalog) ListDefinitions() []struct {
	Id      string
	Version int64
} {
	out := []struct {
		Id      string
		Version int64
	}{}
	catalog.store.ReadSnapshot(func(store *TaskStore) {
		for _, row := range kernelRows(store.DB, "SELECT id,MAX(version) AS version FROM definitions GROUP BY id") {
			out = append(out, struct {
				Id      string
				Version int64
			}{Id: kernelString(row["id"]), Version: kernelInt(row["version"])})
		}
	})
	return out
}

func (catalog *Catalog) AvailableAgentDefinitions() []struct {
	Id      string
	Version int64
} {
	active := map[string]bool{}
	for _, item := range catalog.AgentCombinations() {
		if item.Status == "valid" {
			active[item.Id] = true
		}
	}
	listed := catalog.ListDefinitions()
	out := []struct {
		Id      string
		Version int64
	}{}
	for _, item := range listed {
		if active[item.Id] {
			out = append(out, item)
		}
	}
	return out
}

func (catalog *Catalog) Capabilities() []CapabilityRecord {
	return catalog.library.Capabilities()
}

func (catalog *Catalog) CapabilitiesView() []CapabilityRecord {
	return catalog.library.CapabilitiesView()
}
