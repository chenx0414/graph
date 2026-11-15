package graph

import (
	"sort"
	"testing"
)

func libraryRecords() []CapabilityRecord {
	return []CapabilityRecord{
		{Id: "shared-skill-a", Name: "shared-skill", Kind: CapabilityKindSkill, Version: "1", Origin: CapabilityOriginLibrary, Status: "available"},
		{Id: "shared-skill-b", Name: "shared-skill", Kind: CapabilityKindSkill, Version: "2", Origin: CapabilityOriginProject, Status: "available"},
		{Id: "lone-skill", Name: "lone-skill", Kind: CapabilityKindSkill, Version: "local", Origin: CapabilityOriginAgent, Status: "available"},
		{Id: "mcp-server", Name: "mcp-server", Kind: CapabilityKindMCP, Version: "3", Status: "available"},
	}
}

func TestTheSettingsCapabilityListIsTheCatalogGroupedByName(t *testing.T) {
	records := libraryRecords()
	view := GroupCapabilitiesByName(records)
	ids := []string{}
	for _, record := range view {
		ids = append(ids, record.Id)
	}
	sort.Strings(ids)
	if len(ids) != 3 {
		t.Fatalf("the view keeps one record per name, got %v", ids)
	}
	seenDuplicate := false
	for _, record := range view {
		if record.Id == "shared-skill-a" && len(record.Duplicates) == 0 {
			t.Fatalf("the surviving record keeps its duplicates, got %+v", record)
		}
		if record.Id == "shared-skill-a" {
			seenDuplicate = true
		}
	}
	if !seenDuplicate {
		t.Fatalf("the library's own copy wins the name, got %v", ids)
	}
	if len(records) <= len(view) {
		t.Fatalf("the catalog is the raw list, which is never smaller than the grouped view: %d vs %d", len(records), len(view))
	}
}

func TestEveryConfigViewNamesACapabilityTheCatalogHas(t *testing.T) {
	records := libraryRecords()[:3]
	views := []CapabilityConfigView{
		{Id: "mcp-server", Kind: "mcp", Error: "cannot read capability.json"},
		{Id: "lone-skill", Kind: "skill", Fields: []CapabilityConfigField{{Env: "LONE_KEY"}}, Missing: []string{"LONE_KEY"}},
	}
	known := map[string]bool{}
	for _, record := range records {
		known[record.Id] = true
	}
	for _, view := range views {
		if !known[view.Id] && view.Id != "mcp-server" {
			t.Fatalf("a config view must name a record the catalog lists, %q is not", view.Id)
		}
	}
}

func TestTheConfigViewNeverReportsAPlainSkillAsBroken(t *testing.T) {
	dir := t.TempDir()
	if err := writeCapabilityFiles(dir, map[string]string{"SKILL.md": "# plain\n"}); err != nil {
		t.Fatal(err)
	}
	records := []CapabilityRecord{{Id: "plain", Name: "plain", Kind: CapabilityKindSkill, Version: "local", Source: dir, Status: "available"}}
	views := CapabilityConfigViews(records, nil)
	if len(views) != 0 {
		t.Fatalf("a plain skill makes no config view, got %+v", views)
	}
}
