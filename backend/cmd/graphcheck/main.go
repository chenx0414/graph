package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/chenx0414/graph/backend/internal/gate"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	root, rootErr := repoRoot()
	if rootErr != nil {
		fmt.Fprintf(os.Stderr, "graphcheck: %v\n", rootErr)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "comments":
		os.Exit(runComments(root, os.Args[2:]))
	case "tokens":
		os.Exit(runTokens(root, os.Args[2:]))
	case "ownership":
		os.Exit(runOwnership(root, os.Args[2:]))
	case "api":
		os.Exit(runAPI(root))
	case "machines":
		os.Exit(runMachines(root, os.Args[2:]))
	case "evidence":
		os.Exit(runEvidence(root))
	case "featuremap":
		os.Exit(runFeatureMap(root, os.Args[2:]))
	case "softrules":
		os.Exit(runSoftRules(root, os.Args[2:]))
	case "prose":
		os.Exit(runProse(root, os.Args[2:]))
	case "slowtests":
		os.Exit(runSlowTests(root, os.Args[2:]))
	case "skills":
		os.Exit(runSkills(root, os.Args[2:]))
	case "pig":
		os.Exit(runPig(root, os.Args[2:]))
	case "summary":
		os.Exit(runSummary(os.Args[2:]))
	case "harness":
		os.Exit(runHarness(root, os.Args[2:]))
	case "eval":
		os.Exit(runEval(root, os.Args[2:]))
	case "all":
		os.Exit(runAll(root))
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: graphcheck comments [--changed] | tokens [--changed] [paths...] | ownership [--staged] [paths...] | api | machines [--verbose] | evidence | featuremap [--write] | prose [--record] | softrules [--write] | slowtests [--record] | skills [flags] | pig [flags] | summary [path] | harness [--record] | eval [flags] | all")
}

func repoRoot() (string, error) {
	current, err := os.Getwd()
	if err != nil {
		return "", err
	}
	directory := current
	for {
		if info, statErr := os.Stat(filepath.Join(directory, ".git")); statErr == nil && info.IsDir() {
			return directory, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return current, nil
		}
		directory = parent
	}
}

func git(root string, args ...string) (string, error) {
	command := exec.Command("git", args...)
	command.Dir = root
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return stdout.String(), fmt.Errorf("%v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

func splitNul(output string) []string {
	parts := strings.Split(output, "\x00")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			values = append(values, part)
		}
	}
	return values
}

func runComments(root string, args []string) int {
	changedOnly := hasFlag(args, "--changed")
	problems := []string{}
	files := gate.ScanRepo(root)
	for _, file := range files {
		if file.Explanatory > gate.ExplainBudgetPerFile {
			problems = append(problems, fmt.Sprintf("%s: %d explanatory comments (limit %d)", file.Path, file.Explanatory, gate.ExplainBudgetPerFile))
		}
	}
	if changedOnly {
		for _, path := range changedSourceFiles(root) {
			before := headContent(root, path)
			payload, err := os.ReadFile(filepath.Join(root, path))
			if err != nil {
				continue
			}
			if gate.CompareExplanatory(before, string(payload), langOf(path)) {
				problems = append(problems, fmt.Sprintf("%s: this change adds explanatory comments (%d -> %d)", path,
					gate.ScanComments(before, langOf(path)).Explanatory, gate.ScanComments(string(payload), langOf(path)).Explanatory))
			}
		}
	} else {
		total := 0
		for _, file := range files {
			total += file.Explanatory
		}
		if total > gate.TotalBudget {
			problems = append(problems, fmt.Sprintf("repository: %d explanatory comments (limit %d)", total, gate.TotalBudget))
		}
	}
	if len(problems) > 0 {
		for _, problem := range problems {
			fmt.Fprintf(os.Stderr, "comment budget: %s\n", problem)
		}
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "A comment counts as explanatory unless the tooling can act on it.")
		fmt.Fprintln(os.Stderr, "  1. Delete it: the name, the type and the test already say what the code does.")
		fmt.Fprintln(os.Stderr, "  2. Or turn it into a machine directive, which this gate accepts:")
		fmt.Fprintln(os.Stderr, "     // graph:   //go:   // @ts-   // eslint   // nolint   // prettier   /// <reference")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintf(os.Stderr, "Limits: %d explanatory comments per file, %d in the whole repository.\n", gate.ExplainBudgetPerFile, gate.TotalBudget)
		fmt.Fprintln(os.Stderr, "A change may only remove them: --changed fails when the count goes up.")
		fmt.Fprintln(os.Stderr, "Recheck with:  go -C backend run ./cmd/graphcheck comments --changed")
		return 1
	}
	suffix := ""
	if changedOnly {
		suffix = " (changed files)"
	}
	fmt.Printf("comment budget: ok%s\n", suffix)
	return 0
}

func langOf(path string) string {
	if strings.HasSuffix(path, ".go") {
		return "go"
	}
	return "ts"
}

func changedSourceFiles(root string) []string {
	output, err := git(root, "diff", "--name-only", "HEAD", "--", "backend", "src")
	if err != nil {
		return nil
	}
	paths := []string{}
	for _, line := range strings.Split(output, "\n") {
		path := strings.TrimSpace(line)
		if path == "" || strings.HasSuffix(path, "_test.go") {
			continue
		}
		if !strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, ".ts") && !strings.HasSuffix(path, ".tsx") {
			continue
		}
		paths = append(paths, path)
	}
	return paths
}

func headContent(root, path string) string {
	output, err := git(root, "show", "HEAD:"+path)
	if err != nil {
		return ""
	}
	return output
}

func hasFlag(args []string, flag string) bool {
	for _, argument := range args {
		if argument == flag {
			return true
		}
	}
	return false
}

func runTokens(root string, args []string) int {
	limit, err := gate.TokenLimit(os.Getenv("GRAPH_FILE_TOKEN_LIMIT"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "check-file-tokens: %v\n", err)
		return 2
	}
	changed := hasFlag(args, "--changed")
	named := []string{}
	for _, argument := range args {
		if !strings.HasPrefix(argument, "--") {
			named = append(named, argument)
		}
	}
	var records []gate.FileRecord
	scope := "staged"
	switch {
	case changed:
		scope = "changed"
		for _, path := range changedPaths(root) {
			if record, ok := gate.ReadFileRecord(root, path); ok {
				records = append(records, record)
			}
		}
	case len(named) > 0:
		scope = "named"
		for _, path := range named {
			if record, ok := gate.ReadFileRecord(root, path); ok {
				records = append(records, record)
			}
		}
	default:
		records = stagedRecords(root)
	}
	findings := gate.CheckTokens(records, limit)
	if len(findings.Violations) > 0 {
		reportTokens(findings, limit)
		return 1
	}
	message := fmt.Sprintf("file budget: %d %s file(s) within the %s-token budget", len(records), scope, withThousands(limit))
	if len(findings.Skipped) > 0 {
		message += fmt.Sprintf(", %d skipped as not agent-authored", len(findings.Skipped))
	}
	fmt.Println(message + ".")
	return 0
}

func changedPaths(root string) []string {
	seen := map[string]bool{}
	paths := []string{}
	for _, args := range [][]string{
		{"diff", "--name-only", "-z", "HEAD"},
		{"ls-files", "--others", "--exclude-standard", "-z"},
	} {
		output, err := git(root, args...)
		if err != nil {
			continue
		}
		for _, path := range splitNul(output) {
			if !seen[path] {
				seen[path] = true
				paths = append(paths, path)
			}
		}
	}
	return paths
}

func stagedRecords(root string) []gate.FileRecord {
	changed, err := git(root, "diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z")
	if err != nil {
		return nil
	}
	index := map[string]struct {
		mode string
		sha  string
	}{}
	listing, listErr := git(root, "ls-files", "-s", "-z")
	if listErr == nil {
		for _, record := range splitNul(listing) {
			tab := strings.Index(record, "\t")
			if tab < 0 {
				continue
			}
			fields := strings.Split(record[:tab], " ")
			if len(fields) < 2 {
				continue
			}
			index[record[tab+1:]] = struct {
				mode string
				sha  string
			}{mode: fields[0], sha: fields[1]}
		}
	}
	records := []gate.FileRecord{}
	for _, path := range splitNul(changed) {
		entry, ok := index[path]
		if !ok || entry.mode == "160000" || entry.mode == "120000" {
			continue
		}
		size, sizeErr := git(root, "cat-file", "-s", entry.sha)
		if sizeErr != nil {
			continue
		}
		bytes, convErr := strconv.ParseInt(strings.TrimSpace(size), 10, 64)
		if convErr != nil {
			continue
		}
		head, headErr := git(root, "cat-file", "blob", entry.sha)
		if headErr != nil {
			continue
		}
		records = append(records, gate.FileRecord{Path: path, Bytes: bytes, Head: []byte(head)})
	}
	return records
}

func reportTokens(findings gate.TokenFindings, limit int) {
	fmt.Fprintf(os.Stderr, "%d file(s) exceed the %s-token file budget (bytes / %d).\n\n", len(findings.Violations), withThousands(limit), gate.BytesPerToken)
	for _, record := range findings.Violations {
		fmt.Fprintf(os.Stderr, "  %s\n", record.Path)
		fmt.Fprintf(os.Stderr, "    %s bytes ≈ %s tokens (limit %s)\n\n", withThousands64(record.Bytes), withThousands(gate.TokenTotal(record)), withThousands(limit))
	}
	fmt.Fprintln(os.Stderr, "Split these files before committing:")
	fmt.Fprintln(os.Stderr, "  1. Give each file one responsibility and move the rest into new files")
	fmt.Fprintln(os.Stderr, "     beside it - same directory, same language. For a document, split by")
	fmt.Fprintln(os.Stderr, "     topic instead of by length.")
	fmt.Fprintln(os.Stderr, "  2. Keep the interface of the file you shrink stable, so callers do not")
	fmt.Fprintln(os.Stderr, "     change. Move the code out first, rewrite it afterwards.")
	fmt.Fprintln(os.Stderr, "  3. Fix the imports on both sides, then commit again.")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "  Check the split with:  go -C backend run ./cmd/graphcheck tokens")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "If a file genuinely cannot be split, state why at the top of that file:")
	fmt.Fprintln(os.Stderr, "  graph:allow-large-file: <reason>")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "The limit is a default: GRAPH_FILE_TOKEN_LIMIT overrides it for one run.")
	fmt.Fprintln(os.Stderr, "Generated code, vendored trees, lock files and binaries are skipped.")
	if len(findings.Skipped) > 0 {
		fmt.Fprintf(os.Stderr, "Skipped as not agent-authored: %d file(s)\n", len(findings.Skipped))
		shown := 0
		for _, entry := range findings.Skipped {
			if shown == 8 {
				break
			}
			fmt.Fprintf(os.Stderr, "  %s (%s)\n", entry.Path, entry.Reason)
			shown++
		}
		fmt.Fprintln(os.Stderr, "")
	}
}

func runOwnership(root string, args []string) int {
	staged := hasFlag(args, "--staged")
	given := []string{}
	for _, argument := range args {
		if !strings.HasPrefix(argument, "--") {
			given = append(given, argument)
		}
	}
	pkg := filepath.Join(root, "backend", "internal", "graph")
	offenders := []gate.TableOffender{}
	if staged {
		offenders = stagedTableWrites(root, pkg)
	} else {
		files := []string{}
		for _, path := range given {
			files = append(files, filepath.Join(root, path))
		}
		offenders = gate.PackageWrites(pkg, files)
	}
	if len(offenders) == 0 {
		return reportTableOwnership(root, offenders, staged, given)
	}
	return reportTableOwnership(root, offenders, staged, given)
}

func reportTableOwnership(root string, offenders []gate.TableOffender, staged bool, given []string) int {
	if len(offenders) == 0 {
		scope := "the package"
		if staged {
			scope = "the staged change"
		} else if len(given) > 0 {
			scope = fmt.Sprintf("%d file(s)", len(given))
		}
		fmt.Printf("table ownership: %s writes no owned table outside its owner\n", scope)
		return 0
	}
	tables := map[string]bool{}
	fmt.Fprintln(os.Stderr, "An owned table has more than one writer.")
	fmt.Fprintln(os.Stderr, "Its owner - a store, or the module it belongs to - is the only one that writes it.")
	fmt.Fprintln(os.Stderr, "")
	for _, offender := range offenders {
		tables[offender.Table] = true
		relative, err := filepath.Rel(root, offender.File)
		if err != nil {
			relative = offender.File
		}
		fmt.Fprintf(os.Stderr, "  %s: writes %s\n", filepath.ToSlash(relative), offender.Table)
		if owner := gate.OwnerOfTable(offender.Table); owner != "" {
			fmt.Fprintf(os.Stderr, "    owner: %s\n", owner)
		}
	}
	names := make([]string, 0, len(tables))
	for table := range tables {
		names = append(names, table)
	}
	sort.Strings(names)
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintf(os.Stderr, "Tables written outside their owner: %s\n", strings.Join(names, ", "))
	fmt.Fprintln(os.Stderr, "Move the write into the owner's method and call that.")
	fmt.Fprintln(os.Stderr, "A table the schema declares and nobody owns yet needs an owner named in this file.")
	fmt.Fprintln(os.Stderr, "A migration, or an operation that spans many tables at once, says so at the top:")
	fmt.Fprintf(os.Stderr, "  // %s <reason>\n", gate.TableWritesExempt)
	return 1
}

func stagedTableWrites(root, pkg string) []gate.TableOffender {
	output, err := git(root, "diff", "--cached", "-U0")
	if err != nil {
		return nil
	}
	declared := gate.SchemaTables(pkg)
	offenders := []gate.TableOffender{}
	exempt := map[string]bool{}
	file := ""
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, "+++ b/") {
			file = strings.TrimPrefix(line, "+++ b/")
			continue
		}
		if !strings.HasPrefix(line, "+") || strings.HasPrefix(line, "+++") || file == "" {
			continue
		}
		text := strings.TrimPrefix(line, "+")
		if !strings.Contains(strings.ToUpper(text), "INSERT") && !strings.Contains(strings.ToUpper(text), "UPDATE") && !strings.Contains(strings.ToUpper(text), "DELETE") {
			continue
		}
		full := filepath.Join(root, file)
		if exempt[full] {
			continue
		}
		for _, write := range gate.WritesIn(text) {
			if gate.OwnsIt(filepath.Base(full), write.Table, declared) {
				continue
			}
			payload, readErr := os.ReadFile(full)
			if readErr == nil && strings.Contains(string(payload), gate.TableWritesExempt) {
				exempt[full] = true
				continue
			}
			offenders = append(offenders, gate.TableOffender{File: full, Table: write.Table, Line: write.Line})
		}
	}
	return offenders
}

func withThousands(value int) string {
	return withThousands64(int64(value))
}

func withThousands64(value int64) string {
	digits := strconv.FormatInt(value, 10)
	if len(digits) <= 3 {
		return digits
	}
	var builder strings.Builder
	lead := len(digits) % 3
	if lead > 0 {
		builder.WriteString(digits[:lead])
	}
	for index := lead; index < len(digits); index += 3 {
		if builder.Len() > 0 {
			builder.WriteString(",")
		}
		builder.WriteString(digits[index : index+3])
	}
	return builder.String()
}
