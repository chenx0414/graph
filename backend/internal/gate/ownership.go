package gate

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const TableWritesExempt = "graph:table-writes-exempt:"

var ownedTables = map[string]string{
	"tasks":                          "core_task_lifecycle.go",
	"project_archive_pauses":         "core_task_lifecycle.go",
	"graph_preparation_pauses":       "core_task_lifecycle.go",
	"questions":                      "core_task_questions.go",
	"node_questions":                 "core_node_questions.go",
	"invocations":                    "core_task_invocations.go",
	"nodes":                          "core_task_nodes.go",
	"activations":                    "core_task_activations.go",
	"instances":                      "core_task_instances.go",
	"operations":                     "core_task_operations.go",
	"conversations":                  "core_task_conversations.go",
	"work_requests":                  "core_task_work_requests.go",
	"work_request_revisions":         "core_task_work_requests.go",
	"work_graphs":                    "core_task_work_graphs.go",
	"work_drafts":                    "core_task_work_drafts.go",
	"proposals":                      "core_task_proposals.go",
	"messages":                       "core_task_messages.go",
	"budget_scopes":                  "core_budget_ledger.go",
	"wake_intents":                   "core_wake_ledger.go",
	"rsi_continuations":              "core_rsi_continuation.go",
	"pause_continuations":            "core_pause_continuation.go",
	"tool_calls":                     "core_store_tool_calls.go",
	"tool_call_spools":               "core_store_tool_calls.go",
	"agent_context_bindings":         "core_context.go",
	"git_commits":                    "git_integration_commit.go",
	"git_ops":                        "core_git_operations.go",
	"worktrees":                      "core_git_operations.go",
	"runtime":                        "core_task_runtime_state.go",
	"projects":                       "core_task_projects.go",
	"artifacts":                      "core_artifact_rows.go",
	"artifact_links":                 "core_artifact_rows.go",
	"context_handoffs":               "core_context.go",
	"commands":                       "core_store_events.go",
	"task_grants":                    "core_task_grants.go",
	"artifact_events":                "core_artifact_storage.go",
	"context_resolutions":            "core_context.go",
	"conversation_acceptances":       "core_task_runtime_conversation_confirm.go",
	"conversation_streams":           "core_conversation_activity.go",
	"definitions":                    "catalog_catalog.go",
	"events":                         "core_store_events.go",
	"models":                         "core_task_runtime_open.go",
	"node_capabilities":              "core_node_capabilities.go",
	"node_entries":                   "core_node_entries.go",
	"node_sessions":                  "core_node_capabilities.go",
	"node_write_captures":            "core_write_ledger.go",
	"presets":                        "catalog_catalog.go",
	"project_preparation":            "git_integration_prepare.go",
	"kernel_acceptance_limitations":  "core_kernel_acceptance_limitations.go",
	"deferred_tool_calls":            "core_deferred_tool_calls.go",
	"agents":                         "core_agent_registry.go",
}

var schemaFiles = []string{
	"core_store_schema_base.go",
	"core_store_schema.go",
	"core_store_schema_deferred_calls.go",
	"core_store_migrate.go",
}

var schemaTablePattern = regexp.MustCompile(`(?i)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)\s*\(`)

var kernelOwnerPattern = regexp.MustCompile(`^core_kernel_`)

var writePattern = regexp.MustCompile("(?i)(?:" + `INSERT(?:\s+OR\s+\w+)?\s+INTO` + "|" + `UPDATE` + "|" + `DELETE\s+FROM` + "|" + `REPLACE\s+INTO` + ")" + `\s+[` + "`" + `"']?([a-z_]+)`)

var goBlockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)

type TableWrite struct {
	Table string
	Line  int
}

type TableOffender struct {
	File  string
	Table string
	Line  int
}

func SchemaTables(pkgDir string) map[string]bool {
	tables := map[string]bool{}
	for _, name := range schemaFiles {
		payload, err := os.ReadFile(filepath.Join(pkgDir, name))
		if err != nil {
			continue
		}
		for _, match := range schemaTablePattern.FindAllStringSubmatch(string(payload), -1) {
			tables[match[1]] = true
		}
	}
	return tables
}

func WithoutComments(source string) string {
	lines := strings.Split(source, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimLeft(line, " \t"), "//") {
			continue
		}
		kept = append(kept, line)
	}
	return goBlockComment.ReplaceAllString(strings.Join(kept, "\n"), "")
}

func WritesIn(source string) []TableWrite {
	found := []TableWrite{}
	for index, line := range strings.Split(WithoutComments(source), "\n") {
		for _, match := range writePattern.FindAllStringSubmatch(line, -1) {
			table := match[1]
			if _, owned := ownedTables[table]; owned || strings.HasPrefix(table, "kernel_") {
				found = append(found, TableWrite{Table: table, Line: index + 1})
			}
		}
	}
	return found
}

func OwnsIt(file, table string, declared map[string]bool) bool {
	if owner, named := ownedTables[table]; named {
		return owner == file
	}
	if strings.HasPrefix(table, "kernel_") {
		return kernelOwnerPattern.MatchString(file)
	}
	return !declared[table]
}

func PackageWrites(pkgDir string, files []string) []TableOffender {
	declared := SchemaTables(pkgDir)
	offenders := []TableOffender{}
	if len(files) == 0 {
		entries, err := os.ReadDir(pkgDir)
		if err != nil {
			return offenders
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") {
				continue
			}
			files = append(files, filepath.Join(pkgDir, entry.Name()))
		}
	}
	for _, file := range files {
		if !strings.HasSuffix(file, ".go") {
			continue
		}
		payload, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		source := string(payload)
		if strings.Contains(source, TableWritesExempt) {
			continue
		}
		name := filepath.Base(file)
		for _, write := range WritesIn(source) {
			if OwnsIt(name, write.Table, declared) {
				continue
			}
			offenders = append(offenders, TableOffender{File: file, Table: write.Table, Line: write.Line})
		}
	}
	return offenders
}

func OwnerOfTable(table string) string {
	if owner, named := ownedTables[table]; named {
		return owner
	}
	if strings.HasPrefix(table, "kernel_") {
		return "a core_kernel_*.go file"
	}
	return ""
}
