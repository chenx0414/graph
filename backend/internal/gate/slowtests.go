package gate

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

const shortSkipAllowancePath = "testdata/slow-test-allowance.json"

type SlowTestAllowance struct {
	Allowed []string `json:"allowed"`
}

// SlowTests are the tests that `go test -short` skips. The fast gate runs with -short,
// the nightly runs without it, and this list is the contract between the two: a test
// that skips under -short must be named here, or the nightly suite silently covers less
// than the fast one claims.
func SlowTests(root string) ([]string, error) {
	found := []string{}
	for _, module := range []string{"backend", "app"} {
		directory := filepath.Join(root, module)
		if _, statErr := os.Stat(directory); statErr != nil {
			continue
		}
		err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				if strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, "_test.go") {
				return nil
			}
			payload, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			if !strings.Contains(string(payload), "testing.Short()") {
				return nil
			}
			fileSet := token.NewFileSet()
			file, parseErr := parser.ParseFile(fileSet, path, payload, 0)
			if parseErr != nil {
				return parseErr
			}
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Recv != nil || !strings.HasPrefix(fn.Name.Name, "Test") {
					continue
				}
				if !bodyMentions(fn, "Short") {
					continue
				}
				relative, relErr := filepath.Rel(root, path)
				if relErr != nil {
					return relErr
				}
				found = append(found, filepath.ToSlash(relative)+"::"+fn.Name.Name)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sortStrings(found)
	return found, nil
}

func bodyMentions(fn *ast.FuncDecl, name string) bool {
	mentions := false
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		selector, ok := node.(*ast.SelectorExpr)
		if !ok || selector.Sel == nil {
			return true
		}
		if selector.Sel.Name == name {
			mentions = true
		}
		return true
	})
	return mentions
}

func ReadSlowTestAllowance(root string) (SlowTestAllowance, error) {
	allowance := SlowTestAllowance{}
	payload, err := os.ReadFile(filepath.Join(root, "backend", "internal", "gate", shortSkipAllowancePath))
	if err != nil {
		return allowance, err
	}
	if err := json.Unmarshal(payload, &allowance); err != nil {
		return allowance, err
	}
	if allowance.Allowed == nil {
		allowance.Allowed = []string{}
	}
	return allowance, nil
}

func WriteSlowTestAllowance(root string, allowed []string) error {
	sorted := append([]string{}, allowed...)
	sortStrings(sorted)
	payload, err := json.MarshalIndent(SlowTestAllowance{Allowed: sorted}, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(root, "backend", "internal", "gate", shortSkipAllowancePath)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(payload, '\n'), 0o644)
}

func SlowTestViolations(found []string, allowance SlowTestAllowance) []string {
	allowed := map[string]bool{}
	for _, item := range allowance.Allowed {
		allowed[item] = true
	}
	present := map[string]bool{}
	problems := []string{}
	for _, item := range found {
		present[item] = true
		if !allowed[item] {
			problems = append(problems, item+": skips under -short but is not in the slow-test list, so the nightly run and the fast run disagree about what is covered")
		}
	}
	for _, item := range allowance.Allowed {
		if !present[item] {
			problems = append(problems, item+": listed as slow but no longer skips under -short; remove it from the list")
		}
	}
	return problems
}
