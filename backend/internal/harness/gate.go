package harness

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var SurfaceFiles = []string{
	"backend/internal/graph/runtime_agent_context.go",
	"backend/internal/graph/runtime_agent_tool_definitions.go",
	"backend/internal/graph/runtime_agent_tools.go",
	"backend/internal/graph/runtime_pi_native_tools.go",
	"backend/internal/graph/runtime_pig_native_tools.go",
	"backend/internal/harness/cases.go",
	"backend/internal/harness/provider.go",
	"backend/internal/harness/run.go",
	"backend/internal/harness/gate.go",
}

type State struct {
	SchemaVersion int               `json:"schemaVersion"`
	Cases         map[string]string `json:"cases"`
	Surface       map[string]string `json:"surface"`
	UpdatedAt     string            `json:"updatedAt,omitempty"`
}

func DigestOf(path string) string {
	payload, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func ShippedSurface(repository string) map[string]string {
	surface := map[string]string{}
	for _, file := range SurfaceFiles {
		surface[file] = DigestOf(filepath.Join(repository, file))
	}
	return surface
}

func LiveSurface(home string) map[string]string {
	files := map[string]string{}
	root := filepath.Join(home, ".graph")
	prompts := filepath.Join(root, "prompts")
	_ = filepath.Walk(prompts, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		files[relative] = DigestOf(path)
		return nil
	})
	recipes := filepath.Join(root, "agent-combinations.json")
	if digest := DigestOf(recipes); digest != "" {
		files["agent-combinations.json"] = digest
	}
	return files
}

func ReadState(path string) State {
	state := State{SchemaVersion: 1, Cases: map[string]string{}, Surface: map[string]string{}}
	payload, err := os.ReadFile(path)
	if err != nil {
		return state
	}
	if json.Unmarshal(payload, &state) != nil {
		return State{SchemaVersion: 1, Cases: map[string]string{}, Surface: map[string]string{}}
	}
	if state.Cases == nil {
		state.Cases = map[string]string{}
	}
	if state.Surface == nil {
		state.Surface = map[string]string{}
	}
	return state
}

func SurfaceChanges(recorded, current map[string]string) []string {
	changed := []string{}
	names := make([]string, 0, len(current))
	for file := range current {
		names = append(names, file)
	}
	sort.Strings(names)
	for _, file := range names {
		if recorded[file] != current[file] {
			changed = append(changed, file)
		}
	}
	removed := []string{}
	for file := range recorded {
		if _, kept := current[file]; !kept {
			removed = append(removed, file+" (removed)")
		}
	}
	sort.Strings(removed)
	return append(changed, removed...)
}

type GateOptions struct {
	Repository string
	StatePath  string
	Record     bool
	Timeout    time.Duration
	Print      func(string)
}

func Gate(options GateOptions) (int, error) {
	print := options.Print
	if print == nil {
		print = func(string) {}
	}
	state := ReadState(options.StatePath)
	surface := ShippedSurface(options.Repository)
	changed := SurfaceChanges(state.Surface, surface)
	live := LiveSurface(os.Getenv("HOME"))

	verdicts := map[string]string{}
	failures := []string{}
	for _, caseID := range CaseOrder {
		caseScript, known := Cases[caseID]
		if !known {
			failures = append(failures, caseID+": the frozen case has no scripted solution, so the gate cannot carry it out")
			verdicts[caseID] = "fail"
			continue
		}
		report := Run(Options{Repository: options.Repository, CaseID: caseID, Timeout: options.Timeout})
		problems := Judge(caseScript, report)
		verdict := "pass"
		if len(problems) > 0 {
			verdict = "fail"
			note := "failed"
			if state.Cases[caseID] == "pass" {
				note = "regressed"
			}
			failures = append(failures, caseID+": "+note+" - "+strings.Join(problems, "; "))
		}
		verdicts[caseID] = verdict
		line := caseID + ": " + verdict
		if verdict == "fail" {
			line += " - " + strings.Join(problems, "; ")
		}
		print(line + "\n")
	}
	if len(changed) > 0 {
		print("harness surface changed since the last judged run:\n")
		for _, file := range changed {
			print("  " + file + "\n")
		}
	}
	if len(live) > 0 {
		print(fmt.Sprintf("live prompt library: %d file(s), judged surface: the shipped defaults\n", len(live)))
	}
	if len(failures) > 0 {
		print("\nharness behavior gate failed:\n")
		for _, line := range failures {
			print("  " + line + "\n")
		}
		return 1, nil
	}
	if !sameVerdicts(state.Cases, verdicts) || !sameVerdicts(state.Surface, surface) {
		if !options.Record {
			print("the judged state moved, and was not recorded (a check must not rewrite a tracked file)\n")
			print("record it deliberately: graphcheck harness --record\n")
		} else {
			next := State{SchemaVersion: 1, Cases: verdicts, Surface: surface, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
			payload, err := json.MarshalIndent(next, "", "  ")
			if err != nil {
				return 1, err
			}
			if err := os.WriteFile(options.StatePath, append(payload, '\n'), 0o644); err != nil {
				return 1, err
			}
			print("recorded the judged harness surface and the case verdicts\n")
		}
	} else {
		print("the harness surface and every case are unchanged\n")
	}
	print("harness behavior gate passed\n")
	return 0, nil
}

func sameVerdicts(recorded, current map[string]string) bool {
	if len(recorded) != len(current) {
		return false
	}
	for key, value := range current {
		if recorded[key] != value {
			return false
		}
	}
	return true
}
