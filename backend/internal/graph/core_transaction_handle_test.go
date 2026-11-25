// graph:table-writes-exempt: the test reads the package source and writes no table
package graph

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// A transaction owns one connection, so its body may write only through the handle it was given.
// The gates check that at build time, and the capture rule is what carries the call graph.
var transactionCallbackPattern = regexp.MustCompile(`\.(Transaction|Command)\(`)

var functionPattern = regexp.MustCompile(`(?m)^func (?:\(([A-Za-z_][A-Za-z0-9_]*) (\*?)([A-Za-z_][A-Za-z0-9_]*)\) )?([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)[^{]*\{`)

var poolHandleUse = regexp.MustCompile(`\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.(Db|DB|store)\b`)

var bareStoreUse = regexp.MustCompile(`\bstore\.([A-Za-z_][A-Za-z0-9_]*)`)

var rebindPattern = regexp.MustCompile(`\b([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(?:[A-Za-z_][A-Za-z0-9_.]*\.)?scoped\(tx\)|([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*tx\b`)

var holderFieldPattern = regexp.MustCompile(`(?m)^\t(?:[Ss]tore\s+\*TaskStore|kernel\s+\*KernelStore)\b`)

var typePattern = regexp.MustCompile(`(?m)^type ([A-Za-z_][A-Za-z0-9_]*) struct \{`)

var holderFieldReach = regexp.MustCompile(`\b([A-Za-z_]\w*)\.(?:kernel|store|Store)\.`)

var localHolderPattern = regexp.MustCompile(`(?m)^[ \t]+([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*&?([A-Za-z_][A-Za-z0-9_]*)\{`)

var declaredHolderPattern = regexp.MustCompile(`(?m)^[ \t]+var ([A-Za-z_][A-Za-z0-9_]*)\s+\*([A-Za-z_][A-Za-z0-9_]*)`)

var scopedMethodPattern = regexp.MustCompile(`(?m)^func \([A-Za-z_][A-Za-z0-9_]* \*([A-Za-z_][A-Za-z0-9_]*)\) scoped\(([^)]*)\)`)

type handleGate struct {
	holders    map[string]bool
	rebindable map[string]bool
}

func TestEveryTransactionCallbackWritesThroughItsOwnHandle(t *testing.T) {
	gate := newHandleGate(packageSources(t))
	offenders := []string{}
	for _, source := range packageSources(t) {
		for _, complaint := range gate.check(source.text) {
			offenders = append(offenders, source.name+":"+itoa(complaint.line)+": "+complaint.reason)
		}
	}
	sort.Strings(offenders)
	if len(offenders) > 0 {
		t.Fatalf("%d transaction callback statements bypass the handle the transaction owns:\n  %s",
			len(offenders), strings.Join(offenders, "\n  "))
	}
}

func TestEveryHolderCapturedByATransactionCanBeRebound(t *testing.T) {
	gate := newHandleGate(packageSources(t))
	offenders := []string{}
	for _, source := range packageSources(t) {
		for _, complaint := range gate.check(source.text) {
			if strings.Contains(complaint.reason, "cannot be rebound onto a transaction") {
				offenders = append(offenders, source.name+":"+itoa(complaint.line)+": "+complaint.reason)
			}
		}
	}
	sort.Strings(offenders)
	if len(offenders) > 0 {
		t.Fatalf("%d holder types a transaction body captures cannot be rebound onto its store:\n  %s",
			len(offenders), strings.Join(offenders, "\n  "))
	}
}

func TestTransactionHandleGateRejectsEachBypass(t *testing.T) {
	cases := []struct {
		name, source, want string
		extra              []packageSource
	}{
		{
			name:   "callback without the transaction's store",
			source: "func (s *Server) run() {\n\ts.store.Transaction(\"scope\", \"id\", nil, func(store *TaskStore) any { return nil })\n}",
			want:   "does not receive the transaction's store",
		},
		{
			name:   "body writing through the enclosing holder",
			source: "func (s *Server) run() {\n\ts.store.Transaction(\"scope\", \"id\", nil, func(tx *TaskStore) any { _, err := s.store.Db.Exec(\"x\"); return err })\n}",
			want:   "reaches s.store.Db without rebinding it onto tx",
		},
		{
			name:   "body writing through a bare store parameter",
			source: "func (s *Server) run(store *TaskStore) {\n\tstore.Transaction(\"scope\", \"id\", nil, func(tx *TaskStore) any { _, err := store.Db.Exec(\"x\"); return err })\n}",
			want:   "reaches store.Db without rebinding it onto tx",
		},
		{
			name:   "body capturing a holder it never rebinds",
			source: "func (s *Server) run(store *TaskStore, runtime *TaskRuntime) {\n\tstore.Transaction(\"scope\", \"id\", nil, func(tx *TaskStore) any { return runtime.list() })\n}",
			want:   "captures the enclosing runtime instead of its own tx",
			extra:  []packageSource{{name: "holder.go", text: holderWithScoped}},
		},
		{
			name:   "captured holder with no scoped method",
			source: "func (s *Server) run(store *TaskStore, runtime *TaskRuntime) {\n\tstore.Transaction(\"scope\", \"id\", nil, func(tx *TaskStore) any { return runtime.list() })\n}",
			want:   "TaskRuntime cannot be rebound onto a transaction",
			extra:  []packageSource{{name: "holder.go", text: holderWithoutScoped}},
		},
		{
			name:   "rebound holder is accepted",
			source: "func (s *Server) run(store *TaskStore, runtime *TaskRuntime) {\n\tstore.Transaction(\"scope\", \"id\", nil, func(tx *TaskStore) any {\n\t\truntime := runtime.scoped(tx)\n\t\treturn runtime.list()\n\t})\n}",
			want:   "",
			extra:  []packageSource{{name: "holder.go", text: holderWithScoped}},
		},
		{
			name:   "exec.Command is not a transaction",
			source: "func run() {\n\tout, err := exec.Command(\"echo\", \"hi\").Output()\n\t_, _ = out, err\n}",
			want:   "",
		},
		{
			name:   "a holder name inside a SQL string is not a capture",
			source: "func (integration *GitIntegration) run() {\n\tintegration.store.Transaction(func(tx *TaskStore) any {\n\t\tgraphDBExec(tx.Db, \"INSERT INTO git_commits VALUES(?,?,?,?,?)\", \"integration\")\n\t\treturn nil\n\t})\n}",
			want:   "",
		},
		{
			name:   "a wrapper that forwards the store it was given is accepted",
			source: "func (k *KernelStore) run(action func(*TaskStore) any) any {\n\tif k.Store.IsTransaction() {\n\t\treturn action(k.Store)\n\t}\n\treturn k.Store.Transaction(action)\n}",
			want:   "",
		},
		{
			name:   "a callback value that is not the transaction's store is rejected",
			source: "func (k *KernelStore) run(apply func() any) any {\n\treturn k.Store.Transaction(apply)\n}",
			want:   "callback is a value",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gate := newHandleGate(append([]packageSource{{name: "fixture.go", text: tc.source}}, tc.extra...))
			joined := []string{}
			for _, complaint := range gate.check(tc.source) {
				joined = append(joined, complaint.reason)
			}
			got := strings.Join(joined, "\n")
			if tc.want == "" {
				if got != "" {
					t.Fatalf("the gate rejected a shape it must accept:\n%s", got)
				}
				return
			}
			if !strings.Contains(got, tc.want) {
				t.Fatalf("the gate missed %q, it reported:\n%s", tc.want, got)
			}
		})
	}
}

type packageSource struct{ name, text string }

const holderWithScoped = "type TaskRuntime struct {\n\tstore *TaskStore\n}\n\nfunc (r *TaskRuntime) scoped(tx *TaskStore) *TaskRuntime {\n\treturn r\n}\n"

const holderWithoutScoped = "type TaskRuntime struct {\n\tstore *TaskStore\n}\n"

type callbackComplaint struct {
	line   int
	reason string
}

func packageSources(t *testing.T) []packageSource {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package: %v", err)
	}
	sources := []packageSource{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(".", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		sources = append(sources, packageSource{name: name, text: string(raw)})
	}
	return sources
}

func newHandleGate(sources []packageSource) handleGate {
	gate := handleGate{holders: map[string]bool{"TaskStore": true}, rebindable: map[string]bool{"TaskStore": true}}
	for _, source := range sources {
		for _, match := range typePattern.FindAllStringSubmatchIndex(source.text, -1) {
			if holderFieldPattern.MatchString(balancedBody(source.text, match[1]-1)) {
				gate.holders[source.text[match[2]:match[3]]] = true
			}
		}
		for _, match := range scopedMethodPattern.FindAllStringSubmatch(source.text, -1) {
			if strings.Contains(match[2], "TaskStore") || strings.Contains(match[2], "sqlh") {
				gate.rebindable[match[1]] = true
			}
		}
	}
	return gate
}

func (gate handleGate) check(text string) []callbackComplaint {
	complaints := []callbackComplaint{}
	for _, fn := range functionPattern.FindAllStringSubmatchIndex(text, -1) {
		open := fn[1] - 1
		body := balancedBody(text, open)
		captured := gate.capturedHolders(fn, text, body)
		for _, call := range transactionCallbackPattern.FindAllStringSubmatchIndex(body, -1) {
			kind := body[call[2]:call[3]]
			argsAt := call[1]
			args := callArguments(body, argsAt)
			line := 1 + strings.Count(text[:open]+body[:call[0]], "\n")
			if args == "" {
				if !passedThrough(callArgsOnly(body, argsAt), functionParams(text, fn)) && (kind == "Transaction" || !strings.HasSuffix(body[:call[0]], "exec")) {
					complaints = append(complaints, callbackComplaint{line, kind + " callback is a value, so the transaction cannot hand it the store it owns"})
				}
				continue
			}
			start := argsAt + strings.Index(args, "func")
			brace := start + strings.Index(body[start:argsAt+len(args)], "{")
			if brace < start {
				continue
			}
			params := body[start:brace]
			cb := balancedBody(body, brace)
			code := codeOnly(cb)
			rebound := reboundNames(code)
			blocked := map[string]bool{}
			seenReach := map[string]bool{}
			if !strings.Contains(params, "tx *TaskStore") {
				complaints = append(complaints, callbackComplaint{line, kind + " callback does not receive the transaction's store (tx *TaskStore)"})
			} else {
				complaints = append(complaints, handleComplaints(code, kind, line, rebound)...)
			}
			for _, reach := range holderFieldReach.FindAllStringSubmatch(code, -1) {
				root := reach[1]
				if _, held := captured[root]; root == "tx" || rebound[root] || !held {
					continue
				}
				if seenReach[reach[0]] {
					continue
				}
				seenReach[reach[0]] = true
				complaints = append(complaints, callbackComplaint{line, kind + " body reaches " + reach[0] + " without rebinding " + root + " onto tx"})
			}
			for name, kindOf := range captured {
				if !regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\b`).MatchString(usesOnly(code, name)) {
					continue
				}
				if !gate.rebindable[kindOf] && !blocked[kindOf] {
					blocked[kindOf] = true
					complaints = append(complaints, callbackComplaint{line, kindOf + " cannot be rebound onto a transaction: it has no scoped method taking the transaction's store"})
				}
				if rebound[name] {
					continue
				}
				complaints = append(complaints, callbackComplaint{line, kind + " body captures the enclosing " + name + " instead of its own tx"})
			}
		}
	}
	return complaints
}

func handleComplaints(cb, kind string, line int, rebound map[string]bool) []callbackComplaint {
	complaints := []callbackComplaint{}
	seen := map[string]bool{}
	covered := []int{}
	for _, use := range poolHandleUse.FindAllStringSubmatchIndex(cb, -1) {
		chain := cb[use[2]:use[3]]
		root := chain
		if dot := strings.Index(chain, "."); dot >= 0 {
			root = chain[:dot]
		}
		covered = append(covered, use[0], use[1])
		if root == "tx" || rebound[root] {
			continue
		}
		reach := chain + "." + cb[use[4]:use[5]]
		if seen[reach] {
			continue
		}
		seen[reach] = true
		complaints = append(complaints, callbackComplaint{line, kind + " body reaches " + reach + " without rebinding it onto tx"})
	}
	for _, use := range bareStoreUse.FindAllStringSubmatchIndex(cb, -1) {
		if coveredBy(covered, use[0]) || rebound["store"] {
			continue
		}
		reach := "store." + cb[use[2]:use[3]]
		if seen[reach] {
			continue
		}
		seen[reach] = true
		complaints = append(complaints, callbackComplaint{line, kind + " body reaches " + reach + " without rebinding it onto tx"})
	}
	return complaints
}

func (gate handleGate) capturedHolders(fn []int, text, body string) map[string]string {
	names := map[string]string{}
	if fn[2] >= 0 && gate.holders[text[fn[6]:fn[7]]] {
		names[text[fn[2]:fn[3]]] = text[fn[6]:fn[7]]
	}
	for _, param := range strings.Split(functionParams(text, fn), ",") {
		fields := strings.Fields(param)
		if len(fields) == 2 && gate.holders[strings.TrimPrefix(fields[1], "*")] {
			names[fields[0]] = strings.TrimPrefix(fields[1], "*")
		}
	}
	for _, match := range localHolderPattern.FindAllStringSubmatch(body, -1) {
		if gate.holders[match[2]] {
			names[match[1]] = match[2]
		}
	}
	for _, match := range declaredHolderPattern.FindAllStringSubmatch(body, -1) {
		if gate.holders[match[2]] {
			names[match[1]] = match[2]
		}
	}
	return names
}

func functionParams(text string, fn []int) string {
	open := fn[9]
	if open < 0 || open >= len(text) || text[open] != '(' {
		return ""
	}
	depth := 0
	for i := open; i < len(text); i++ {
		switch text[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return text[open+1 : i]
			}
		}
	}
	return ""
}

func callArgsOnly(body string, afterOpen int) string {
	depth := 1
	for i := afterOpen; i < len(body); i++ {
		switch body[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return body[afterOpen:i]
			}
		}
	}
	return ""
}

func passedThrough(args, params string) bool {
	declared := map[string]bool{}
	for _, param := range strings.Split(params, ",") {
		fields := strings.Fields(strings.ReplaceAll(param, "func(*TaskStore) any", "func(*TaskStore)any"))
		if len(fields) == 2 && fields[1] == "func(*TaskStore)any" {
			declared[fields[0]] = true
		}
	}
	for _, arg := range strings.Split(args, ",") {
		if declared[strings.TrimSpace(arg)] {
			return true
		}
	}
	return false
}

func callArguments(body string, afterOpen int) string {
	depth := 1
	for i := afterOpen; i < len(body); i++ {
		switch body[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				args := body[afterOpen:i]
				if !strings.Contains(args, "func") {
					return ""
				}
				return args
			}
		}
	}
	return ""
}

func codeOnly(body string) string {
	cleaned := []byte(body)
	for i := 0; i < len(cleaned); i++ {
		switch cleaned[i] {
		case '"':
			for i++; i < len(cleaned) && cleaned[i] != '"'; i++ {
				if cleaned[i] == '\\' {
					cleaned[i] = ' '
					i++
				}
				if cleaned[i] != '\n' {
					cleaned[i] = ' '
				}
			}
		case '`':
			for i++; i < len(cleaned) && cleaned[i] != '`'; i++ {
				if cleaned[i] != '\n' {
					cleaned[i] = ' '
				}
			}
		case '\'':
			for i++; i < len(cleaned) && cleaned[i] != '\''; i++ {
				if cleaned[i] == '\\' {
					cleaned[i] = ' '
					i++
				}
				cleaned[i] = ' '
			}
		case '/':
			if i+1 < len(cleaned) && cleaned[i+1] == '/' {
				for ; i < len(cleaned) && cleaned[i] != '\n'; i++ {
					cleaned[i] = ' '
				}
			}
		}
	}
	return string(cleaned)
}

func usesOnly(body, name string) string {
	kept := []string{}
	for _, line := range strings.Split(body, "\n") {
		if strings.Contains(line, ".scoped(tx)") || regexp.MustCompile(`:=\s*tx\b`).MatchString(line) {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func reboundNames(body string) map[string]bool {
	names := map[string]bool{}
	for _, match := range rebindPattern.FindAllStringSubmatch(body, -1) {
		name := match[1]
		if name == "" {
			name = match[2]
		}
		names[name] = true
	}
	return names
}

func coveredBy(covered []int, at int) bool {
	for i := 0; i+1 < len(covered); i += 2 {
		if at >= covered[i] && at < covered[i+1] {
			return true
		}
	}
	return false
}

func balancedBody(text string, open int) string {
	depth := 0
	for i := open; i < len(text); i++ {
		switch text[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return text[open : i+1]
			}
		}
	}
	return text[open:]
}
