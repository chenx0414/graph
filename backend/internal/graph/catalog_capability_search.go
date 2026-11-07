package graph

import (
	"os"
	"path/filepath"
)

type CapabilityLibrary struct {
	capabilityRoot    string
	recipesPath       string
	projects          func() []ProjectConfig
	capabilitiesCache []CapabilityRecord
	recipes           []AgentCombination
	recipesError      *string
}

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

func (library *CapabilityLibrary) RefreshCapabilities() []CapabilityRecord {
	if library.capabilityRoot == "" {
		library.capabilitiesCache = []CapabilityRecord{}
		return library.Capabilities()
	}
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

func (library *CapabilityLibrary) CapabilityRootPath() string {
	return library.capabilityRoot
}

func (library *CapabilityLibrary) AgentCombinationFilePath() string {
	return library.recipesPath
}

func (library *CapabilityLibrary) AgentCombinationError() *string {
	return library.recipesError
}

func (library *CapabilityLibrary) Capabilities() []CapabilityRecord {
	out := make([]CapabilityRecord, len(library.capabilitiesCache))
	copy(out, library.capabilitiesCache)
	return out
}

func (library *CapabilityLibrary) CapabilitiesView() []CapabilityRecord {
	return GroupCapabilitiesByName(library.capabilitiesCache)
}

func (library *CapabilityLibrary) Capability(id string, version string) *CapabilityRecord {
	return SelectCapabilityRecord(library.capabilitiesCache, id, version)
}
