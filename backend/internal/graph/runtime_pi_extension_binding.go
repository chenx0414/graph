package graph

import (
	"strings"

	"path/filepath"
)

func piExtensionBindingNames(descriptor any, paths []string) []string {
	names := []string{}
	for _, fact := range asSlice(asMap(descriptor)["facts"]) {
		entry := asMap(fact)
		if mapString(entry, "kind", "Kind") != string(CapabilityKindPiExtension) {
			continue
		}
		id := strings.TrimSpace(mapString(entry, "id", "Id"))
		if id == "" {
			continue
		}
		version := strings.TrimSpace(mapString(entry, "version", "Version"))
		if version != "" {
			id = id + "@" + version
		}
		names = append(names, id)
	}
	if len(names) > 0 {
		return capabilityUniqueStrings(names)
	}
	for _, path := range paths {
		name := piExtensionPathName(path)
		if name != "" {
			names = append(names, name)
		}
	}
	return capabilityUniqueStrings(names)
}

func piExtensionPathName(path string) string {
	cleaned := filepath.Clean(strings.TrimSpace(path))
	if cleaned == "" || cleaned == "." {
		return ""
	}
	directory := filepath.Base(filepath.Dir(cleaned))
	name := filepath.Base(cleaned)
	if directory == "." || directory == string(filepath.Separator) {
		return name
	}
	return directory + "/" + name
}

func piExtensionRefusalText(descriptor any, paths []string) string {
	text := "A bound Pi extension cannot be hosted for this session."
	names := piExtensionBindingNames(descriptor, paths)
	if len(names) > 0 {
		text += " Unbind " + strings.Join(names, ", ") + " to run this agent."
	}
	return text
}
