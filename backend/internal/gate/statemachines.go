package gate

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/chenx0414/graph/backend/statemachine"
)

type RegistryFact struct {
	Table  string
	Column string
	Value  string
	File   string
}

type RegistryEdge struct {
	Table  string
	Column string
	From   string
	To     string
	File   string
}

type RegistryEvidence struct {
	Facts  []RegistryFact
	Edges  []RegistryEdge
	Files  int
	Params int
}

var registryStateColumns = map[string]bool{"state": true, "status": true, "phase": true, "route_stage": true}

var (
	registryUpdate = regexp.MustCompile(`(?is)\bUPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+(.+?)(?:\bWHERE\b\s+(.+))?$`)
	registryInsert = regexp.MustCompile(`(?is)\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)`)
	registryCreate = regexp.MustCompile(`(?is)\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(`)
	registryCheck  = regexp.MustCompile(`(?is)\bCHECK\s*\(\s*([a-z_][a-z0-9_]*)\s+IN\s*\(([^)]*)\)\s*\)`)
	registryAssign = regexp.MustCompile(`(?is)\b([a-z_][a-z0-9_]*)\s*=\s*('(?:[^']*)'|\?)`)
	registryGuard  = regexp.MustCompile(`(?is)\b([a-z_][a-z0-9_]*)\s*=\s*'([^']*)'`)
	registryIn     = regexp.MustCompile(`(?is)\b([a-z_][a-z0-9_]*)\s+IN\s*\(([^)]*)\)`)
	registryQuote  = regexp.MustCompile(`'([^']*)'`)

	registryQualified = regexp.MustCompile(`(?i)\b[a-z_][a-z0-9_]*\s*\.\s*(?:state|status|phase|route_stage)\b`)
)

func ScanRegistryStates(root string) RegistryEvidence {
	evidence := RegistryEvidence{}
	for _, directory := range []string{"backend", "app"} {
		_ = filepath.Walk(filepath.Join(root, directory), func(path string, info os.FileInfo, err error) error {
			if err != nil || info == nil {
				return nil
			}
			if info.IsDir() {
				if registrySkipDir(info.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			relative, relativeErr := filepath.Rel(root, path)
			if relativeErr != nil {
				relative = path
			}
			evidence.Files++
			scanRegistryFile(filepath.ToSlash(relative), path, &evidence)
			return nil
		})
	}
	sort.SliceStable(evidence.Facts, func(left, right int) bool {
		a, b := evidence.Facts[left], evidence.Facts[right]
		return a.Table+"."+a.Column+"."+a.Value+"."+a.File < b.Table+"."+b.Column+"."+b.Value+"."+b.File
	})
	sort.SliceStable(evidence.Edges, func(left, right int) bool {
		a, b := evidence.Edges[left], evidence.Edges[right]
		return a.Table+"."+a.Column+"."+a.From+"."+a.To+"."+a.File < b.Table+"."+b.Column+"."+b.From+"."+b.To+"."+b.File
	})
	return evidence
}

func registrySkipDir(name string) bool {
	switch name {
	case "vendor", "node_modules", "dist", "build", "testdata":
		return true
	}
	return false
}

func scanRegistryFile(relative, path string, evidence *RegistryEvidence) {
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		return
	}
	ast.Inspect(file, func(node ast.Node) bool {
		literal, ok := node.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		text, unquoteErr := strconv.Unquote(literal.Value)
		if unquoteErr != nil {
			return true
		}
		scanRegistrySQL(relative, text, evidence)
		return true
	})
}

func scanRegistrySQL(relative, text string, evidence *RegistryEvidence) {
	if !strings.Contains(text, "'") && !strings.Contains(text, "?") {
		return
	}
	for _, statement := range registryUpdate.FindAllStringSubmatch(text, -1) {
		recordRegistryAssignments(relative, strings.ToLower(statement[1]), statement[2], statement[3], evidence)
	}
	for _, statement := range registryInsert.FindAllStringSubmatch(text, -1) {
		recordRegistryInsert(relative, strings.ToLower(statement[1]), statement[2], statement[3], evidence)
	}
	for _, statement := range registryCreate.FindAllStringSubmatchIndex(text, -1) {
		table := strings.ToLower(text[statement[2]:statement[3]])
		if registryShadowTable(table) {
			continue
		}
		for _, check := range registryCheck.FindAllStringSubmatch(text[statement[1]:], -1) {
			column := strings.ToLower(check[1])
			if !registryStateColumns[column] {
				continue
			}
			for _, value := range registryQuote.FindAllStringSubmatch(check[2], -1) {
				recordRegistryFact(evidence, table, column, value[1], relative)
			}
		}
	}
}

func recordRegistryAssignments(relative, table, assignments, where string, evidence *RegistryEvidence) {
	if registryShadowTable(table) {
		return
	}
	assignments = registryQualified.ReplaceAllString(assignments, "")
	where = registryQualified.ReplaceAllString(where, "")
	assigned := map[string]bool{}
	for _, match := range registryAssign.FindAllStringSubmatch(assignments, -1) {
		column := strings.ToLower(match[1])
		if !registryStateColumns[column] {
			continue
		}
		assigned[column] = true
		values := registryQuote.FindAllStringSubmatch(match[2], -1)
		if len(values) == 0 {
			evidence.Params++
			continue
		}
		for _, value := range values {
			recordRegistryFact(evidence, table, column, value[1], relative)
			for _, from := range registryGuards(column, where) {
				recordRegistryEdge(evidence, table, column, from, value[1], relative)
			}
		}
	}
	for _, match := range registryGuard.FindAllStringSubmatch(where, -1) {
		column := strings.ToLower(match[1])
		if registryStateColumns[column] && !assigned[column] {
			recordRegistryFact(evidence, table, column, match[2], relative)
		}
	}
	for _, match := range registryIn.FindAllStringSubmatch(where, -1) {
		column := strings.ToLower(match[1])
		if !registryStateColumns[column] || assigned[column] {
			continue
		}
		for _, value := range registryQuote.FindAllStringSubmatch(match[2], -1) {
			recordRegistryFact(evidence, table, column, value[1], relative)
		}
	}
}

func registryGuards(column, where string) []string {
	if where == "" {
		return nil
	}
	guards := []string{}
	for _, match := range registryGuard.FindAllStringSubmatch(where, -1) {
		if strings.ToLower(match[1]) == column {
			guards = append(guards, match[2])
		}
	}
	for _, match := range registryIn.FindAllStringSubmatch(where, -1) {
		if strings.ToLower(match[1]) != column {
			continue
		}
		for _, value := range registryQuote.FindAllStringSubmatch(match[2], -1) {
			guards = append(guards, value[1])
		}
	}
	return guards
}

func recordRegistryInsert(relative, table, columns, values string, evidence *RegistryEvidence) {
	if registryShadowTable(table) {
		return
	}
	names := strings.Split(columns, ",")
	cells := registrySplitValues(values)
	if len(names) != len(cells) {
		return
	}
	for index, name := range names {
		column := strings.ToLower(strings.TrimSpace(name))
		if !registryStateColumns[column] {
			continue
		}
		found := registryQuote.FindAllStringSubmatch(cells[index], -1)
		if len(found) == 0 {
			evidence.Params++
			continue
		}
		for _, value := range found {
			recordRegistryFact(evidence, table, column, value[1], relative)
		}
	}
}

func registrySplitValues(values string) []string {
	cells := []string{}
	depth := 0
	quoted := false
	current := strings.Builder{}
	for _, symbol := range values {
		switch {
		case symbol == '\'':
			quoted = !quoted
			current.WriteRune(symbol)
		case quoted:
			current.WriteRune(symbol)
		case symbol == '(':
			depth++
			current.WriteRune(symbol)
		case symbol == ')':
			depth--
			current.WriteRune(symbol)
		case symbol == ',' && depth == 0:
			cells = append(cells, current.String())
			current.Reset()
		default:
			current.WriteRune(symbol)
		}
	}
	return append(cells, current.String())
}

func registryShadowTable(table string) bool {
	return strings.HasSuffix(table, "_next")
}

func recordRegistryFact(evidence *RegistryEvidence, table, column, value, relative string) {
	if value == "" {
		return
	}
	evidence.Facts = append(evidence.Facts, RegistryFact{Table: table, Column: column, Value: value, File: relative})
}

func recordRegistryEdge(evidence *RegistryEvidence, table, column, from, to, relative string) {
	if from == "" || to == "" || from == to {
		return
	}
	evidence.Edges = append(evidence.Edges, RegistryEdge{Table: table, Column: column, From: from, To: to, File: relative})
}

type RegistryProblem struct {
	Kind   string
	Detail string
}

func CheckRegistryStates(evidence RegistryEvidence, machines []statemachine.Machine) []RegistryProblem {
	problems := []RegistryProblem{}
	declared := map[string]map[string]bool{}
	byTarget := map[string]statemachine.Machine{}
	for _, machine := range machines {
		states := map[string]bool{}
		for _, state := range machine.States {
			states[state.Name] = true
		}
		for _, target := range machine.Targets {
			declared[target.Table+"."+target.Column] = states
			byTarget[target.Table+"."+target.Column] = machine
		}
	}
	unowned := map[string]bool{}
	for _, fact := range evidence.Facts {
		target := fact.Table + "." + fact.Column
		states, ok := declared[target]
		if !ok {
			if !unowned[target] {
				unowned[target] = true
				problems = append(problems, RegistryProblem{Kind: "undeclared-machine", Detail: target + " (" + fact.File + ")"})
			}
			continue
		}
		if !states[fact.Value] {
			problems = append(problems, RegistryProblem{Kind: "undeclared-state", Detail: target + " = " + fact.Value + " (" + fact.File + ")"})
		}
	}
	for _, edge := range evidence.Edges {
		machine, ok := byTarget[edge.Table+"."+edge.Column]
		if !ok {
			continue
		}
		allowed, known := machine.Allows(edge.From, edge.To)
		if known && !allowed {
			problems = append(problems, RegistryProblem{Kind: "illegal-transition", Detail: machine.ID + ": " + edge.From + " -> " + edge.To + " (" + edge.File + ")"})
		}
	}
	seen := map[string]bool{}
	deduped := make([]RegistryProblem, 0, len(problems))
	for _, problem := range problems {
		key := problem.Kind + "\x00" + problem.Detail
		if seen[key] {
			continue
		}
		seen[key] = true
		deduped = append(deduped, problem)
	}
	sort.Slice(deduped, func(left, right int) bool {
		if deduped[left].Kind != deduped[right].Kind {
			return deduped[left].Kind < deduped[right].Kind
		}
		return deduped[left].Detail < deduped[right].Detail
	})
	return deduped
}
