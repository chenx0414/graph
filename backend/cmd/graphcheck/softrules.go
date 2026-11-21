package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const softRuleReportPath = "verification/controls/soft-rules.json"

type softRule struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Origin   string `json:"origin"`
	Kind     string `json:"kind"`
	Text     string `json:"text"`
	Size     int    `json:"size"`
	Owner    string `json:"owner"`
	State    string `json:"state"`
	Enforced string `json:"enforcedBy,omitempty"`
	Proposed string `json:"proposed,omitempty"`
}

type ruleVerdict struct {
	State      string `json:"state"`
	Why        string `json:"why"`
	Proposed   string `json:"proposed"`
	EnforcedBy string `json:"enforcedBy"`
	Evidence   string   `json:"evidence"`
	Splits     string   `json:"splits"`
	Witness    []string `json:"witness"`
}

type softRuleReport struct {
	Schema  int            `json:"schema"`
	Total   int            `json:"total"`
	Bytes   int            `json:"bytes"`
	ByState map[string]int `json:"byState"`
	Rules   []softRule     `json:"rules"`
}

var softDirectivePattern = regexp.MustCompile(`(?i)\b(must|should|never|always|do not|don't|prefer|avoid|ensure|make sure|only)\b`)

func runSoftRules(root string, args []string) int {
	write := hasFlag(args, "--write")
	report, err := collectSoftRules(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "soft rules: %v\n", err)
		return 2
	}
	target := filepath.Join(root, softRuleReportPath)
	if write {
		payload, marshalErr := json.MarshalIndent(report, "", "  ")
		if marshalErr != nil {
			fmt.Fprintf(os.Stderr, "soft rules: %v\n", marshalErr)
			return 2
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "soft rules: %v\n", err)
			return 2
		}
		if err := os.WriteFile(target, append(payload, '\n'), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "soft rules: %v\n", err)
			return 2
		}
		fmt.Printf("wrote %s: %d soft rule(s), %d bytes\n", softRuleReportPath, report.Total, report.Bytes)
		return 0
	}
	fmt.Printf("soft rules: %d in total, %d bytes\n", report.Total, report.Bytes)
	states := make([]string, 0, len(report.ByState))
	for state := range report.ByState {
		states = append(states, state)
	}
	sort.Strings(states)
	for _, state := range states {
		fmt.Printf("  %-10s %d\n", state, report.ByState[state])
	}
	fmt.Println("")
	fmt.Println("  go -C backend run ./cmd/graphcheck softrules --write   rewrite verification/controls/soft-rules.json")
	return 0
}

func collectSoftRules(root string) (softRuleReport, error) {
	rules := []softRule{}
	constants, err := constantRules(root)
	if err != nil {
		return softRuleReport{}, err
	}
	rules = append(rules, constants...)
	repoRules, err := markdownRules(root)
	if err != nil {
		return softRuleReport{}, err
	}
	rules = append(rules, repoRules...)
	report := softRuleReport{Schema: 1, Rules: rules, ByState: map[string]int{}}
	verdicts := verdictStates(root)
	total := 0
	for index := range report.Rules {
		rule := &report.Rules[index]
		if verdict, known := verdicts[rule.Name]; known {
			rule.State = verdict.State
			rule.Enforced = verdict.EnforcedBy
			rule.Proposed = verdict.Proposed
		}
		total += rule.Size
		report.ByState[rule.State]++
	}
	sort.SliceStable(report.Rules, func(left, right int) bool {
		if report.Rules[left].Origin != report.Rules[right].Origin {
			return report.Rules[left].Origin < report.Rules[right].Origin
		}
		return report.Rules[left].Size > report.Rules[right].Size
	})
	for index := range report.Rules {
		report.Rules[index].ID = fmt.Sprintf("S-%03d", index+1)
	}
	report.Total = len(report.Rules)
	report.Bytes = total
	return report, nil
}

// constantRules reads the rule text compiled into the binary. Those strings reach every
// agent on every turn, so they are the highest-leverage prose in the repository and also
// the hardest to notice: they live beside code, not in a document.
func constantRules(root string) ([]softRule, error) {
	path := filepath.Join(root, "backend", "internal", "graph", "runtime_agent_context.go")
	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, path, nil, 0)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	rules := []softRule{}
	ast.Inspect(file, func(node ast.Node) bool {
		spec, ok := node.(*ast.ValueSpec)
		if !ok {
			return true
		}
		for index, name := range spec.Names {
			if !strings.HasPrefix(name.Name, "DEFAULT_") || index >= len(spec.Values) {
				continue
			}
			literal, ok := spec.Values[index].(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				continue
			}
			text, unquoteErr := strconv.Unquote(literal.Value)
			if unquoteErr != nil {
				continue
			}
			if !softDirectivePattern.MatchString(text) {
				continue
			}
			rules = append(rules, softRule{
				Name:   name.Name,
				Origin: "binary-constant",
				Kind:   "prompt",
				Text:   clip(text, 400),
				Size:   len(text),
				Owner:  "backend/internal/graph/runtime_agent_context.go",
				State:  "open",
			})
		}
		return true
	})
	return rules, nil
}

// markdownRules reads the rule sentences left in the documents that are still being
// converted. They are already under a shrink-only budget, so this half exists to show what
// is still prose rather than to add another gate.
func markdownRules(root string) ([]softRule, error) {
	payload, err := os.ReadFile(filepath.Join(root, "backend", "internal", "gate", "testdata", "prose-baseline.json"))
	if err != nil {
		return nil, err
	}
	allowance := struct {
		Allowed []string `json:"allowed"`
	}{}
	if err := json.Unmarshal(payload, &allowance); err != nil {
		return nil, err
	}
	rules := []softRule{}
	for _, relative := range allowance.Allowed {
		path := filepath.Join(root, relative)
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		body := string(content)
		if !softDirectivePattern.MatchString(body) {
			continue
		}
		rules = append(rules, softRule{
			Name:   relative,
			Origin: "repository-document",
			Kind:   "document",
			Text:   clip(firstRuleSentence(body), 400),
			Size:   len(body),
			Owner:  relative,
			State:  "open",
		})
	}
	return rules, nil
}

func firstRuleSentence(body string) string {
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) < 20 || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "|") {
			continue
		}
		if softDirectivePattern.MatchString(trimmed) {
			return trimmed
		}
	}
	return strings.TrimSpace(strings.Split(body, "\n")[0])
}

func clip(text string, limit int) string {
	flat := strings.Join(strings.Fields(text), " ")
	if len(flat) <= limit {
		return flat
	}
	return flat[:limit] + "…"
}

func verdictStates(root string) map[string]ruleVerdict {
	verdicts := map[string]ruleVerdict{}
	payload, err := os.ReadFile(filepath.Join(root, "verification", "controls", "soft-rule-verdicts.json"))
	if err != nil {
		return verdicts
	}
	file := struct {
		Verdicts map[string]ruleVerdict `json:"verdicts"`
	}{}
	if err := json.Unmarshal(payload, &file); err != nil {
		return verdicts
	}
	return file.Verdicts
}
