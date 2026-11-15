package harness

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDecideCallsTheToolWhenTheHarnessSaysHow(t *testing.T) {
	step := []Step{{Rule: "read", Tool: "read", Arguments: map[string]any{"path": "config.go"}}}
	prompt := "Use read to examine files instead of cat"
	chosen := decide(Case{Steps: step}, 0, prompt, []string{"read", "edit"})
	if chosen.kind != "call" || chosen.tool != "read" {
		t.Fatalf("decision = %+v", chosen)
	}
}

func TestDecideBlocksWhenTheRuleIsMissingFromThePrompt(t *testing.T) {
	step := []Step{{Rule: "read", Tool: "read"}}
	chosen := decide(Case{Steps: step}, 0, "no rule here", []string{"read"})
	if chosen.kind != "blocked" || !strings.Contains(chosen.reason, "Use read to examine files") {
		t.Fatalf("decision = %+v", chosen)
	}
}

func TestDecideBlocksWhenTheToolIsNotOffered(t *testing.T) {
	step := []Step{{Rule: "edit", Tool: "edit"}}
	chosen := decide(Case{Steps: step}, 0, "Use edit for precise changes", []string{"read"})
	if chosen.kind != "blocked" || !strings.Contains(chosen.reason, "edit tool") {
		t.Fatalf("decision = %+v", chosen)
	}
}

func TestDecideAnswersWhenTheStepsAreDone(t *testing.T) {
	if chosen := decide(Case{Steps: []Step{{Rule: "read", Tool: "read"}}}, 1, "", nil); chosen.kind != "answer" {
		t.Fatalf("decision = %+v", chosen)
	}
}

func TestJudgeReportsOrderForbiddenToolsAndFailures(t *testing.T) {
	caseScript := Cases["parser"]
	problems := Judge(caseScript, Report{
		ToolCalls:    []string{"read", "write"},
		ToolErrors:   1,
		Verification: "behavioral check failed: boom",
		TaskSuccess:  false,
	})
	joined := strings.Join(problems, "\n")
	for _, want := range []string{"the case needs read → edit → read", "reserves for complete rewrites", "a tool call failed", "behavioral check failed"} {
		if !strings.Contains(joined, want) {
			t.Errorf("problems are missing %q:\n%s", want, joined)
		}
	}
	if len(Judge(caseScript, Report{ToolCalls: []string{"read", "edit", "read"}, TaskSuccess: true})) != 0 {
		t.Errorf("a clean run must judge as a pass")
	}
}

func TestSurfaceChangesNamesChangedAndRemovedFiles(t *testing.T) {
	changed := SurfaceChanges(
		map[string]string{"a.go": "1", "b.go": "2"},
		map[string]string{"a.go": "9", "b.go": "2"},
	)
	if len(changed) != 1 || changed[0] != "a.go" {
		t.Fatalf("changed = %v", changed)
	}
	removed := SurfaceChanges(map[string]string{"a.go": "1", "gone.go": "2"}, map[string]string{"a.go": "1"})
	if len(removed) != 1 || removed[0] != "gone.go (removed)" {
		t.Fatalf("removed = %v", removed)
	}
}

func TestEveryFrozenCaseCarriesItsOwnSolutionAndCheck(t *testing.T) {
	if len(CaseOrder) == 0 {
		t.Fatal("no frozen case is registered")
	}
	for _, caseID := range CaseOrder {
		caseScript, known := Cases[caseID]
		if !known {
			t.Fatalf("%s is ordered but not defined", caseID)
		}
		if caseScript.Prompt == "" || len(caseScript.Files) == 0 || len(caseScript.Verify) == 0 {
			t.Fatalf("%s is missing its task, its files or its check", caseID)
		}
		if len(caseScript.Steps) == 0 || len(caseScript.Expected) == 0 {
			t.Fatalf("%s has no scripted solution or no discipline", caseID)
		}
		for _, name := range caseScript.Protected {
			if _, kept := caseScript.Files[name]; !kept {
				t.Fatalf("%s protects %s without shipping it", caseID, name)
			}
		}
		if len(caseScript.Steps) != len(caseScript.Expected) {
			t.Fatalf("%s carries %d steps but expects %d tools", caseID, len(caseScript.Steps), len(caseScript.Expected))
		}
	}
}

func TestGreenRunsDoNotLeaveTheirRootBehind(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "state")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	failed := filepath.Join(t.TempDir(), "failed-run")
	if err := os.MkdirAll(failed, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	releaseRoot(root, true)
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("a green run left %s behind", root)
	}
	releaseRoot(failed, false)
	if _, err := os.Stat(failed); err != nil {
		t.Fatalf("a failed run must keep its root for inspection: %v", err)
	}
}

func TestTheEvalConfigPointsAtTheCaseProject(t *testing.T) {
	path := filepath.Join(t.TempDir(), "graph.config.json")
	original := `{"version":1,"projects":[{"id":"graph","root":"."}],"credentials":{"opencode-go":{"secretRef":"OPENCODE_GO_API_KEY"}},"models":{"entries":[{"id":"deepseek-v4-flash","provider":"opencode-go"}]}}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	payload, err := configWithProject(path, "/tmp/case-project")
	if err != nil {
		t.Fatalf("rewrite the config: %v", err)
	}
	var config struct {
		Projects []struct {
			ID   string `json:"id"`
			Root string `json:"root"`
		} `json:"projects"`
		Models struct {
			Entries []struct {
				ID string `json:"id"`
			} `json:"entries"`
		} `json:"models"`
	}
	if err := json.Unmarshal(payload, &config); err != nil {
		t.Fatalf("parse the rewritten config: %v", err)
	}
	if len(config.Projects) != 1 || config.Projects[0].ID != "p" || config.Projects[0].Root != "/tmp/case-project" {
		t.Fatalf("the case project replaces the repository project, got %+v", config.Projects)
	}
	if len(config.Models.Entries) != 1 || config.Models.Entries[0].ID != "deepseek-v4-flash" {
		t.Fatalf("the real models stay in the config, got %+v", config.Models.Entries)
	}
}
