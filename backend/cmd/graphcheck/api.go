package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func runAPI(root string) int {
	problems, err := scanAPIPosts(filepath.Join(root, "app"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "api request ids: %v\n", err)
		return 1
	}
	if len(problems) > 0 {
		for _, problem := range problems {
			fmt.Fprintf(os.Stderr, "api request ids: %s\n", problem)
		}
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "A lifecycle POST reloads or rewrites a project thread, so a retry must not run it twice.")
		fmt.Fprintln(os.Stderr, "Put a stable requestId in the JSON body so the server can replay the same call with one receipt:")
		fmt.Fprintln(os.Stderr, `  api.post("/api/projects/p1/archive", map[string]any{"requestId": id})`)
		return 1
	}
	fmt.Println("api request ids: ok")
	return 0
}

func scanAPIPosts(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	problems := []string{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		path := filepath.Join(dir, name)
		fileSet := token.NewFileSet()
		file, err := parser.ParseFile(fileSet, path, nil, 0)
		if err != nil {
			return nil, err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			fn, ok := node.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				return true
			}
			scanAPIFunc(fileSet, path, fn.Body, &problems)
			return false
		})
	}
	sort.Strings(problems)
	return problems, nil
}

func scanAPIFunc(fileSet *token.FileSet, path string, body *ast.BlockStmt, problems *[]string) {
	ast.Inspect(body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "post" {
			return true
		}
		receiver := expressionText(fileSet, selector.X)
		if receiver != "api" && !strings.HasSuffix(receiver, ".api") {
			return true
		}
		if len(call.Args) == 0 {
			return true
		}
		requestPath := expressionText(fileSet, call.Args[0])
		lifecycle := strings.Contains(requestPath, "/archive") || strings.Contains(requestPath, "/restore")
		if !strings.Contains(requestPath, "/api/projects/") || !lifecycle {
			return true
		}
		line := fileSet.Position(call.Pos()).Line
		if len(call.Args) < 2 || !requestBodyHasRequestID(fileSet, body, call.Args[1]) {
			*problems = append(*problems, fmt.Sprintf("%s:%d: POST %s must carry requestId in its body", path, line, requestPath))
		}
		return true
	})
}

func requestBodyHasRequestID(fileSet *token.FileSet, body *ast.BlockStmt, expression ast.Expr) bool {
	if strings.Contains(expressionText(fileSet, expression), "requestId") {
		return true
	}
	ident, ok := expression.(*ast.Ident)
	if !ok {
		return false
	}
	found := false
	ast.Inspect(body, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.AssignStmt:
			for index, left := range typed.Lhs {
				if name, ok := left.(*ast.Ident); ok && name.Name == ident.Name && index < len(typed.Rhs) {
					if strings.Contains(expressionText(fileSet, typed.Rhs[index]), "requestId") {
						found = true
					}
				}
			}
		case *ast.ValueSpec:
			for index, name := range typed.Names {
				if name.Name == ident.Name && index < len(typed.Values) {
					if strings.Contains(expressionText(fileSet, typed.Values[index]), "requestId") {
						found = true
					}
				}
			}
		}
		return !found
	})
	return found
}

func expressionText(fileSet *token.FileSet, expression ast.Expr) string {
	var builder strings.Builder
	if err := printer.Fprint(&builder, fileSet, expression); err != nil {
		return ""
	}
	return builder.String()
}
