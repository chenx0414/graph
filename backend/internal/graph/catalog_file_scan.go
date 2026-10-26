package graph

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func fileCapabilitiesWalk(root, directory string, depth int, records *[]CapabilityRecord) {
	if depth > fileCapabilitiesMaxScanDepth {
		return
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		if depth == 0 && os.IsNotExist(err) {
			return
		}
		panic(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() != "capability.json" {
			continue
		}
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			message := panicMessage(rec)
			id := strings.TrimPrefix(directory, root)
			id = strings.TrimPrefix(id, string(os.PathSeparator))
			id = strings.ReplaceAll(id, string(os.PathSeparator), "-")
			if id == "" {
				id = directory
			}
			*records = append(*records, CapabilityRecord{
				Id: id, Kind: "skill", Source: directory, Version: "invalid",
				Snapshot: map[string]any{"path": directory, "error": message}, Status: "invalid", Error: message,
			})
		}()
		manifest := ReadCapabilityManifest(directory)
		fileCapabilitiesValidateFiles(directory, manifest)
		note := ""
		if manifest.Kind == "skill" {
			note = fileCapabilitiesSkillNote(directory)
		}
		record := CapabilityRecord{
			Id: manifest.Id, Kind: manifest.Kind, Source: directory, Version: manifest.Version,
			Snapshot: map[string]any{"path": directory, "manifest": manifest}, Status: "available", Name: manifest.Name,
		}
		if manifest.Description != "" {
			record.Description = manifest.Description
		}
		if manifest.Role != "" {
			record.Role = manifest.Role
		}
		if note != "" {
			record.Note = note
		}
		if manifest.Kind == "pi-extension" && strings.TrimSpace(manifest.Source) != "" {
			source := strings.TrimSpace(manifest.Source)
			record.PackageSource = &source
		}
		if manifest.Base {
			record.Base = true
		}
		*records = append(*records, record)
		return
	}
	sorted := append([]os.DirEntry{}, entries...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name() < sorted[j].Name() })
	for _, entry := range sorted {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") || fileCapabilitiesSkip[entry.Name()] {
			continue
		}
		fileCapabilitiesWalk(root, filepath.Join(directory, entry.Name()), depth+1, records)
	}
}
