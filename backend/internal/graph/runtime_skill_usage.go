package graph

import (
	"path/filepath"
	"sort"
	"strings"

	"os"
)

type SkillUsageEntry struct {
	ID         string `json:"id"`
	Path       string `json:"path"`
	Source     string `json:"source"`
	Reads      int    `json:"reads"`
	LastReadAt *int64 `json:"lastReadAt"`
	NeverRead  bool   `json:"neverRead"`
}

type SkillUsageReport struct {
	Skills  []SkillUsageEntry `json:"skills"`
	Summary struct {
		Skills    int `json:"skills"`
		NeverRead int `json:"neverRead"`
	} `json:"summary"`
}

const skillUsageRetentionDays = 90

type SkillUsageInput struct {
	Store          *TaskStore
	ProjectRoot    string
	ProjectRoots   []string
	AgentSkillsDir string
	CapabilityRoot string
	KeepDays       *int
	Now            *int64
}

// SkillUsage reports which skills were actually read, and which never were.
//
// Read-only by construction: it derives from the tool calls the runtime already recorded, so it
// needs no second write path of its own. A call counts for a skill when it touched a file inside
// that skill's folder — the SKILL.md itself or a reference it pulled in.
func SkillUsage(input SkillUsageInput) SkillUsageReport {
	keepDays := skillUsageRetentionDays
	if input.KeepDays != nil {
		keepDays = *input.KeepDays
	}
	now := NowMillis()
	if input.Now != nil {
		now = *input.Now
	}
	rows := sqliteRows(input.Store.DB, "SELECT target, created_at FROM tool_calls WHERE target IS NOT NULL AND created_at >= ?", now-int64(keepDays)*86400000)
	type group struct {
		base   string
		source string
	}
	var groups []group
	roots := append([]string{}, input.ProjectRoots...)
	if input.ProjectRoot != "" {
		roots = append(roots, input.ProjectRoot)
	}
	for _, root := range roots {
		groups = append(groups, group{filepath.Join(root, ".agents", "skills"), "project"})
		groups = append(groups, group{filepath.Join(root, ".pi", "skills"), "project"})
	}
	if input.AgentSkillsDir != "" {
		groups = append(groups, group{input.AgentSkillsDir, "agent"})
	}
	if input.CapabilityRoot != "" {
		groups = append(groups, group{filepath.Join(input.CapabilityRoot, "skills"), "library"})
	}
	skills := []SkillUsageEntry{}
	for _, group := range groups {
		if _, err := os.Stat(group.base); err != nil {
			continue
		}
		entries, err := os.ReadDir(group.base)
		if err != nil {
			panic(err)
		}
		for _, entry := range entries {
			dir := filepath.Join(group.base, entry.Name())
			if _, err := os.Stat(filepath.Join(dir, "SKILL.md")); err != nil {
				continue
			}
			prefix := dir + "/"
			reads := 0
			var lastReadAt *int64
			for _, row := range rows {
				target := sqlString(row["target"])
				if target != dir && !strings.HasPrefix(target, prefix) {
					continue
				}
				reads++
				created := sqlInt(row["created_at"])
				if lastReadAt == nil || created > *lastReadAt {
					stamp := created
					lastReadAt = &stamp
				}
			}
			// One skill can live in several folders (a project dir and the mirror); keep the first sighting
			// but let a used copy win over an identical unused one.
			replaced := false
			for i := range skills {
				if skills[i].ID != entry.Name() {
					continue
				}
				if reads > skills[i].Reads {
					skills[i].Reads = reads
					skills[i].LastReadAt = lastReadAt
					skills[i].NeverRead = reads == 0
					skills[i].Path = dir
					skills[i].Source = group.source
				}
				replaced = true
				break
			}
			if replaced {
				continue
			}
			skills = append(skills, SkillUsageEntry{
				ID: entry.Name(), Path: dir, Source: group.source, Reads: reads, LastReadAt: lastReadAt, NeverRead: reads == 0,
			})
		}
	}
	sort.SliceStable(skills, func(i, j int) bool {
		if skills[i].Reads != skills[j].Reads {
			return skills[i].Reads > skills[j].Reads
		}
		return skills[i].ID < skills[j].ID
	})
	never := 0
	for _, skill := range skills {
		if skill.NeverRead {
			never++
		}
	}
	report := SkillUsageReport{Skills: skills}
	report.Summary.Skills = len(skills)
	report.Summary.NeverRead = never
	return report
}
