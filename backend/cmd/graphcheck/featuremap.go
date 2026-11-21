package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"

	"github.com/chenx0414/graph/backend/internal/gate"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type featureEntry struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Entry         string   `json:"entry"`
	API           []string `json:"api"`
	ExistingTests []string `json:"existingTests"`
	Command       string   `json:"command"`
}

type featureIndex struct {
	Features []featureEntry `json:"features"`
}

type routeRecord struct {
	Method  string
	Path    string
	Handler string
}

type handlerRecord struct {
	Name string
	File string
}

type featureRow struct {
	Feature featureEntry
	Routes  []routeRecord
	Tests   []string
	Missing []string
}

var routeMethodPattern = regexp.MustCompile(`\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b`)

func runFeatureMap(root string, args []string) int {
	write := hasFlag(args, "--write")
	rendered, err := renderFeatureMap(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "feature map: %v\n", err)
		return 2
	}
	target := filepath.Join(root, "FEATURE_MAP.md")
	if write {
		if err := os.WriteFile(target, []byte(rendered), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "feature map: %v\n", err)
			return 2
		}
		fmt.Println("wrote " + target)
		return 0
	}
	payload, err := os.ReadFile(target)
	if err != nil {
		fmt.Fprintf(os.Stderr, "feature map: %v\n", err)
		fmt.Fprintln(os.Stderr, "Create it deliberately:  go -C backend run ./cmd/graphcheck featuremap --write")
		return 1
	}
	if string(payload) == rendered {
		fmt.Printf("feature map: %d feature(s), every entry point and handler matches the code\n", countFeatures(rendered))
		return 0
	}
	fmt.Fprintln(os.Stderr, "The feature map no longer matches the code:")
	for _, line := range diffLines(string(payload), rendered) {
		fmt.Fprintln(os.Stderr, "  "+line)
	}
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "The map is generated from the feature index, the route table and the handler files, so a hand edit is always wrong.")
	fmt.Fprintln(os.Stderr, "Regenerate it:  go -C backend run ./cmd/graphcheck featuremap --write")
	return 1
}

func countFeatures(rendered string) int {
	count := 0
	for _, line := range strings.Split(rendered, "\n") {
		if strings.HasPrefix(line, "| [F-") {
			count++
		}
	}
	return count
}

func diffLines(current, wanted string) []string {
	have := map[string]bool{}
	for _, line := range strings.Split(current, "\n") {
		have[line] = true
	}
	missing := []string{}
	for _, line := range strings.Split(wanted, "\n") {
		if strings.TrimSpace(line) == "" || have[line] {
			continue
		}
		missing = append(missing, "+ "+line)
		if len(missing) == 12 {
			return append(missing, "...")
		}
	}
	if len(missing) == 0 {
		missing = append(missing, "+ the rendered map differs in whitespace or ordering")
	}
	return missing
}

func readFeatureIndex(root string) (featureIndex, error) {
	path := filepath.Join(root, "verification", "skills", "verify-graph", "features", "index.json")
	payload, err := os.ReadFile(path)
	if err != nil {
		return featureIndex{}, fmt.Errorf("read %s: %w", path, err)
	}
	index := featureIndex{}
	if err := json.Unmarshal(payload, &index); err != nil {
		return featureIndex{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return index, nil
}

func readRouteInventory(root string) ([]routeRecord, error) {
	path := filepath.Join(root, "backend", "internal", "graph", "server_app_routes.go")
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	routes := []routeRecord{}
	for _, line := range strings.Split(string(payload), "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "mux.HandleFunc(") {
			continue
		}
		inner := strings.TrimPrefix(trimmed, "mux.HandleFunc(")
		parts := splitArguments(inner)
		if len(parts) != 2 {
			continue
		}
		pattern := stringLiteral(parts[0])
		if pattern == "" {
			continue
		}

		method := "GET"
		if found := routeMethodPattern.FindString(strings.SplitN(pattern, " ", 2)[0]); found != "" {
			method = found
		}
		routePath := pattern
		if fields := strings.SplitN(pattern, " ", 2); len(fields) == 2 {
			routePath = strings.TrimSpace(fields[1])
		}
		if strings.TrimSpace(routePath) == "" {
			continue
		}
		routes = append(routes, routeRecord{Method: method, Path: routePath, Handler: handlerName(parts[1])})
	}
	sort.Slice(routes, func(left, right int) bool {
		if routes[left].Path != routes[right].Path {
			return routes[left].Path < routes[right].Path
		}
		return routes[left].Method < routes[right].Method
	})
	return routes, nil
}

func splitArguments(text string) []string {
	depth := 0
	current := strings.Builder{}
	parts := []string{}
	for _, char := range text {
		switch char {
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			if depth == 0 {
				parts = append(parts, strings.TrimSuffix(strings.TrimSpace(current.String()), ")"))
				return parts
			}
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, strings.TrimSpace(current.String()))
				current.Reset()
				continue
			}
		}
		current.WriteRune(char)
	}
	parts = append(parts, strings.TrimSpace(current.String()))
	return parts
}

func stringLiteral(text string) string {
	parts := strings.SplitN(text, "\"", 3)
	if len(parts) < 3 {
		return ""
	}
	return parts[1]
}

func handlerName(text string) string {
	trimmed := strings.TrimSpace(text)
	trimmed = strings.TrimSuffix(trimmed, ")")
	if index := strings.LastIndex(trimmed, "."); index >= 0 {
		trimmed = trimmed[index+1:]
	}
	return strings.TrimSpace(trimmed)
}

func readHandlers(root string) (map[string]handlerRecord, error) {
	directory := filepath.Join(root, "backend", "internal", "graph")
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", directory, err)
	}
	handlers := map[string]handlerRecord{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		fileSet := token.NewFileSet()
		file, parseErr := parser.ParseFile(fileSet, path, nil, 0)
		if parseErr != nil {
			continue
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv == nil || fn.Name == nil {
				continue
			}
			handlers[fn.Name.Name] = handlerRecord{Name: fn.Name.Name, File: entry.Name()}
		}
	}
	return handlers, nil
}

func renderFeatureMap(root string) (string, error) {
	index, err := readFeatureIndex(root)
	if err != nil {
		return "", err
	}
	routes, err := readRouteInventory(root)
	if err != nil {
		return "", err
	}
	handlers, err := readHandlers(root)
	if err != nil {
		return "", err
	}
	rows := make([]featureRow, 0, len(index.Features))
	claimed := map[string]bool{}
	for _, feature := range index.Features {
		row := featureRow{Feature: feature}
		for _, declared := range feature.API {
			matched := []routeRecord{}
			for _, route := range routes {
				if route.Path == declared {
					matched = append(matched, route)
				}
			}
			if len(matched) == 0 {
				row.Missing = append(row.Missing, declared)
				continue
			}
			row.Routes = append(row.Routes, matched...)
			claimed[declared] = true
		}
		row.Tests = append(row.Tests, feature.ExistingTests...)
		for _, test := range feature.ExistingTests {
			if _, statErr := os.Stat(filepath.Join(root, test)); statErr != nil {
				row.Missing = append(row.Missing, test)
			}
		}
		rows = append(rows, row)
	}
	unclaimed := []routeRecord{}
	for _, route := range routes {
		if claimed[route.Path] || !strings.HasPrefix(route.Path, "/api/") {
			continue
		}
		unclaimed = append(unclaimed, route)
	}
	document := renderFeatureMapDocument(rows, unclaimed, handlers, len(routes))
	ci, err := renderCILayers(root)
	if err != nil {
		return "", err
	}
	return document + "\n" + ci, nil
}

func renderFeatureMapDocument(rows []featureRow, unclaimed []routeRecord, handlers map[string]handlerRecord, totalRoutes int) string {
	builder := &strings.Builder{}
	builder.WriteString("# Feature Map\n\n")
	builder.WriteString("<!-- generated by: go -C backend run ./cmd/graphcheck featuremap --write -->\n\n")
	builder.WriteString("The application's feature list: what a user can reach, the entry point that reaches it, and the code behind it.\n\n")
	builder.WriteString("This file is generated from three places and must never be edited by hand: the feature index at\n")
	builder.WriteString("`verification/skills/verify-graph/features/index.json`, the route table in\n")
	builder.WriteString("`backend/internal/graph/server_app_routes.go`, and the handler declarations under\n")
	builder.WriteString("`backend/internal/graph/`. `go -C backend test ./...` fails when the file no longer matches them,\n")
	builder.WriteString("so a feature cannot be added, renamed or dropped without this map moving with it.\n\n")
	builder.WriteString("## Features\n\n")
	builder.WriteString("| id | feature | entry point | API | handler | existing tests | verification command |\n")
	builder.WriteString("| --- | --- | --- | --- | --- | --- | --- |\n")
	for _, row := range rows {
		handlersCell := "—"
		if len(row.Routes) > 0 {
			names := make([]string, 0, len(row.Routes))
			for _, route := range row.Routes {
				name := route.Handler
				if record, known := handlers[route.Handler]; known {
					name = record.Name + " (" + record.File + ")"
				}
				names = append(names, "`"+route.Method+" "+route.Path+"` → "+name)
			}
			handlersCell = strings.Join(names, "<br>")
		}
		testsCell := "—"
		if len(row.Tests) > 0 {
			testsCell = "`" + strings.Join(row.Tests, "`, `") + "`"
		}
		apiCell := "—"
		if len(row.Feature.API) > 0 {
			apiCell = "`" + strings.Join(row.Feature.API, "`, `") + "`"
		}
		commandCell := "—"
		if row.Feature.Command != "" {
			commandCell = "`" + strings.ReplaceAll(row.Feature.Command, "|", "\\|") + "`"
		}
		builder.WriteString(fmt.Sprintf("| [%s] | %s | %s | %s | %s | %s | %s |\n",
			row.Feature.ID, row.Feature.Title, row.Feature.Entry, apiCell, handlersCell, testsCell, commandCell))
	}
	builder.WriteString("\n## Routes no feature claims\n\n")
	if len(unclaimed) == 0 {
		builder.WriteString("Every registered `/api/` route is claimed by a feature.\n")
	} else {
		builder.WriteString("These routes exist in the code and no feature claims them. Either a feature is missing from the\n")
		builder.WriteString("index, or the route is dead and should go.\n\n")
		builder.WriteString("| route | handler |\n| --- | --- |\n")
		for _, route := range unclaimed {
			name := route.Handler
			if record, known := handlers[route.Handler]; known {
				name = record.Name + " (" + record.File + ")"
			}
			builder.WriteString(fmt.Sprintf("| `%s %s` | %s |\n", route.Method, route.Path, name))
		}
	}
	builder.WriteString(fmt.Sprintf("\n## Counts\n\n- %d registered routes\n- %d features in the index\n- %d routes claimed by a feature\n- %d routes unclaimed\n",
		totalRoutes, len(rows), totalRoutes-len(unclaimed), len(unclaimed)))
	return builder.String()
}

func renderCILayers(root string) (string, error) {
	layers, err := gate.CILayers(root)
	if err != nil {
		return "", err
	}
	builder := &strings.Builder{}
	builder.WriteString("## CI layers\n\n")
	builder.WriteString("Read from the workflow files themselves, so a documented job cannot outlive the job.\n\n")
	if len(layers) == 0 {
		builder.WriteString("No workflow declares any job.\n")
		return builder.String(), nil
	}
	builder.WriteString("| workflow | job | label |\n| --- | --- | --- |\n")
	for _, layer := range layers {
		for _, job := range layer.Jobs {
			label := "—"
			if len(job.Lines) > 0 {
				label = job.Lines[0]
			}
			builder.WriteString(fmt.Sprintf("| `%s` | `%s` | %s |\n", layer.Workflow, job.Name, label))
		}
	}
	return builder.String(), nil
}
