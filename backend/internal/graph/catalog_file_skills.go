package graph

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func ScanNativeSkills(skillsDir, owner string, origin CapabilityOrigin) []CapabilityRecord {
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		panic(err)
	}
	sort.Slice(entries, func(i, j int) bool { return lessByByteOrder(entries[i].Name(), entries[j].Name()) })
	records := []CapabilityRecord{}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !entry.IsDir() || info.Mode()&os.ModeSymlink != 0 || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		directory := filepath.Join(skillsDir, entry.Name())
		if _, err := os.Stat(filepath.Join(directory, "SKILL.md")); err != nil {
			continue
		}
		front := fileCapabilitiesFrontmatter(directory)
		note := fileCapabilitiesSkillNote(directory)
		usable := front.HasFrontmatter
		record := CapabilityRecord{
			Id: entry.Name(), Kind: "skill", Source: directory, Version: "local",
			Snapshot: map[string]any{"path": directory}, Status: "available", Owner: owner, Origin: origin,
		}
		if !usable {
			record.Status = "invalid"
			record.Error = skillFrontmatterError
		}
		if front.Name != "" {
			record.Name = front.Name
		}
		if front.Description != "" {
			record.Description = front.Description
		}
		if note != "" {
			record.Note = note
		}
		records = append(records, record)
	}
	return records
}

func ScanAgentSkills(agentsRoot string) []CapabilityRecord {
	agents, err := os.ReadDir(agentsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		panic(err)
	}
	names := []os.DirEntry{}
	for _, agent := range agents {
		if agent.IsDir() && !strings.HasPrefix(agent.Name(), ".") {
			names = append(names, agent)
		}
	}
	sort.Slice(names, func(i, j int) bool { return names[i].Name() < names[j].Name() })
	records := []CapabilityRecord{}
	for _, agent := range names {
		records = append(records, ScanNativeSkills(filepath.Join(agentsRoot, agent.Name(), "skills"), agent.Name(), "agent")...)
	}
	return records
}
