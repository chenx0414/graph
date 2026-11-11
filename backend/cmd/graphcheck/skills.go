package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/chenx0414/graph/backend/internal/gate"
)

type skillsSummary struct {
	Skills   int `json:"skills"`
	Warnings int `json:"warnings"`
}

type skillsDocument struct {
	Root    string             `json:"root"`
	Mode    string             `json:"mode"`
	Skills  []gate.SkillReport `json:"skills"`
	Summary skillsSummary      `json:"summary"`
}

func runSkills(repoRoot string, arguments []string) int {
	root, skillsDir, capabilitiesDir := repoRoot, "", ""
	all, strict, asJSON := false, false, false
	for index := 0; index < len(arguments); index++ {
		switch arguments[index] {
		case "--root":
			index++
			root = valueAt(arguments, index)
		case "--skills":
			index++
			skillsDir = valueAt(arguments, index)
		case "--capabilities":
			index++
			capabilitiesDir = valueAt(arguments, index)
		case "--all":
			all = true
		case "--strict":
			strict = true
		case "--json":
			asJSON = true
		case "--help", "-h":
			fmt.Println("usage: graphcheck skills [--root <dir>] [--skills <dir>] [--capabilities <dir>] [--all] [--strict] [--json]")
			return 0
		default:
			fmt.Fprintf(os.Stderr, "graphcheck skills: unknown argument %s\n", arguments[index])
			return 2
		}
	}
	resolved, err := filepath.Abs(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcheck skills: %v\n", err)
		return 2
	}
	directories := append(gate.FindSkills(filepath.Join(resolved, ".agents", "skills")), gate.FindSkills(filepath.Join(resolved, ".pi", "skills"))...)
	for _, extra := range []struct{ path, join string }{{skillsDir, ""}, {capabilitiesDir, "skills"}} {
		if extra.path == "" {
			continue
		}
		absolute, absErr := filepath.Abs(extra.path)
		if absErr != nil {
			fmt.Fprintf(os.Stderr, "graphcheck skills: %v\n", absErr)
			return 2
		}
		directories = append(directories, gate.FindSkills(filepath.Join(absolute, extra.join))...)
	}

	reports := []gate.SkillReport{}
	total := 0
	for _, directory := range directories {
		skill, ok := gate.InspectSkill(directory)
		if !ok {
			continue
		}
		warnings := gate.LintSkill(skill, all)
		if len(warnings) > 0 || skill.Authored || all {
			if warnings == nil {
				warnings = []gate.SkillWarning{}
			}
			reports = append(reports, gate.SkillReport{ID: skill.ID, Path: skill.Path, Warnings: warnings})
			total += len(warnings)
		}
	}

	mode := "authored"
	if all {
		mode = "all"
	}
	if asJSON {
		document := skillsDocument{Root: resolved, Mode: mode, Skills: reports, Summary: skillsSummary{Skills: len(reports), Warnings: total}}
		payload, marshalErr := json.MarshalIndent(document, "", "  ")
		if marshalErr != nil {
			fmt.Fprintf(os.Stderr, "graphcheck skills: %v\n", marshalErr)
			return 2
		}
		fmt.Println(string(payload))
	} else {
		for _, report := range reports {
			for _, warning := range report.Warnings {
				fmt.Printf("warn  %s  %s: %s\n", warning.Rule, report.Path, warning.Message)
			}
		}
		if total == 0 {
			fmt.Printf("skills-lint: %d skill(s) checked, no warnings (%s)\n", len(reports), modeWord(mode))
		} else {
			fmt.Printf("skills-lint: %d skill(s) checked, %d warning(s) (advisory)\n", len(reports), total)
		}
	}
	if strict && total > 0 {
		return 1
	}
	return 0
}

func modeWord(mode string) string {
	if mode == "all" {
		return "all skills"
	}
	return "authored only"
}

func valueAt(arguments []string, index int) string {
	if index >= len(arguments) {
		return ""
	}
	return strings.TrimSpace(arguments[index])
}
