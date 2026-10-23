package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// CompileAgentCombination compiles one recipe into a definition spec.
func (library *CapabilityLibrary) CompileAgentCombination(id string) CompiledAgentCombination {
	combination := AgentCombination{}
	found := false
	for _, item := range library.recipes {
		if item.Id == id {
			combination = item
			found = true
			break
		}
	}
	if !found {
		Raise("not_found", "Unknown Agent combination "+id)
	}
	return CompileAgentCombinationDefinition(combination, library.capabilitiesCache)
}

// UpsertCapabilityBundle installs one capability bundle into the capability root.
func (library *CapabilityLibrary) UpsertCapabilityBundle(input CapabilityBundleInput) CapabilityBundleResult {
	if library.capabilityRoot == "" {
		Raise("unsupported", "This runtime has no writable capability directory")
	}
	manifest := ParseCapabilityManifest(input.Manifest, "<bundle>")
	files := input.Files
	if files == nil {
		files = map[string]string{}
	}
	capabilityBundleValidateFiles(manifest, files)

	directory := filepath.Join(library.capabilityRoot, capabilityBundleDirectories[manifest.Kind], manifest.Id+"-"+manifest.Version)
	for _, record := range library.capabilitiesCache {
		if record.Id != manifest.Id || record.Version != manifest.Version {
			continue
		}
		if capabilityBundleResolve(record.Source) == capabilityBundleResolve(directory) {
			continue
		}
		Raise("capability_exists", "Capability "+manifest.Id+"@"+manifest.Version+" is already registered from "+record.Source)
	}
	if _, err := os.Stat(directory); err == nil && !input.Overwrite {
		Raise("capability_exists", "Capability "+manifest.Id+"@"+manifest.Version+" is already installed; set overwrite=true only after explicit approval")
	}
	staging := directory + ".tmp-" + newUUID()
	if err := os.MkdirAll(staging, 0o700); err != nil {
		panic(err)
	}
	installed := false
	defer func() {
		if !installed {
			_ = os.RemoveAll(staging)
		}
	}()
	// TODO(port): TypeScript wrote the manifest keys in insertion order; Go sorts them.
	body, err := json.MarshalIndent(capabilityBundleManifestJSON(manifest), "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "capability.json"), append(body, '\n'), 0o600); err != nil {
		panic(err)
	}
	for path, content := range files {
		target := filepath.Join(staging, capabilityBundleSafePath(path))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			panic(err)
		}
		if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
			panic(err)
		}
	}
	staged := ScanCapabilities(staging)
	valid := false
	invalid := CapabilityRecord{}
	hasInvalid := false
	for _, record := range staged {
		if record.Id == manifest.Id && record.Version == manifest.Version && record.Status == "available" {
			valid = true
		}
		if record.Status == "invalid" && !hasInvalid {
			invalid = record
			hasInvalid = true
		}
	}
	if !valid {
		reason := "Capability " + manifest.Id + "@" + manifest.Version + " did not pass catalog validation"
		if hasInvalid && invalid.Error != "" {
			reason = invalid.Error
		}
		Raise("invalid_capability", reason)
	}
	if _, err := os.Stat(directory); err == nil {
		if err := os.RemoveAll(directory); err != nil {
			panic(err)
		}
	}
	if err := os.Rename(staging, directory); err != nil {
		panic(err)
	}
	installed = true

	library.RefreshCapabilities()
	record := library.Capability(manifest.Id, manifest.Version)
	if record == nil || record.Status != "available" {
		reason := "Capability " + manifest.Id + "@" + manifest.Version + " did not pass catalog validation"
		if record != nil && record.Error != "" {
			reason = record.Error
		}
		Raise("invalid_capability", reason)
	}
	return CapabilityBundleResult{Capability: *record, Directory: directory}
}
