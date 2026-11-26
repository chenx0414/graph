package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A feature's entry point is the sentence a reader uses to find the thing on
// screen: 侧栏「洞察」 means the rail really offers 洞察. When a feature is
// deleted the entry keeps pointing at a control that no longer exists, and this
// map — the repository's list of what a user can reach — quietly lies.
//
// F-09 was exactly that: commit 76327dbf deleted the insights page, its UI and
// its tests, while the feature index still said 侧栏「洞察」 and every gate stayed
// green, because the map only ever compared routes.
func TestEveryEntryLabelInTheAppSourcesExistsInTheWindow(t *testing.T) {
	root := t.TempDir()
	writeEntryFixture(t, root, `{"schema":1,"features":[
{"id":"F-08","title":"轨迹页","entry":"侧栏「轨迹」"},
{"id":"F-14","title":"设置页","entry":"侧栏「设置」"}
]}`)
	writeAppSources(t, root, `package main

var railItems = []railItem{
	{"trajectory", "轨迹", iconActivity},
	{"settings", "设置", iconGear},
}
`)
	if missing := missingEntryLabels(root); len(missing) > 0 {
		t.Fatalf("both labels are on screen, yet they were reported missing: %v", missing)
	}

	writeAppSources(t, root, `package main

var railItems = []railItem{
	{"trajectory", "轨迹", iconActivity},
}
`)
	missing := missingEntryLabels(root)
	if len(missing) != 1 {
		t.Fatalf("an entry pointing at a deleted control must be reported once, got %v", missing)
	}
	if !strings.Contains(missing[0], "设置") || !strings.Contains(missing[0], "F-14") {
		t.Fatalf("the report names the feature and the label that is gone, got %q", missing[0])
	}
}

// The rail is the real case this gate was added for: the six labels the index
// claims must all be present, and a seventh entry may not survive in the map.
func TestTheRailLabelsTheIndexClaimsAreTheOnesTheAppHas(t *testing.T) {
	root := t.TempDir()
	writeEntryFixture(t, root, `{"schema":1,"features":[
{"id":"F-08","title":"轨迹页","entry":"侧栏「轨迹」"},
{"id":"F-09","title":"洞察页","entry":"侧栏「洞察」"}
]}`)
	writeAppSources(t, root, `package main

var railItems = []railItem{
	{"trajectory", "轨迹", iconActivity},
	{"fleet", "编队", iconNetwork},
	{"providers", "供应商", iconDatabase},
	{"capabilities", "资源", iconShare},
	{"assemblies", "装配", iconLayers},
	{"settings", "设置", iconGear},
}
`)
	missing := missingEntryLabels(root)
	if len(missing) != 1 || !strings.Contains(missing[0], "F-09") {
		t.Fatalf("a feature whose page was deleted must be the one reported, got %v", missing)
	}
}

func writeEntryFixture(t *testing.T, root, index string) {
	t.Helper()
	dir := filepath.Join(root, "verification", "skills", "verify-graph", "features")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir features: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.json"), []byte(index), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
}

func writeAppSources(t *testing.T, root, source string) {
	t.Helper()
	dir := filepath.Join(root, "app")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir app: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read app: %v", err)
	}
	for _, entry := range entries {
		if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil {
			t.Fatalf("clear app: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "rail.go"), []byte(source), 0o644); err != nil {
		t.Fatalf("write app source: %v", err)
	}
}
