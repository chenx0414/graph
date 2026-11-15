package harness

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Report struct {
	CaseID             string   `json:"caseId"`
	Root               string   `json:"root"`
	Model              string   `json:"model"`
	Completed          bool     `json:"completed"`
	TimedOut           bool     `json:"timedOut"`
	Success            bool     `json:"success"`
	TaskSuccess        bool     `json:"taskSuccess"`
	Verification       string   `json:"verification"`
	VerificationOutput string   `json:"verificationEvidence,omitempty"`
	ToolCalls          []string `json:"toolCalls"`
	ToolErrors         int      `json:"toolErrors"`
	ElapsedMs          int64    `json:"elapsedMs"`
	Settled            string   `json:"settled"`
	LedgerIncomplete   bool     `json:"cleanupIncomplete"`
	Error              string   `json:"error,omitempty"`
	ClosingWords       string   `json:"closingWords,omitempty"`
}

type Options struct {
	Repository  string
	CaseID      string
	Timeout     time.Duration
	ConfigPath  string
	Environment map[string]string
}

const stubConfig = `{"version":1,"projects":[{"id":"p","root":%q}],` +
	`"credentials":{"local":{"secretRef":"GRAPH_EVAL_LOCAL_KEY"}},` +
	`"models":{"entries":[{"id":"local","modelId":"local","provider":"graph-openai","grade":"high",` +
	`"api":"openai-completions","baseUrl":%q,"contextWindow":32000,"maxTokens":256,` +
	`"credentialId":"local","cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}`

func Run(options Options) Report {
	caseScript, known := Cases[options.CaseID]
	if !known {
		return Report{CaseID: options.CaseID, Verification: "unknown evaluation case"}
	}
	report := Report{CaseID: options.CaseID, Model: "local"}
	root, err := os.MkdirTemp("", "graph-harness-"+options.CaseID+"-")
	if err != nil {
		report.Error = err.Error()
		return report
	}
	report.Root = root
	defer func() { releaseRoot(root, report.TaskSuccess) }()
	project := filepath.Join(root, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		report.Error = err.Error()
		return report
	}
	for name, content := range caseScript.Files {
		if err := os.WriteFile(filepath.Join(project, name), []byte(content), 0o644); err != nil {
			report.Error = err.Error()
			return report
		}
	}
	environment := map[string]string{"HOME": root}
	for key, value := range options.Environment {
		environment[key] = value
	}
	configPath := options.ConfigPath
	var provider *Provider
	if configPath != "" {
		payload, rewriteErr := configWithProject(configPath, project)
		if rewriteErr != nil {
			report.Error = rewriteErr.Error()
			return report
		}
		configPath = filepath.Join(root, "eval-config.json")
		if writeErr := os.WriteFile(configPath, payload, 0o600); writeErr != nil {
			report.Error = writeErr.Error()
			return report
		}
	}
	if configPath == "" {
		provider, err = StartProvider(caseScript)
		if err != nil {
			report.Error = err.Error()
			return report
		}
		defer provider.Close()
		provider.Script(caseScript)
		environment["GRAPH_EVAL_LOCAL_KEY"] = "gate-key"
		payload := fmt.Sprintf(stubConfig, project, provider.BaseURL)
		configPath = filepath.Join(root, "config.json")
		if writeErr := os.WriteFile(configPath, []byte(payload), 0o600); writeErr != nil {
			report.Error = writeErr.Error()
			return report
		}
	}
	daemon, err := StartDaemon(DaemonOptions{Repository: options.Repository, Root: root, ConfigPath: configPath, Mode: "execute", Env: environment})
	if err != nil {
		report.Error = err.Error()
		return report
	}
	defer daemon.Close()
	console, err := OpenConsole(daemon.URL)
	if err != nil {
		report.Error = err.Error() + "\n" + daemon.Output()
		return report
	}
	modelID := "local"
	if options.ConfigPath != "" {
		modelID = firstModelID(options.ConfigPath)
		report.Model = modelID
	}
	var created createdConversation
	if err := console.Post("/api/conversations", map[string]any{
		"projectId": "p", "model": modelID, "text": caseScript.Prompt, "requestId": "harness-" + options.CaseID,
	}, &created); err != nil {
		report.Error = err.Error()
		return report
	}
	began := time.Now()
	completed := pollOperations(console, created.TaskID, options.Timeout)
	report.Completed = completed
	report.ElapsedMs = time.Since(began).Milliseconds()
	if !completed {
		report.TimedOut = true
		_, _ = console.Request("POST", "/api/conversations/"+created.ConversationID+"/pause", map[string]any{"requestId": "harness-deadline-pause"})
		_, _ = console.Request("POST", "/api/conversations/"+created.ConversationID+"/interrupt", map[string]any{"requestId": "harness-deadline-interrupt"})
	}
	report.ToolCalls, report.ToolErrors = toolCalls(filepath.Join(root, "state", "tasks.sqlite"))
	report.Settled = lastOperationState(filepath.Join(root, "state", "tasks.sqlite"))
	report.Verification, report.VerificationOutput, report.Success = verifyCase(caseScript, project)
	if provider != nil {
		report.ClosingWords = provider.LastWords()
	}
	report.TaskSuccess = report.Success && report.Completed && report.Settled == "succeeded"
	return report
}

// A finished run keeps its root only when it failed, so a red case can be
// inspected; a green one is deleted, because every gate run leaves one behind
// and they are tens of megabytes each.
func releaseRoot(root string, success bool) {
	if root == "" || os.Getenv("GRAPH_HARNESS_KEEP_ROOTS") == "1" {
		return
	}
	if success {
		_ = os.RemoveAll(root)
	}
}

func firstModelID(configPath string) string {
	payload, err := os.ReadFile(configPath)
	if err != nil {
		return "local"
	}
	var config struct {
		Models struct {
			Entries []struct {
				ID string `json:"id"`
			} `json:"entries"`
		} `json:"models"`
	}
	if json.Unmarshal(payload, &config) != nil || len(config.Models.Entries) == 0 {
		return "local"
	}
	return config.Models.Entries[0].ID
}

func pollOperations(console *Console, taskID string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var operations []operation
		if err := console.JSON("/api/tasks/"+taskID+"/operations?latest=true", &operations); err == nil && len(operations) > 0 {
			idle := true
			succeeded := true
			for _, item := range operations {
				if item.WorkerActive || !terminalState(item.State) {
					idle = false
					break
				}
				if item.State != "succeeded" {
					succeeded = false
				}
			}
			if idle {
				return succeeded
			}
		}
		time.Sleep(time.Second)
	}
	return false
}

func terminalState(state string) bool {
	switch state {
	case "succeeded", "failed", "interrupted", "cancelled":
		return true
	}
	return false
}

func openLedger(path string) (*sql.DB, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	return sql.Open("sqlite", "file:"+path+"?mode=ro")
}

func toolCalls(path string) ([]string, int) {
	database, err := openLedger(path)
	if err != nil {
		return nil, 0
	}
	defer database.Close()
	rows, err := database.Query("SELECT tool, is_error FROM tool_calls ORDER BY id")
	if err != nil {
		return nil, 0
	}
	defer rows.Close()
	names := []string{}
	errors := 0
	for rows.Next() {
		var name string
		var isError sql.NullBool
		if rows.Scan(&name, &isError) != nil {
			continue
		}
		names = append(names, name)
		if isError.Valid && isError.Bool {
			errors++
		}
	}
	return names, errors
}

func lastOperationState(path string) string {
	database, err := openLedger(path)
	if err != nil {
		return ""
	}
	defer database.Close()
	var state string
	if database.QueryRow("SELECT state FROM operations ORDER BY rowid DESC LIMIT 1").Scan(&state) != nil {
		return ""
	}
	return state
}

func verifyCase(caseScript Case, project string) (string, string, bool) {
	command := exec.Command(caseScript.Verify[0], caseScript.Verify[1:]...)
	command.Dir = project
	environment := append(os.Environ(), "GOFLAGS=", "GOCACHE="+filepath.Join(filepath.Dir(project), "gocache"))
	command.Env = environment
	output, err := command.CombinedOutput()
	evidence := strings.TrimSpace(string(output))
	if err != nil {
		return "behavioral check failed: " + truncate(evidence, 4000), evidence, false
	}
	for _, name := range caseScript.Protected {
		current, readErr := os.ReadFile(filepath.Join(project, name))
		if readErr != nil || string(current) != caseScript.Files[name] {
			return "protected file changed: " + name, evidence, false
		}
	}
	return "verified", evidence, true
}

func Judge(caseScript Case, report Report) []string {
	problems := []string{}
	if strings.Join(report.ToolCalls, ",") != strings.Join(caseScript.Expected, ",") {
		used := strings.Join(report.ToolCalls, " → ")
		if used == "" {
			used = "no tool at all"
		}
		problems = append(problems, "the agent used "+used+", the case needs "+strings.Join(caseScript.Expected, " → "))
	}
	for _, forbidden := range caseScript.Forbidden {
		for _, used := range report.ToolCalls {
			if used == forbidden {
				problems = append(problems, "the agent used "+forbidden+", which the harness reserves for complete rewrites")
				break
			}
		}
	}
	if report.ToolErrors > 0 {
		problems = append(problems, "a tool call failed")
	}
	if !report.TaskSuccess {
		if report.Error != "" {
			problems = append(problems, "the case could not run: "+truncate(report.Error, 600))
		} else {
			problems = append(problems, report.Verification)
		}
	}
	if report.LedgerIncomplete {
		problems = append(problems, "the run did not close its ledger")
	}
	if len(problems) > 0 && report.ClosingWords != "" {
		problems = append(problems, "the agent said: "+report.ClosingWords)
	}
	return problems
}

func ParseTimeout(value string) time.Duration {
	ms, err := strconv.Atoi(value)
	if err != nil || ms <= 0 {
		return 120 * time.Second
	}
	return time.Duration(ms) * time.Millisecond
}

func configWithProject(path, project string) ([]byte, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var config map[string]any
	if err := json.Unmarshal(payload, &config); err != nil {
		return nil, err
	}
	config["projects"] = []any{map[string]any{"id": "p", "root": project}}
	return json.Marshal(config)
}
