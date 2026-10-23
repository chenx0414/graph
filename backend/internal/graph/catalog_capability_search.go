package graph

import (
	"os"
	"path/filepath"
)

// CapabilityLibrary is the filesystem-backed capability library and its Agent recipes.
type CapabilityLibrary struct {
	capabilityRoot    string
	recipesPath       string
	projects          func() []ProjectConfig
	capabilitiesCache []CapabilityRecord
	recipes           []AgentCombination
	recipesError      *string
}

// NewCapabilityLibrary opens the library over the given locations.
func NewCapabilityLibrary(options CapabilityLibraryOptions) *CapabilityLibrary {
	return &CapabilityLibrary{
		capabilityRoot: options.CapabilityRoot,
		recipesPath:    options.RecipesPath,
		projects:       options.Projects,
	}
}

func capabilityLibraryHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// RefreshCapabilities rescans the capability root and the native skill folders.
func (library *CapabilityLibrary) RefreshCapabilities() []CapabilityRecord {
	if library.capabilityRoot == "" {
		library.capabilitiesCache = []CapabilityRecord{}
		return library.Capabilities()
	}
	// Skills the user placed belong to the same library view: an Agent's own folder, the
	// global folders - the Pi agent directory and `.agents` - which every Agent loads, and
	// each configured project's own `.pi`/`.agents` folders, which reach the Agents that
	// work in it.
	placed := ScanAgentSkills(filepath.Join(filepath.Dir(library.capabilityRoot), "agents"))
	global := ScanNativeSkills(filepath.Join(defaultPiAgentDir(), "skills"), "全局（Pi agent 目录）", CapabilityOriginGlobal)
	agents := ScanNativeSkills(filepath.Join(capabilityLibraryHome(), ".agents", "skills"), "全局（~/.agents）", CapabilityOriginGlobal)
	projects := []CapabilityRecord{}
	if library.projects != nil {
		for _, project := range library.projects() {
			projects = append(projects, ScanNativeSkills(filepath.Join(project.Root, piConfigDirName, "skills"), "项目 "+project.Id+"（.pi）", CapabilityOriginProject)...)
			projects = append(projects, ScanNativeSkills(filepath.Join(project.Root, ".agents", "skills"), "项目 "+project.Id+"（.agents）", CapabilityOriginProject)...)
		}
	}
	records := []CapabilityRecord{}
	records = append(records, ScanCapabilities(library.capabilityRoot)...)
	records = append(records, placed...)
	records = append(records, global...)
	records = append(records, agents...)
	records = append(records, projects...)
	library.capabilitiesCache = records
	return library.Capabilities()
}

// Refresh rescans the capabilities and reloads the Agent recipes.
func (library *CapabilityLibrary) Refresh() CapabilityLibrarySnapshot {
	library.RefreshCapabilities()
	if library.recipesPath != "" {
		library.readRecipes()
	}
	return CapabilityLibrarySnapshot{
		Capabilities:      library.Capabilities(),
		AgentCombinations: library.AgentCombinations(),
	}
}

// readRecipes loads the recipe document. A broken document empties the recipes and keeps
// the error message, the way the TypeScript library did.
func (library *CapabilityLibrary) readRecipes() {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		library.recipes = []AgentCombination{}
		message := panicMessage(recovered)
		library.recipesError = &message
	}()
	document := ReadAgentCombinations(library.recipesPath)
	library.recipes = document.Combinations
	library.recipesError = nil
}

// CapabilityRootPath is the writable capability directory, empty when there is none.
func (library *CapabilityLibrary) CapabilityRootPath() string {
	return library.capabilityRoot
}

// AgentCombinationFilePath is the recipe document path, empty when there is none.
func (library *CapabilityLibrary) AgentCombinationFilePath() string {
	return library.recipesPath
}

// AgentCombinationError is the recipe load error, nil when the document loaded.
func (library *CapabilityLibrary) AgentCombinationError() *string {
	return library.recipesError
}

// Capabilities is the scanned capability list.
func (library *CapabilityLibrary) Capabilities() []CapabilityRecord {
	out := make([]CapabilityRecord, len(library.capabilitiesCache))
	copy(out, library.capabilitiesCache)
	return out
}

// CapabilitiesView is the list the resource library renders: one row per skill name,
// duplicates folded.
func (library *CapabilityLibrary) CapabilitiesView() []CapabilityRecord {
	return GroupCapabilitiesByName(library.capabilitiesCache)
}

// Capability resolves one capability id, optionally pinned to a version.
func (library *CapabilityLibrary) Capability(id string, version string) *CapabilityRecord {
	return SelectCapabilityRecord(library.capabilitiesCache, id, version)
}
