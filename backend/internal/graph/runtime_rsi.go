package graph

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// RSI is the recursive self-improvement surface: it edits Graph's own source checkout, runs the
// project's own gate, commits to a dedicated branch and asks the host for a reload.

// Only the report is bounded: it is what gets persisted in the conversation and
// shown in the UI. File contents are not capped - the change set already travels
// through a single model tool call, and a large file is a legitimate change.
const RSI_MAX_REPORT_DIFF = 40_000

const RSI_CHECK_TIMEOUT_MS = 15 * 60 * 1000
const RSI_BUILD_TIMEOUT_MS = 20 * 60 * 1000

// RsiCommand is one check command. The runtime only runs node.
type RsiCommand struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

// RsiFileEdit is one replacement inside a file.
type RsiFileEdit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

// RsiFileChange is one file the change set touches.
type RsiFileChange struct {
	Path    string        `json:"path"`
	Action  string        `json:"action"`
	Content *string       `json:"content,omitempty"`
	Edits   []RsiFileEdit `json:"edits,omitempty"`
	From    *string       `json:"from,omitempty"`
}

// RsiChangeInput is one self-improvement request.
type RsiChangeInput struct {
	Title     string          `json:"title"`
	Problem   string          `json:"problem"`
	Evidence  *string         `json:"evidence,omitempty"`
	Diagnosis *string         `json:"diagnosis,omitempty"`
	Impact    *string         `json:"impact,omitempty"`
	Risk      *string         `json:"risk,omitempty"`
	Changes   []RsiFileChange `json:"changes"`
	Checks    []RsiCommand    `json:"checks,omitempty"`
	Activate  *bool           `json:"activate,omitempty"`
	// Force reloads even while other operations are still running; it may interrupt them.
	Force bool `json:"force,omitempty"`
}

// RsiValidationResult is the verdict of one check.
type RsiValidationResult struct {
	Command string `json:"command"`
	Status  string `json:"status"`
	Output  string `json:"output"`
}

// RsiReceiptActivation is the activation state a receipt carries.
type RsiReceiptActivation struct {
	State       string `json:"state"`
	ConfirmedAt *int64 `json:"confirmedAt,omitempty"`
	Generation  *int64 `json:"generation,omitempty"`
}

// RsiReceipt is what one applied change reports.
type RsiReceipt struct {
	Id              string                `json:"id"`
	Status          string                `json:"status"`
	Title           string                `json:"title"`
	Root            *string               `json:"root"`
	Branch          *string               `json:"branch"`
	Commit          *string               `json:"commit"`
	Files           []string              `json:"files"`
	Validation      []RsiValidationResult `json:"validation"`
	RestartRequired bool                  `json:"restartRequired"`
	Activation      *RsiReceiptActivation `json:"activation,omitempty"`
	Force           bool                  `json:"force,omitempty"`
	// PendingFiles are files left uncommitted by this or an earlier failed attempt, still fixable.
	PendingFiles []string `json:"pendingFiles,omitempty"`
	Error        *string  `json:"error,omitempty"`
	Diff         *string  `json:"diff,omitempty"`
	Report       string   `json:"report"`
	// OutputPath is the full check output for this attempt, written outside the receipt the
	// conversation stores.
	OutputPath *string `json:"outputPath,omitempty"`
}

// RsiActivation is what a turn that changed the harness itself did, in the reviewer's terms.
//
// An activation turn has no assistant reply: `apply_rsi_change(activate:true)` ends the turn and the
// model is never asked again. So the change is the material - its title, the report that says why it
// was needed, the files it moved and what the gate said - never the reload receipt, which only names a
// request id. The receipt crosses the tool boundary as JSON, so every field is read defensively.
type RsiActivation struct {
	State string `json:"state"`
	// Note is one honest sentence for the report, so a reader need not go to the filesystem.
	Note string `json:"note"`
}

// RsiActivationInput is what describeActivation reads.
type RsiActivationInput struct {
	Commit *string
	// CommittedNow reports whether THIS call created the commit. A pre-existing HEAD is not a delivery.
	CommittedNow bool
	Activate     bool
	// Live reports whether the daemon already runs commit.
	Live bool
}

// RsiPendingRestart is a reload the host has not confirmed yet.
type RsiPendingRestart struct {
	Id          string  `json:"id"`
	Root        string  `json:"root"`
	Branch      *string `json:"branch"`
	Commit      *string `json:"commit"`
	RequestedAt int64   `json:"requestedAt"`
	Generation  *int64  `json:"generation,omitempty"`
	Force       bool    `json:"force,omitempty"`
}

// RsiSyncEntry is one branch and the copy it was published to.
type RsiSyncEntry struct {
	Branch   string `json:"branch"`
	Upstream string `json:"upstream"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
}

// RsiSyncState is where the checkout stands against the branches it has already published.
type RsiSyncState struct {
	// Unpublished are branches that are ahead of the copy they were published to.
	Unpublished []RsiSyncEntry `json:"unpublished"`
	// Expected are self-improvement work branches, which have no publisher by design.
	Expected  []RsiSyncEntry `json:"expected"`
	LocalOnly int            `json:"localOnly"`
	// Deploy is how the checkout the app runs from compares to the development checkout.
	Deploy *DeployDrift `json:"deploy,omitempty"`
	// Note is one line a reader can act on without reading the list.
	Note string `json:"note"`
	// deployCompared records that the caller asked for the checkout comparison. TypeScript
	// emitted `deploy: null` when the comparison ran and found nothing, so the key has to
	// survive a nil value.
	deployCompared bool
}

// MarshalJSON keeps the TypeScript key order and the `deploy: null` case.
func (state RsiSyncState) MarshalJSON() ([]byte, error) {
	type syncWire struct {
		Unpublished []RsiSyncEntry  `json:"unpublished"`
		Expected    []RsiSyncEntry  `json:"expected"`
		LocalOnly   int             `json:"localOnly"`
		Deploy      json.RawMessage `json:"deploy,omitempty"`
		Note        string          `json:"note"`
	}
	wire := syncWire{Unpublished: state.Unpublished, Expected: state.Expected, LocalOnly: state.LocalOnly, Note: state.Note}
	if state.deployCompared {
		if state.Deploy == nil {
			wire.Deploy = json.RawMessage("null")
		} else {
			raw, err := json.Marshal(state.Deploy)
			if err != nil {
				return nil, err
			}
			wire.Deploy = raw
		}
	}
	return json.Marshal(wire)
}

// RsiOperation is one in-flight operation that keeps a normal reload waiting.
type RsiOperation struct {
	Id             string  `json:"id"`
	TaskId         string  `json:"taskId"`
	NodeId         string  `json:"nodeId"`
	State          string  `json:"state"`
	Request        string  `json:"request"`
	ConversationId *string `json:"conversationId"`
	Archived       bool    `json:"archived"`
}

// RsiLastActivation is the last confirmed reload.
type RsiLastActivation struct {
	Id          string  `json:"id"`
	Commit      *string `json:"commit"`
	ConfirmedAt int64   `json:"confirmedAt"`
	Generation  int     `json:"generation"`
}

// RsiStatus is the whole self-improvement surface as one read.
//
// The field order is the TypeScript object literal order, because the desktop app and the
// e2e suite compare the serialized body.
type RsiStatus struct {
	Available bool    `json:"available"`
	Root      *string `json:"root"`
	Branch    *string `json:"branch"`
	// Reason says why RSI is unavailable, when it is.
	Reason *string `json:"reason,omitempty"`
	// Sync is where the checkout stands against the branches it has published.
	Sync           *RsiSyncState      `json:"sync"`
	PendingRestart *RsiPendingRestart `json:"pendingRestart"`
	// LastActivation is the last confirmed reload.
	LastActivation   *RsiLastActivation `json:"lastActivation"`
	ActiveOperations int                `json:"activeOperations"`
	Operations       []RsiOperation     `json:"operations"`
	// OperationsKnown is false when the operation ledger could not be read, so a reload must wait.
	OperationsKnown bool `json:"operationsKnown"`
	CanRestart      bool `json:"canRestart"`
}

// RsiValidateInput is what a validation hook receives.
type RsiValidateInput struct {
	Root       string
	Checks     []RsiCommand
	Activate   bool
	NeedsBuild bool
}

// RsiValidateFunc runs the gate for one change set.
type RsiValidateFunc func(input RsiValidateInput) []RsiValidationResult

// RsiServiceOptions configures one self-improvement service.
type RsiServiceOptions struct {
	// Root is the Graph source checkout. Absent means the service is unavailable.
	Root *string
	// StateDir holds the restart marker, the working list and the check reports.
	StateDir string
	// Validate replaces the default gate. Absent means the project's own gate runs.
	Validate RsiValidateFunc
}

// RsiApplyContext is the identity one applied change is recorded against.
type RsiApplyContext struct {
	OperationId    *string
	Store          *TaskStore
	TaskId         string
	ConversationId *string
}

// RsiAckRestart is the answer to a reload confirmation.
type RsiAckRestart struct {
	Cleared        bool               `json:"cleared"`
	PendingRestart *RsiPendingRestart `json:"pendingRestart"`
}

// ValidationCommandPlan is the executable, arguments and environment one check runs with.
type ValidationCommandPlan struct {
	Executable string
	Args       []string
	Env        map[string]string
}

// RsiService is the recursive self-improvement service for one checkout.
type RsiService struct {
	// Root is the source checkout, when one was configured.
	Root *string
	// Available is true when the root is a usable Graph Git checkout right now.
	Available bool

	stateDir      string
	validate      RsiValidateFunc
	runningCommit *string
	mu            sync.Mutex
	changing      bool
}

// NewRsiService opens one self-improvement service.
func NewRsiService(options RsiServiceOptions) *RsiService {
	service := &RsiService{stateDir: deployResolve("", options.StateDir)}
	if options.Root != nil && *options.Root != "" {
		root := rsiResolveRoot(*options.Root)
		service.Root = &root
	}
	service.validate = options.Validate
	if service.validate == nil {
		service.validate = rsiDefaultValidate
	}
	if service.Root != nil {
		packageJSON := filepath.Join(*service.Root, "package.json")
		if _, err := os.Stat(packageJSON); err == nil {
			if repo := DetectRepo(*service.Root); repo != nil && *repo == *service.Root {
				service.Available = true
			}
		}
	}
	if service.Available {
		service.runningCommit = RevParse(*service.Root, "HEAD")
	}
	return service
}

var rsiServices = map[string]*RsiService{}
var rsiServicesMu sync.Mutex

// OpenRsiService returns the shared service for one root and state directory.
func OpenRsiService(options RsiServiceOptions) *RsiService {
	key := "unavailable"
	if options.Root != nil {
		key = *options.Root
	}
	key += "\x00" + deployResolve("", options.StateDir)
	rsiServicesMu.Lock()
	defer rsiServicesMu.Unlock()
	if existing, ok := rsiServices[key]; ok {
		return existing
	}
	service := NewRsiService(options)
	rsiServices[key] = service
	return service
}

// ResolveRsiRoot finds the Graph source checkout the daemon runs from.
func ResolveRsiRoot(env map[string]string, cwd string) *string {
	if env == nil {
		env = environMap()
	}
	if configured := strings.TrimSpace(env["GRAPH_RSI_ROOT"]); configured != "" {
		root := rsiResolveRoot(configured)
		return &root
	}
	for _, candidate := range []string{cwd, GraphApplicationRoot()} {
		root := rsiResolveRoot(candidate)
		if _, err := os.Stat(filepath.Join(root, "package.json")); err != nil {
			continue
		}
		if repo := DetectRepo(root); repo != nil && *repo == root {
			return &root
		}
	}
	return nil
}

// rsiResolveRoot realpaths a candidate so symlinked checkouts compare equal to Git's top-level path.
func rsiResolveRoot(path string) string {
	absolute := deployResolve("", path)
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		return resolved
	}
	return absolute
}

// rsiWriteAtomic writes a file through a temporary name, the way the TypeScript service did.
func rsiWriteAtomic(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	pending := fmt.Sprintf("%s.%d.%s.pending", path, os.Getpid(), graphUUID())
	if err := os.WriteFile(pending, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(pending, path)
}

// rsiCommandOutput is the stdout and stderr of one command, bounded to the last 40,000 characters.
func rsiCommandOutput(stdout, stderr string) string {
	parts := []string{}
	if stdout != "" {
		parts = append(parts, stdout)
	}
	if stderr != "" {
		parts = append(parts, stderr)
	}
	joined := strings.TrimSpace(strings.Join(parts, "\n"))
	runes := []rune(joined)
	if len(runes) > 40_000 {
		joined = string(runes[len(runes)-40_000:])
	}
	return joined
}

// rsiAnsiPattern matches the colour codes a test runner prints.
var rsiAnsiPattern = regexp.MustCompile("\x1b\\[[0-9;]*m")

// rsiFailureLine matches the lines a test runner prints for the case that failed.
var rsiFailureLine = regexp.MustCompile(`(^|\s)FAIL |Failed Tests|AssertionError|Matcher did not succeed|Error: |❯ `)

// FailureDigest is the bounded digest a failed check carries.
//
// A failed check keeps only the last 40,000 characters of its output, and
// concurrent test workers interleave their reporter lines, so the line that
// names the failing case can fall outside that window. The report carries this
// bounded digest so a failure is always explainable without guessing.
func FailureDigest(validation []RsiValidationResult, limits ...int) []string {
	limit := 3000
	maxLines := 30
	if len(limits) > 0 {
		limit = limits[0]
	}
	if len(limits) > 1 {
		maxLines = limits[1]
	}
	lines := []string{}
	used := 0
	for _, item := range validation {
		if item.Status != "failed" {
			continue
		}
		found := []string{}
		for _, line := range strings.Split(rsiAnsiPattern.ReplaceAllString(item.Output, ""), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || !rsiFailureLine.MatchString(trimmed) {
				continue
			}
			found = append(found, trimmed)
		}
		if len(found) == 0 {
			continue
		}
		lines = append(lines, "  - "+item.Command+":")
		for _, line := range found {
			if len(lines) > maxLines || used+utf8.RuneCountInString(line) > limit {
				break
			}
			used += utf8.RuneCountInString(line)
			lines = append(lines, "    "+line)
		}
	}
	if len(lines) == 0 {
		return []string{}
	}
	return append([]string{"- 失败摘要："}, lines...)
}

// ValidationCommand is the command line and environment for one check. Checks run outside the sandbox in
// the user's own checkout, so they keep the inherited environment - except `DYLD_*`: an unrelated
// installer can point those at its own copies of system libraries, and a node binary started that way
// dies before its own code runs. A packaged app ships a real node runtime (`GRAPH_APP_NODE`) and validates
// the checkout with it; otherwise the developer's own `node` runs the gate, exactly as it would from
// their shell. The inherited `PATH` keeps its order and gains the developer's own toolchain locations,
// so the gate is the same one the developer would run from a terminal.
func ValidationCommand(command RsiCommand, env map[string]string) ValidationCommandPlan {
	if env == nil {
		env = environMap()
	}
	executable := strings.TrimSpace(env[RUNTIME_NODE_ENV])
	if executable == "" {
		executable = "node"
	}
	filtered := map[string]string{}
	for key, value := range env {
		if strings.HasPrefix(key, "DYLD_") {
			continue
		}
		filtered[key] = value
	}
	filtered["PATH"] = DeveloperPath(env["PATH"])
	filtered["ELECTRON_RUN_AS_NODE"] = "1"
	filtered["GIT_TERMINAL_PROMPT"] = "0"
	filtered["GIT_PAGER"] = "cat"
	filtered["PAGER"] = "cat"
	return ValidationCommandPlan{Executable: executable, Args: command.Args, Env: filtered}
}

// rsiEnvList turns an environment map into the sorted KEY=VALUE list exec expects.
func rsiEnvList(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+env[key])
	}
	return out
}

// rsiRunCommand runs one check and reports its verdict.
func rsiRunCommand(root string, command RsiCommand, timeoutMs int) RsiValidationResult {
	resolved := ValidationCommand(command, nil)
	label := strings.Join(append([]string{command.Command}, command.Args...), " ")
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	process := exec.CommandContext(ctx, resolved.Executable, resolved.Args...)
	process.Dir = root
	process.Env = rsiEnvList(resolved.Env)
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	process.Stdout = stdout
	process.Stderr = stderr
	err := process.Run()
	if err == nil {
		return RsiValidationResult{Command: label, Status: "passed", Output: rsiCommandOutput(stdout.String(), stderr.String())}
	}
	if _, exited := err.(*exec.ExitError); !exited {
		// The process never ran; node reports the error message instead of the streams.
		return RsiValidationResult{Command: label, Status: "failed", Output: rsiCommandOutput("", err.Error())}
	}
	return RsiValidationResult{Command: label, Status: "failed", Output: rsiCommandOutput(stdout.String(), stderr.String())}
}

// rsiSummarizeValidation drops the output of a passing suite: the full log stays in the report file.
func rsiSummarizeValidation(result RsiValidationResult) RsiValidationResult {
	if result.Status == "passed" {
		result.Output = ""
	}
	return result
}

// rsiBuildRelevant reports whether any changed path makes `node --run app:build` meaningful: the web
// bundle the window serves and the desktop package. A runtime-only change is fully covered by
// `node --run check`.
func rsiBuildRelevant(paths []string) bool {
	for _, path := range paths {
		if strings.HasPrefix(path, "src/web/") || strings.HasPrefix(path, "desktop/") ||
			path == "package.json" || path == "index.html" || strings.HasPrefix(path, "vite.config") {
			return true
		}
	}
	return false
}

// rsiChangedSince lists the files that differ from a known commit. An unknown base returns nil, which
// means "assume it needs a build".
func rsiChangedSince(root, base string) []string {
	result := Git(root, []string{"diff", "--name-only", base + "..HEAD"}, nil, nil)
	if result.Code != 0 {
		return nil
	}
	paths := []string{}
	for _, line := range strings.Split(result.Stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			paths = append(paths, trimmed)
		}
	}
	return paths
}

// rsiDefaultValidate runs the project's own gate.
//
// Custom checks give a fast inner loop while iterating. The full gate runs
// before a change goes live, or whenever no custom check was supplied.
func rsiDefaultValidate(input RsiValidateInput) []RsiValidationResult {
	results := []RsiValidationResult{}
	for _, check := range input.Checks {
		result := rsiRunCommand(input.Root, check, RSI_CHECK_TIMEOUT_MS)
		results = append(results, result)
		if result.Status == "failed" {
			return results
		}
	}
	if len(input.Checks) > 0 && !input.Activate {
		return results
	}
	check := rsiRunCommand(input.Root, RsiCommand{Command: "node", Args: []string{"--run", "check"}}, RSI_CHECK_TIMEOUT_MS)
	results = append(results, check)
	if check.Status == "failed" || !input.Activate {
		return results
	}
	if !input.NeedsBuild {
		return results
	}
	appBuild := RsiCommand{Command: "node", Args: []string{"--run", "app:build"}}
	build := rsiRunCommand(input.Root, appBuild, RSI_BUILD_TIMEOUT_MS)
	if build.Status == "passed" || !IsEnvironmentFailure(build.Output) {
		results = append(results, build)
		return results
	}
	// Only the packaging step is re-run here: `check` already passed and its verdict cannot change
	// because a download was interrupted. One retry, because a flake is what this fixes; a real
	// outage still fails, and the message says which of the two happened.
	retry := rsiRunCommand(input.Root, appBuild, RSI_BUILD_TIMEOUT_MS)
	if retry.Status == "passed" {
		results = append(results, RsiValidationResult{Command: retry.Command, Status: retry.Status,
			Output: "app:build 第一次因网络/下载中断失败，已自动重跑一次并成功（与改动无关）。\n" + retry.Output})
	} else {
		results = append(results, RsiValidationResult{Command: retry.Command, Status: retry.Status,
			Output: "app:build 连续两次失败，其中至少一次是网络/下载问题，而不是改动本身。\n--- 第一次 ---\n" + build.Output + "\n--- 第二次 ---\n" + retry.Output})
	}
	return results
}

// rsiSlug is the branch name fragment one change contributes.
func rsiSlug(value string) string {
	lowered := strings.ToLower(value)
	built := strings.Builder{}
	for _, symbol := range lowered {
		if (symbol >= 'a' && symbol <= 'z') || (symbol >= '0' && symbol <= '9') {
			built.WriteRune(symbol)
		} else {
			built.WriteRune('-')
		}
	}
	collapsed := regexp.MustCompile(`-+`).ReplaceAllString(built.String(), "-")
	trimmed := strings.Trim(collapsed, "-")
	runes := []rune(trimmed)
	if len(runes) > 40 {
		trimmed = string(runes[:40])
	}
	if trimmed == "" {
		return "change"
	}
	return trimmed
}

// rsiInside resolves a change path inside the checkout and reports it relative to the root.
func rsiInside(root, path string) (string, bool) {
	base := deployResolve("", root)
	target := deployResolve(base, path)
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return "", false
	}
	if rel == "" || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// rsiAsArray returns the array behind a value, or an empty array.
func rsiAsArray(value any) []any {
	items, ok := rsiAsArrayOf(value)
	if !ok {
		return []any{}
	}
	return items
}

// rsiAsArrayOf returns the array behind a value and whether it was one.
func rsiAsArrayOf(value any) ([]any, bool) {
	if value == nil {
		return nil, false
	}
	reflected := reflect.ValueOf(value)
	if reflected.Kind() != reflect.Slice && reflected.Kind() != reflect.Array {
		return nil, false
	}
	out := make([]any, reflected.Len())
	for index := 0; index < reflected.Len(); index++ {
		out[index] = reflected.Index(index).Interface()
	}
	return out, true
}

// rsiIsArray reports whether a value is an array, the way Array.isArray does.
func rsiIsArray(value any) bool {
	if value == nil {
		return false
	}
	reflected := reflect.ValueOf(value)
	return reflected.Kind() == reflect.Slice || reflected.Kind() == reflect.Array
}

// rsiPlainObject returns the object behind a value. Arrays and scalars are not a shape mistake.
func rsiPlainObject(value any) map[string]any {
	if value == nil {
		return nil
	}
	reflected := reflect.ValueOf(value)
	if reflected.Kind() != reflect.Map || reflected.Type().Key().Kind() != reflect.String {
		return nil
	}
	out := map[string]any{}
	for _, key := range reflected.MapKeys() {
		out[key.String()] = reflected.MapIndex(key).Interface()
	}
	return out
}

// rsiHasOwn reports whether an object carries a key.
func rsiHasOwn(object map[string]any, key string) bool {
	_, ok := object[key]
	return ok
}

// rsiText reads a string field, or the empty string.
func rsiText(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return text
}

// rsiHasWhitespace reports whether a string carries whitespace.
func rsiHasWhitespace(value string) bool {
	for _, symbol := range value {
		if unicode.IsSpace(symbol) {
			return true
		}
	}
	return false
}

// RevisionRefusal says why a `from` value cannot be used as a revision, or the empty string when it can.
//
// One rule with two callers - the model-facing shape hint and the change parser - so the two cannot
// drift: a path smuggled into the revision, whitespace, a leading dash (an option, not a revision) and
// an empty value are refused in the same words, in the same place.
func RevisionRefusal(from any) string {
	rev := ""
	if text, ok := from.(string); ok {
		rev = strings.TrimSpace(text)
	}
	if rev == "" {
		return "must name the revision to copy the file from (for a mirror: the commit that holds the finished file)"
	}
	if utf8.RuneCountInString(rev) > 200 || strings.Contains(rev, ":") || strings.HasPrefix(rev, "-") || rsiHasWhitespace(rev) {
		return "must be a revision only - \"" + rev + "\" carries something else (a path belongs in \"path\", not in the revision)"
	}
	return ""
}

// rsiAssertText reads a bounded text field.
func rsiAssertText(value any, name string, max int, required bool) string {
	text := ""
	if typed, ok := value.(string); ok {
		text = strings.TrimSpace(typed)
	}
	if required && text == "" {
		Raise("invalid_input", name+" is required")
	}
	if utf8.RuneCountInString(text) > max {
		Raise("invalid_input", fmt.Sprintf("%s must be at most %d characters", name, max))
	}
	return text
}

// rsiChangePath is the one key a change cannot omit, spelled the way the batch is accepted;
// `file`/`filePath` are accepted because a batch written without one had to be resent whole.
func rsiChangePath(body map[string]any) any {
	if value, ok := body["path"]; ok && value != nil {
		return value
	}
	if value, ok := body["file"]; ok && value != nil {
		return value
	}
	if value, ok := body["filePath"]; ok && value != nil {
		return value
	}
	return nil
}

// rsiChangePathText names the shape, not just the missing key: a resend must not need a second guess.
func rsiChangePathText(body map[string]any, index int) string {
	path := strings.TrimSpace(rsiText(rsiChangePath(body)))
	if path == "" {
		Raise("invalid_input", fmt.Sprintf(
			"changes[%d].path is required: each change is {path, action: \"write\", content} | {path, action: \"replace\", edits: [{oldText, newText}]} | {path, action: \"delete\"}", index))
	}
	if utf8.RuneCountInString(path) > 1000 {
		Raise("invalid_input", fmt.Sprintf("changes[%d].path must be at most 1000 characters", index))
	}
	return path
}

// rsiNormalizeChange reads one file change.
func rsiNormalizeChange(value any, index int) RsiFileChange {
	body := rsiPlainObject(value)
	if body == nil {
		Raise("invalid_input", fmt.Sprintf("changes[%d] must be an object", index))
	}
	path := rsiChangePathText(body, index)
	switch rsiText(body["action"]) {
	case "write":
		content, ok := body["content"].(string)
		if !ok {
			Raise("invalid_input", fmt.Sprintf("changes[%d].content must be a string", index))
		}
		return RsiFileChange{Path: path, Action: "write", Content: &content}
	case "copy":
		// A mirror is "this file exactly as that revision has it". Retyping the content instead is what
		// silently drops a line, and the drop surfaces minutes later as an unrelated-looking check
		// failure - so the revision is named and the content is read out of it, byte for byte.
		if refusal := RevisionRefusal(body["from"]); refusal != "" {
			Raise("invalid_input", fmt.Sprintf("changes[%d].from %s", index, refusal))
		}
		from := strings.TrimSpace(rsiText(body["from"]))
		return RsiFileChange{Path: path, Action: "copy", From: &from}
	case "delete":
		return RsiFileChange{Path: path, Action: "delete"}
	}
	if rsiText(body["action"]) != "replace" {
		Raise("invalid_input", fmt.Sprintf("changes[%d] must be write, replace, copy or delete", index))
	}
	rawEdits, ok := rsiAsArrayOf(body["edits"])
	if !ok || len(rawEdits) == 0 {
		Raise("invalid_input", fmt.Sprintf("changes[%d] must be write, replace, copy or delete", index))
	}
	edits := []RsiFileEdit{}
	for editIndex, rawEdit := range rawEdits {
		record := rsiPlainObject(rawEdit)
		if record == nil {
			Raise("invalid_input", fmt.Sprintf("changes[%d].edits[%d] must be an object", index, editIndex))
		}
		oldText, ok := record["oldText"].(string)
		if !ok || oldText == "" {
			Raise("invalid_input", fmt.Sprintf("changes[%d].edits[%d].oldText must be nonempty", index, editIndex))
		}
		newText, ok := record["newText"].(string)
		if !ok {
			Raise("invalid_input", fmt.Sprintf("changes[%d].edits[%d].newText must be a string", index, editIndex))
		}
		edits = append(edits, RsiFileEdit{OldText: oldText, NewText: newText})
	}
	return RsiFileChange{Path: path, Action: "replace", Edits: edits}
}

// rsiNormalizeChecks reads the custom checks of one change.
func rsiNormalizeChecks(value any, present bool) []RsiCommand {
	if !present {
		return []RsiCommand{}
	}
	if value == nil {
		Raise("invalid_input", "checks must be an array")
	}
	items, ok := rsiAsArrayOf(value)
	if !ok {
		Raise("invalid_input", "checks must be an array")
	}
	checks := []RsiCommand{}
	for index, item := range items {
		record := rsiPlainObject(item)
		if record == nil {
			Raise("invalid_input", fmt.Sprintf("checks[%d] must be an object", index))
		}
		if rsiText(record["command"]) != "node" {
			Raise("invalid_input", fmt.Sprintf("checks[%d].command must be \"node\"", index))
		}
		rawArgs, ok := rsiAsArrayOf(record["args"])
		if !ok {
			Raise("invalid_input", fmt.Sprintf("checks[%d].args must be a string array", index))
		}
		args := []string{}
		for _, rawArg := range rawArgs {
			text, ok := rawArg.(string)
			if !ok || utf8.RuneCountInString(text) > 1000 {
				Raise("invalid_input", fmt.Sprintf("checks[%d].args must be a string array", index))
			}
			args = append(args, text)
		}
		checks = append(checks, RsiCommand{Command: "node", Args: args})
	}
	return checks
}

// RsiChangeInputOf normalizes the raw tool arguments into one change request.
func RsiChangeInputOf(value any) RsiChangeInput {
	body := rsiPlainObject(value)
	if body == nil {
		body = map[string]any{}
	}
	title := rsiAssertText(body["title"], "title", 200, true)
	problem := rsiAssertText(body["problem"], "problem", 4000, true)
	normalized := RsiChangeInput{Title: title, Problem: problem, Changes: []RsiFileChange{}}
	if raw, ok := body["evidence"]; ok && raw != nil {
		text := rsiAssertText(raw, "evidence", 4000, false)
		if text != "" {
			normalized.Evidence = &text
		}
	}
	if raw, ok := body["diagnosis"]; ok && raw != nil {
		text := rsiAssertText(raw, "diagnosis", 4000, false)
		if text != "" {
			normalized.Diagnosis = &text
		}
	}
	if raw, ok := body["impact"]; ok && raw != nil {
		text := rsiAssertText(raw, "impact", 4000, false)
		if text != "" {
			normalized.Impact = &text
		}
	}
	if raw, ok := body["risk"]; ok && raw != nil {
		text := rsiAssertText(raw, "risk", 4000, false)
		if text != "" {
			normalized.Risk = &text
		}
	}
	if raw, ok := body["changes"]; ok {
		if items, isArray := rsiAsArrayOf(raw); isArray {
			for index, item := range items {
				normalized.Changes = append(normalized.Changes, rsiNormalizeChange(item, index))
			}
		}
	}
	rawChecks, checksPresent := body["checks"]
	normalized.Checks = rsiNormalizeChecks(rawChecks, checksPresent)
	activate := true
	if raw, ok := body["activate"]; ok {
		if flag, isBool := raw.(bool); isBool && !flag {
			activate = false
		}
	}
	normalized.Activate = &activate
	if flag, ok := body["force"].(bool); ok && flag {
		normalized.Force = true
	}
	return normalized
}

// RsiChangeMaterial is what a turn that changed the harness itself did, in the reviewer's terms.
//
// The receipt crosses the tool boundary as JSON, so every field is read defensively.
func RsiChangeMaterial(receipt map[string]any, reply string) string {
	files := []string{}
	if rows, ok := rsiAsArrayOf(receipt["files"]); ok {
		for _, item := range rows {
			if text, isText := item.(string); isText {
				files = append(files, text)
			}
		}
	}
	checks := []string{}
	if rows, ok := rsiAsArrayOf(receipt["validation"]); ok {
		for _, row := range rows {
			switch typed := row.(type) {
			case map[string]any:
				checks = append(checks, rsiText(typed["command"])+": "+rsiText(typed["status"]))
			case []any:
				checks = append(checks, ": ")
			}
		}
	}
	parts := []string{
		strings.TrimSpace(reply),
		"",
		"",
		"",
		rsiText(receipt["report"]),
		"",
	}
	if title := rsiText(receipt["title"]); title != "" {
		parts[1] = "RSI 变更：" + title
	}
	if len(files) > 0 {
		parts[2] = "文件：" + strings.Join(files, ", ")
	}
	if len(checks) > 0 {
		parts[3] = "验证：" + strings.Join(checks, "；")
	}
	if diff := rsiText(receipt["diff"]); diff != "" {
		runes := []rune(diff)
		if len(runes) > 6000 {
			diff = string(runes[:6000])
		}
		parts[5] = "diff：\n```diff\n" + diff + "\n```"
	}
	kept := []string{}
	for _, part := range parts {
		if strings.TrimSpace(part) != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "\n\n")
}

// DescribeActivation says what this call actually did about the running daemon.
//
// HB-179: a call with no changes committed nothing yet was reported as `applied` with activation
// `active` and the note "该提交已是运行中的版本，无需重载" — while the source checkout did not hold the
// commit at all. `active` says "what you asked for is running", and a check-only call has no right to
// say it. The rule here is that the state is derived from THIS call's commit, never from HEAD alone.
func DescribeActivation(input RsiActivationInput) RsiActivation {
	if !input.Activate {
		if input.CommittedNow {
			return RsiActivation{State: "saved", Note: "仅保存，未重载"}
		}
		return RsiActivation{State: "saved", Note: "未重载，且这次调用没有产生提交"}
	}
	if !input.CommittedNow || input.Commit == nil {
		// The honest case the receipt used to hide: checks ran, nothing was delivered, so claiming a
		// running version would be a statement about work that does not exist.
		return RsiActivation{State: "checked_only", Note: "这次调用只跑了检查，没有产生提交：源码是否需要更新，请自己核对后再判断。"}
	}
	if input.Live {
		return RsiActivation{State: "active", Note: "这次提交已在运行中的版本里，无需重载"}
	}
	return RsiActivation{State: "pending_reload", Note: "已安排重载"}
}

// RsiDirtyMessage says why a dirty path outside the requested change stops an RSI write, and what to do
// about it. An Agent that edited the checkout by hand gets this instead of a
// commit, so the message has to name the supported route: RSI edits must be
// written by the tool, which is the only path that can attribute them to a
// verified commit.
func RsiDirtyMessage(root string, blocked []string) string {
	paths := strings.Join(blocked, " ")
	return "Uncommitted changes outside this RSI change: " + strings.Join(blocked, ", ") + ". " +
		"Checks run against the working tree, so they would verify changes that the commit does not contain. " +
		"If you edited these files by hand, revert them and pass the same edits as changes to apply_rsi_change: " +
		"RSI edits must be written by the tool, and a hand-committed tree cannot be attributed to a verified RSI commit. " +
		"To keep them as ordinary work instead, commit them first, for example `git -C " + root + " add -A -- " + paths + " && git -C " + root + " commit -m \"wip\"`, " +
		"or revert them with `git -C " + root + " restore --staged --worktree -- " + paths + "`. " +
		"Files left behind by an earlier failed RSI attempt on this branch are committed instead of reported."
}

// rsiJSONString encodes one JSON string the way JSON.stringify does.
func rsiJSONString(value string) string {
	buffer := &bytes.Buffer{}
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
	return strings.TrimRight(buffer.String(), "\n")
}

// rsiJSONStringOrNull encodes a string that may be absent.
func rsiJSONStringOrNull(value *string) string {
	if value == nil {
		return "null"
	}
	return rsiJSONString(*value)
}

// rsiFailureReport is the report of a change that could not be applied.
func rsiFailureReport(input RsiChangeInput, root *string, errorText string, validation []RsiValidationResult) string {
	target := "不可用"
	if root != nil {
		target = *root
	}
	lines := []string{
		"### RSI 变更失败：" + input.Title,
		"",
		"- 问题：" + input.Problem,
		"- 目标：" + target,
		"- 原因：" + errorText,
	}
	if len(validation) > 0 {
		lines = append(lines, "- 验证：")
		for _, item := range validation {
			lines = append(lines, "  - "+item.Command+": "+item.Status)
		}
		lines = append(lines, FailureDigest(validation)...)
	}
	return strings.Join(lines, "\n")
}

// rsiChecksFailedReport is the report of a change whose checks failed.
func rsiChecksFailedReport(input RsiChangeInput, receipt RsiReceipt) string {
	branch := "unknown"
	if receipt.Branch != nil {
		branch = *receipt.Branch
	}
	pending := strings.Join(receipt.PendingFiles, ", ")
	if pending == "" {
		pending = "（无文件改动）"
	}
	lines := []string{
		"### RSI 检查未通过，改动已保留：" + input.Title,
		"",
		"- 问题：" + input.Problem,
	}
	if input.Diagnosis != nil && *input.Diagnosis != "" {
		lines = append(lines, "- 诊断："+*input.Diagnosis)
	}
	lines = append(lines,
		"- 分支："+branch,
		"- 保留文件："+pending,
		"- 验证：",
	)
	for _, item := range receipt.Validation {
		lines = append(lines, "  - "+item.Command+": "+item.Status)
	}
	lines = append(lines, FailureDigest(receipt.Validation)...)
	lines = append(lines, "",
		"改动仍在工作区、尚未提交，也不会触发重载。继续修复后再次调用 apply_rsi_change 即可（可用 changes: [] 只重跑检查）。")
	return strings.Join(lines, "\n")
}

// rsiUnavailableReport is the report of a change that could not run at all.
func rsiUnavailableReport(input RsiChangeInput, root *string, reason string) string {
	target := "未找到"
	if root != nil {
		target = *root
	}
	return strings.Join([]string{
		"### RSI 不可用：" + input.Title,
		"",
		"- 问题：" + input.Problem,
		"- 目标：" + target,
		"- 原因：" + reason,
	}, "\n")
}

// rsiSuccessReport is the report of a change that was committed.
func rsiSuccessReport(input RsiChangeInput, receipt RsiReceipt, activationNote string) string {
	branch := "unknown"
	if receipt.Branch != nil {
		branch = *receipt.Branch
	}
	commit := "unknown"
	if receipt.Commit != nil {
		commit = *receipt.Commit
	}
	lines := []string{
		"### RSI 已提交：" + input.Title,
		"",
		"- 问题：" + input.Problem,
	}
	if input.Evidence != nil && *input.Evidence != "" {
		lines = append(lines, "- 证据："+*input.Evidence)
	}
	if input.Diagnosis != nil && *input.Diagnosis != "" {
		lines = append(lines, "- 诊断："+*input.Diagnosis)
	}
	if input.Impact != nil && *input.Impact != "" {
		lines = append(lines, "- 影响："+*input.Impact)
	}
	if input.Risk != nil && *input.Risk != "" {
		lines = append(lines, "- 风险："+*input.Risk)
	}
	lines = append(lines,
		"- 分支："+branch,
		"- 提交："+commit,
		"- 文件："+strings.Join(receipt.Files, ", "),
		"- 验证：",
	)
	for _, item := range receipt.Validation {
		lines = append(lines, "  - "+item.Command+": "+item.Status)
	}
	if receipt.OutputPath != nil && *receipt.OutputPath != "" {
		lines = append(lines, "- 完整日志："+*receipt.OutputPath)
	}
	lines = append(lines, FailureDigest(receipt.Validation)...)
	lines = append(lines, "- 激活："+activationNote)
	if receipt.RestartRequired {
		lines = append(lines, "- 当前回合已结束；等待宿主重载确认后才能报告“已生效”。")
	}
	if receipt.Diff != nil && *receipt.Diff != "" {
		lines = append(lines, "", "```diff", *receipt.Diff, "```")
	}
	return strings.Join(lines, "\n")
}

// rsiDiffFor is the diff of one commit, bounded to the report size.
func rsiDiffFor(root, commit string) *string {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	process := exec.CommandContext(ctx, "git", "show", "--format=", "--no-ext-diff", "--unified=3", commit)
	process.Dir = root
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	process.Stdout = stdout
	process.Stderr = stderr
	if err := process.Run(); err != nil {
		return nil
	}
	diff := strings.TrimSpace(stdout.String())
	runes := []rune(diff)
	if len(runes) > RSI_MAX_REPORT_DIFF {
		diff = string(runes[:RSI_MAX_REPORT_DIFF]) + "\n... diff truncated ..."
	}
	return &diff
}

// rsiRestartPath is where the pending reload request lives.
func (service *RsiService) rsiRestartPath() string {
	return filepath.Join(service.stateDir, "rsi", "restart.json")
}

// rsiWorkingPath is where the files of a failed attempt live.
func (service *RsiService) rsiWorkingPath() string {
	return filepath.Join(service.stateDir, "rsi", "working.json")
}

// rsiDirtyPaths lists the uncommitted paths in the checkout. Checks run against the working tree, so a
// path here that the commit would not contain makes a green run prove the wrong thing.
func rsiDirtyPaths(root string) []string {
	seen := map[string]bool{}
	for _, args := range [][]string{{"diff", "--name-only", "HEAD"}, {"ls-files", "--others", "--exclude-standard"}} {
		result := Git(root, args, nil, nil)
		for _, line := range strings.Split(result.Stdout, "\n") {
			path := strings.TrimSpace(line)
			if path != "" {
				seen[path] = true
			}
		}
	}
	paths := []string{}
	for path := range seen {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

// HasPendingRestart keeps queued work intact while the desktop drains existing operations.
func (service *RsiService) HasPendingRestart() bool {
	_, err := os.Stat(service.rsiRestartPath())
	return err == nil
}

// rsiWriteReportFile keeps the full check output for one attempt out of the receipt the conversation stores.
func (service *RsiService) rsiWriteReportFile(id string, validation []RsiValidationResult) string {
	directory := filepath.Join(service.stateDir, "rsi", "reports")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		panic(err)
	}
	path := filepath.Join(directory, id+".log")
	sections := []string{}
	for _, item := range validation {
		sections = append(sections, "$ "+item.Command+"\n["+item.Status+"]\n"+item.Output+"\n")
	}
	if err := os.WriteFile(path, []byte(strings.Join(sections, "\n")), 0o600); err != nil {
		panic(err)
	}
	return path
}

// rsiReadRestart reads the pending reload request.
func (service *RsiService) rsiReadRestart() *RsiPendingRestart {
	raw, err := os.ReadFile(service.rsiRestartPath())
	if err != nil {
		return nil
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil
	}
	if _, ok := fields["id"].(string); !ok {
		return nil
	}
	if _, ok := fields["root"].(string); !ok {
		return nil
	}
	var restart RsiPendingRestart
	if err := json.Unmarshal(raw, &restart); err != nil {
		return nil
	}
	return &restart
}

// rsiReadWorking reads the files a previous failed attempt left uncommitted. They stay editable so the
// Main Agent can keep fixing the same change instead of losing it to a flaky check, while unrelated
// user edits still block the change set.
func (service *RsiService) rsiReadWorking() *RsiWorkingFiles {
	raw, err := os.ReadFile(service.rsiWorkingPath())
	if err != nil {
		return nil
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil
	}
	branch, ok := fields["branch"].(string)
	if !ok {
		return nil
	}
	rawPaths, ok := fields["paths"].([]any)
	if !ok {
		return nil
	}
	paths := []string{}
	for _, item := range rawPaths {
		if path, isText := item.(string); isText {
			paths = append(paths, path)
		}
	}
	return &RsiWorkingFiles{Branch: branch, Paths: paths}
}

// RsiWorkingFiles are the files a failed attempt left uncommitted.
type RsiWorkingFiles struct {
	Branch string
	Paths  []string
}

// rsiWriteWorking records the files a failed attempt left behind.
func (service *RsiService) rsiWriteWorking(branch string, paths []string) error {
	unique := map[string]bool{}
	for _, path := range paths {
		unique[path] = true
	}
	sorted := []string{}
	for path := range unique {
		sorted = append(sorted, path)
	}
	sort.Strings(sorted)
	lines := []string{"{", "  \"branch\": " + rsiJSONString(branch) + ","}
	if len(sorted) == 0 {
		lines = append(lines, "  \"paths\": []")
	} else {
		lines = append(lines, "  \"paths\": [")
		for index, path := range sorted {
			separator := ","
			if index == len(sorted)-1 {
				separator = ""
			}
			lines = append(lines, "    "+rsiJSONString(path)+separator)
		}
		lines = append(lines, "  ]")
	}
	lines = append(lines, "}")
	return rsiWriteAtomic(service.rsiWorkingPath(), strings.Join(lines, "\n")+"\n")
}

// rsiWriteRestart records the reload request the host has to confirm.
func (service *RsiService) rsiWriteRestart(id, root, branch string, commit *string, requestedAt int64, generation int, force bool) error {
	lines := []string{
		"{",
		"  \"id\": " + rsiJSONString(id) + ",",
		"  \"root\": " + rsiJSONString(root) + ",",
		"  \"branch\": " + rsiJSONString(branch) + ",",
		"  \"commit\": " + rsiJSONStringOrNull(commit) + ",",
		"  \"requestedAt\": " + fmt.Sprintf("%d", requestedAt) + ",",
		"  \"generation\": " + fmt.Sprintf("%d", generation),
	}
	if force {
		lines[len(lines)-1] += ","
		lines = append(lines, "  \"force\": true")
	}
	lines = append(lines, "}")
	return rsiWriteAtomic(service.rsiRestartPath(), strings.Join(lines, "\n")+"\n")
}

// Status is the whole self-improvement surface as one read.
func (service *RsiService) Status(compare bool) RsiStatus {
	status := RsiStatus{
		Operations:      []RsiOperation{},
		OperationsKnown: true,
		PendingRestart:  service.rsiReadRestart(),
		LastActivation:  service.rsiReadActivation(),
	}
	if service.Available && service.Root != nil {
		status.Available = true
		status.Root = service.Root
		status.Branch = CheckedOutBranch(*service.Root)
		status.Sync = service.rsiSyncState(*service.Root, compare)
	} else {
		reason := service.rsiUnavailableReason()
		status.Reason = &reason
	}
	operations, known := rsiReadOperations(service.stateDir)
	if known {
		status.Operations = operations
		status.ActiveOperations = len(operations)
	} else {
		status.Operations = []RsiOperation{}
		status.ActiveOperations = 0
		status.OperationsKnown = false
	}
	canRestart := false
	if status.PendingRestart != nil {
		// A forced request reloads even with operations in flight; a normal one
		// waits for the ledger to drain.
		canRestart = status.PendingRestart.Force || (status.OperationsKnown && status.ActiveOperations == 0)
	}
	status.CanRestart = canRestart
	return status
}

// rsiReadActivation reads the last confirmed reload.
func (service *RsiService) rsiReadActivation() *RsiLastActivation {
	raw, err := os.ReadFile(filepath.Join(service.stateDir, "rsi", "activated.json"))
	if err != nil {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	if value == nil {
		return nil
	}
	var activation RsiLastActivation
	if err := json.Unmarshal(raw, &activation); err != nil {
		return nil
	}
	return &activation
}

// rsiReadOperations reads the in-flight operations from the task ledger.
func rsiReadOperations(stateDir string) ([]RsiOperation, bool) {
	dbPath := filepath.Join(stateDir, "tasks.sqlite")
	if _, err := os.Stat(dbPath); err != nil {
		return []RsiOperation{}, true
	}
	operations := []RsiOperation{}
	known := true
	func() {
		defer func() {
			if recover() != nil {
				operations = []RsiOperation{}
				known = false
			}
		}()
		db, err := OpenSQLite(dbPath)
		if err != nil {
			operations = []RsiOperation{}
			known = false
			return
		}
		defer db.Close()
		rows := kernelRows(db, `
          SELECT o.id, o.task_id AS taskId, o.node_id AS nodeId, o.state,
                 t.request AS request, t.conversation_id AS conversationId,
                 CASE WHEN c.archived_at IS NULL THEN 0 ELSE 1 END AS archived
          FROM operations o
          JOIN tasks t ON t.id=o.task_id
          LEFT JOIN conversations c ON c.id=t.conversation_id
          WHERE o.state IN ('intent','dispatched')
          ORDER BY o.rowid
        `)
		for _, row := range rows {
			operations = append(operations, RsiOperation{
				Id:             graphDBString(row, "id"),
				TaskId:         graphDBString(row, "taskId"),
				NodeId:         graphDBString(row, "nodeId"),
				State:          graphDBString(row, "state"),
				Request:        graphDBString(row, "request"),
				ConversationId: graphDBStringPtr(row, "conversationId"),
				Archived:       graphDBInt(row, "archived") != 0,
			})
		}
	}()
	return operations, known
}

// rsiSyncState says which local branches are ahead of the copy they were published to, which of those
// are local work lines that are never published, and how many were never published at all.
//
// This exists because unpublished work is otherwise silent: the application line sat 61 commits
// ahead of its remote across several sessions and nothing in the harness said so, so a broken push
// channel looked exactly like a working one.
func (service *RsiService) rsiSyncState(root string, compare bool) *RsiSyncState {
	state := &RsiSyncState{Unpublished: []RsiSyncEntry{}, Expected: []RsiSyncEntry{}}
	heads := Git(root, []string{"for-each-ref", "--format=%(refname:short)", "refs/heads"}, nil, nil)
	if heads.Code != 0 {
		state.Note = "无法读取本地分支，未计算未发布的提交"
		state.deployCompared = compare
		if compare {
			state.Deploy = service.rsiDeployState(root)
		}
		return state
	}
	for _, branch := range strings.Split(heads.Stdout, "\n") {
		name := strings.TrimSpace(branch)
		if name == "" {
			continue
		}
		upstream := "origin/" + name
		if Git(root, []string{"rev-parse", "--verify", "--quiet", "refs/remotes/" + upstream}, nil, nil).Code != 0 {
			state.LocalOnly++
			continue
		}
		counts := Git(root, []string{"rev-list", "--left-right", "--count", "refs/remotes/" + upstream + "..." + name}, nil, nil)
		if counts.Code != 0 {
			continue
		}
		parts := strings.Fields(strings.TrimSpace(counts.Stdout))
		if len(parts) < 2 {
			continue
		}
		behind, behindOK := rsiParseCount(parts[0])
		ahead, aheadOK := rsiParseCount(parts[1])
		if !aheadOK || !behindOK || (ahead == 0 && behind == 0) {
			continue
		}
		entry := RsiSyncEntry{Branch: name, Upstream: upstream, Ahead: ahead, Behind: behind}
		if strings.HasPrefix(name, "rsi/") {
			state.Expected = append(state.Expected, entry)
		} else {
			state.Unpublished = append(state.Unpublished, entry)
		}
	}
	sort.Slice(state.Unpublished, func(left, right int) bool { return state.Unpublished[left].Branch < state.Unpublished[right].Branch })
	sort.Slice(state.Expected, func(left, right int) bool { return state.Expected[left].Branch < state.Expected[right].Branch })
	// Debt first when there is any, so the actionable line is never buried behind a standing one.
	parts := []string{}
	if len(state.Unpublished) > 0 {
		entries := []string{}
		for _, item := range state.Unpublished {
			entries = append(entries, item.Branch+" 领先 "+item.Upstream+" "+itoa(item.Ahead)+" 个提交")
		}
		parts = append(parts, "未发布："+strings.Join(entries, "；"))
	} else {
		parts = append(parts, "没有未发布的已发布分支")
	}
	if len(state.Expected) > 0 {
		entries := []string{}
		for _, item := range state.Expected {
			entries = append(entries, item.Branch+" 领先 "+item.Upstream+" "+itoa(item.Ahead)+" 个提交")
		}
		parts = append(parts, "本机自改进线按设计不推送："+strings.Join(entries, "；"))
	}
	if state.LocalOnly > 0 {
		parts = append(parts, "另有 "+itoa(state.LocalOnly)+" 个本地分支从未发布")
	}
	state.Note = strings.Join(parts, "；")
	state.deployCompared = compare
	if compare {
		state.Deploy = service.rsiDeployState(root)
	}
	return state
}

// rsiParseCount reads one ahead/behind count.
func rsiParseCount(value string) (int, bool) {
	number := 0
	if value == "" {
		return 0, false
	}
	for _, symbol := range value {
		if symbol < '0' || symbol > '9' {
			return 0, false
		}
		number = number*10 + int(symbol-'0')
	}
	return number, true
}

// rsiDeployState compares the checkout with the development line, when there is one to compare with.
//
// Several checkouts of the same repository can sit in one place; the one this checkout still agrees
// with most closely is the useful answer, and it is named in the note so the reader knows which.
func (service *RsiService) rsiDeployState(root string) *DeployDrift {
	drifts := []DeployDrift{}
	for _, candidate := range DevelopmentCandidates(root, nil) {
		drifts = append(drifts, DeployDriftOf(root, candidate))
	}
	if len(drifts) == 0 {
		return nil
	}
	sort.SliceStable(drifts, func(left, right int) bool {
		return len(drifts[left].Files)+len(drifts[left].Missing)+len(drifts[left].Extra) <
			len(drifts[right].Files)+len(drifts[right].Missing)+len(drifts[right].Extra)
	})
	drift := drifts[0]
	return &drift
}

// rsiUnavailableReason says why the service cannot work.
func (service *RsiService) rsiUnavailableReason() string {
	if service.Root == nil {
		return "No Graph source checkout was found. Set GRAPH_RSI_ROOT to the checkout the app runs from."
	}
	if _, err := os.Stat(filepath.Join(*service.Root, "package.json")); err != nil {
		return *service.Root + " has no package.json, so it is not a Graph source checkout."
	}
	return *service.Root + " is not a Git checkout root; run Graph from a source checkout to enable self-improvement."
}

// AckRestart clears a pending restart once the host has actually reloaded the daemon for
// that exact request. A stale id never clears a newer request, so a crashed
// restart keeps its intent instead of silently dropping it.
func (service *RsiService) AckRestart(id string, store *TaskStore) RsiAckRestart {
	current := service.rsiReadRestart()
	if current == nil || current.Id != id {
		return RsiAckRestart{Cleared: false, PendingRestart: current}
	}
	generation := int(rsiRuntimeGeneration(store))
	// A matching HTTP response alone is not proof: the daemon must have
	// restarted onto the requested commit, rather than still running old code.
	if current.Root != rsiStringValue(service.Root) || !rsiSameOptional(current.Commit, service.runningCommit) ||
		(current.Generation != nil && int64(generation) <= *current.Generation) {
		return RsiAckRestart{Cleared: false, PendingRestart: current}
	}
	confirmed := RsiLastActivation{Id: id, Commit: current.Commit, ConfirmedAt: NowMillis(), Generation: generation}
	confirmedGeneration := int64(confirmed.Generation)
	store.Transaction(func() any {
		messages := kernelRows(store.Db, "SELECT id,conversation_id,text,data FROM messages WHERE kind='rsi' AND json_extract(data,'$.id')=?", id)
		for _, message := range messages {
			conversationID := graphDBString(message, "conversation_id")
			messageID := graphDBString(message, "id")
			receipt := RsiReceipt{}
			if err := json.Unmarshal([]byte(graphDBString(message, "data")), &receipt); err != nil {
				continue
			}
			if receipt.Activation != nil && receipt.Activation.State == "active" {
				continue
			}
			receipt.Activation = &RsiReceiptActivation{State: "active", ConfirmedAt: &confirmed.ConfirmedAt, Generation: &confirmedGeneration}
			receipt.Report = graphDBString(message, "text") + "\n\n- 重载已确认：提交 " + rsiStringValue(current.Commit) + " 已生效。"
			AppendMessage(store, MessageInput{
				ConversationID: conversationID, MessageID: &messageID, Role: "system", Kind: "rsi",
				Text: receipt.Report, Data: receipt, State: "done",
			})
			taskID := graphDBString(kernelRow(store.Db, "SELECT anchor_task_id FROM conversations WHERE id=?", conversationID), "anchor_task_id")
			store.Event(taskID, "rsi.activated", confirmed)
		}
		ConfirmRsiContinuation(store, id)
		return nil
	})
	encoded, err := json.Marshal(confirmed)
	if err != nil {
		panic(err)
	}
	if err := rsiWriteAtomic(filepath.Join(service.stateDir, "rsi", "activated.json"), string(encoded)); err != nil {
		panic(err)
	}
	_ = os.Remove(service.rsiRestartPath())
	return RsiAckRestart{Cleared: true, PendingRestart: nil}
}

// rsiRuntimeGeneration reads the runtime generation the daemon counts reloads with.
func rsiRuntimeGeneration(store *TaskStore) int64 {
	row := kernelRow(store.Db, "SELECT generation FROM runtime")
	if row == nil {
		return 0
	}
	return graphDBInt(row, "generation")
}

// rsiStringValue is the value of an optional string, or the empty string.
func rsiStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// rsiSameOptional compares two optional strings the way TypeScript compares `string | null`.
func rsiSameOptional(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// Apply validates and applies one self-improvement change.
func (service *RsiService) Apply(input any, context RsiApplyContext) RsiReceipt {
	service.mu.Lock()
	if service.changing {
		service.mu.Unlock()
		Raise("rsi_busy", "Another RSI change is still being validated.")
	}
	service.changing = true
	service.mu.Unlock()
	defer func() {
		service.mu.Lock()
		service.changing = false
		service.mu.Unlock()
	}()
	normalized := RsiChangeInputOf(input)
	return service.rsiApplyChange(normalized, context)
}

// rsiApplyChange writes the files, runs the gate and commits.
func (service *RsiService) rsiApplyChange(input RsiChangeInput, context RsiApplyContext) (receipt RsiReceipt) {
	title := input.Title
	activate := input.Activate != nil && *input.Activate
	checks := input.Checks
	id := graphUUID()
	root := service.Root
	if !service.Available || root == nil {
		errorText := service.rsiUnavailableReason()
		failure := RsiReceipt{
			Id: id, Status: "unavailable", Title: title, Root: nil, Branch: nil, Commit: nil,
			Files: []string{}, Validation: []RsiValidationResult{}, RestartRequired: false,
			Error: &errorText,
		}
		failure.Report = rsiUnavailableReport(input, nil, errorText)
		service.rsiRecord(context, failure)
		return failure
	}

	paths := []*string{}
	for _, change := range input.Changes {
		inside, ok := rsiInside(*root, change.Path)
		if !ok {
			paths = append(paths, nil)
			continue
		}
		value := inside
		paths = append(paths, &value)
	}
	for _, path := range paths {
		if path == nil || rsiHasGitComponent(*path) {
			Raise("invalid_input", "RSI paths must stay inside the Graph source root and must not target .git")
		}
	}
	uniquePaths := []string{}
	seen := map[string]bool{}
	for _, path := range paths {
		if !seen[*path] {
			seen[*path] = true
			uniquePaths = append(uniquePaths, *path)
		}
	}
	if len(uniquePaths) != len(paths) {
		Raise("invalid_input", "RSI changes must use unique file paths")
	}
	if service.HasPendingRestart() {
		Raise("rsi_reload_pending", "RSI is waiting for reload confirmation. End this turn before starting another improvement.")
	}

	originalHead := RevParse(*root, "HEAD")
	if originalHead == nil {
		Raise("rsi_unavailable", "Graph source checkout has no Git HEAD")
	}
	originalBranch := CheckedOutBranch(*root)
	branch := "rsi/" + rsiSlug(title) + "-" + id[:8]
	if originalBranch != nil && strings.HasPrefix(*originalBranch, "rsi/") {
		branch = *originalBranch
	}

	// A failed attempt keeps its files uncommitted so the Agent can keep fixing
	// them. Those paths stay editable; unrelated user edits still block.
	working := service.rsiReadWorking()
	owned := map[string]bool{}
	ownedOrder := []string{}
	if working != nil && working.Branch == branch {
		for _, path := range working.Paths {
			if !owned[path] {
				owned[path] = true
				ownedOrder = append(ownedOrder, path)
			}
		}
	}
	// An empty change list is valid when there is pending work to re-check or a
	// custom check to run; the default validation always runs anyway.
	if len(input.Changes) == 0 && len(checks) == 0 && len(owned) == 0 {
		Raise("invalid_input", "Provide at least one file change or one check to run")
	}
	// Checks run against the whole working tree, so a green run only proves the commit when the
	// commit contains everything that was dirty while they ran. Anything else is refused up front
	// instead of being silently left out of the commit that gets reported as verified.
	blocked := []string{}
	for _, path := range rsiDirtyPaths(*root) {
		if !owned[path] {
			blocked = append(blocked, path)
		}
	}
	if len(blocked) > 0 {
		Raise("rsi_dirty", RsiDirtyMessage(*root, blocked))
	}

	createdBranch := false
	if originalBranch == nil || branch != *originalBranch {
		switched := Git(*root, []string{"switch", "-c", branch}, nil, nil)
		if switched.Code != 0 {
			Raise("rsi_git", rsiFirstText(switched.Stderr, "Failed to create "+branch))
		}
		createdBranch = true
	}

	snapshotOrder := []string{}
	snapshots := map[string]*string{}
	finalOrder := []string{}
	final := map[string]*string{}

	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		for _, path := range snapshotOrder {
			content := snapshots[path]
			absolute := filepath.Join(*root, path)
			if content == nil {
				_ = os.Remove(absolute)
				continue
			}
			_ = os.MkdirAll(filepath.Dir(absolute), 0o700)
			_ = os.WriteFile(absolute, []byte(*content), 0o644)
		}
		// Restoring the files leaves the index alone, and an index entry outlives the attempt that made it:
		// `git add -A -- good ignored` stages the good path and then fails on the ignored one, so a
		// rolled-back call used to leave `A good` behind - which the next attempt reads as somebody else's
		// uncommitted work and refuses to run. The harness never starts with unowned dirty paths, so
		// resetting these can only undo our own staging.
		touched := []string{}
		touchedSeen := map[string]bool{}
		for _, path := range append(append([]string{}, uniquePaths...), ownedOrder...) {
			if !touchedSeen[path] {
				touchedSeen[path] = true
				touched = append(touched, path)
			}
		}
		if len(touched) > 0 {
			Git(*root, append([]string{"reset", "-q", "--"}, touched...), nil, nil)
		}
		// Restore only what this attempt wrote; keep files a prior failed attempt
		// still owns so its fix is not lost either.
		if len(owned) > 0 {
			_ = service.rsiWriteWorking(branch, ownedOrder)
		} else {
			_ = os.Remove(service.rsiWorkingPath())
		}
		if createdBranch && originalBranch != nil && len(owned) == 0 {
			Git(*root, []string{"switch", *originalBranch}, nil, nil)
			Git(*root, []string{"branch", "-D", branch}, nil, nil)
		}
		message := rsiPanicMessage(recovered)
		failure := RsiReceipt{
			Id: id, Status: "rolled_back", Title: title, Root: root, Branch: originalBranch, Commit: nil,
			Files: uniquePaths, Validation: []RsiValidationResult{}, RestartRequired: false,
			Error: &message,
		}
		failure.Report = rsiFailureReport(input, root, message, nil)
		service.rsiRecord(context, failure)
		receipt = failure
	}()

	for _, change := range input.Changes {
		path, _ := rsiInside(*root, change.Path)
		absolute := filepath.Join(*root, path)
		existing, known := snapshots[path]
		if !known {
			content, err := os.ReadFile(absolute)
			if err != nil {
				if !os.IsNotExist(err) {
					panic(err)
				}
				existing = nil
			} else {
				value := string(content)
				existing = &value
			}
			snapshots[path] = existing
			snapshotOrder = append(snapshotOrder, path)
		}
		switch change.Action {
		case "write":
			value := *change.Content
			if _, seen := final[path]; !seen {
				finalOrder = append(finalOrder, path)
			}
			final[path] = &value
		case "copy":
			shown := GitRaw(*root, []string{"show", *change.From + ":" + path}, nil, nil)
			if shown.Code != 0 {
				detail := ""
				if trimmed := strings.TrimSpace(shown.Stderr); trimmed != "" {
					detail = ": " + strings.Split(trimmed, "\n")[0]
				}
				Raise("rsi_edit_conflict", "RSI copy of "+path+" from "+*change.From+" found no such file in that revision"+
					detail+"；检查两边是不是同一个仓库（13-Graph 与 live 检出是同一仓库的链接 worktree，对方的提交直接可见）")
			}
			value := shown.Stdout
			if _, seen := final[path]; !seen {
				finalOrder = append(finalOrder, path)
			}
			final[path] = &value
		case "delete":
			if _, seen := final[path]; !seen {
				finalOrder = append(finalOrder, path)
			}
			final[path] = nil
		default:
			if existing == nil {
				Raise("not_found", "Cannot replace missing RSI file "+path)
			}
			content := *existing
			for index, edit := range change.Edits {
				matches := strings.Count(content, edit.OldText)
				if matches != 1 {
					// A batch rolls back as a whole, so name the edit that failed: the
					// caller has to know which oldText to correct without guessing.
					head := strings.TrimSpace(strings.Split(edit.OldText, "\n")[0])
					runes := []rune(head)
					if len(runes) > 90 {
						head = string(runes[:90])
					}
					// Which state the anchor was matched against is the part the caller cannot see: a failed
					// attempt keeps its files uncommitted, so the committed text is already gone from the
					// worktree and "found 0" on its own reads like a typo instead of a stale anchor.
					hint := ""
					if owned[path] {
						hint = "；该文件当前是上一轮未提交（检查失败保留）的内容：oldText 要按它现在的样子匹配，或改用 action \"write\" 直接给全文"
					}
					Raise("rsi_edit_conflict", "RSI replacement in "+path+" must match exactly once, found "+itoa(matches)+
						" (edit "+itoa(index+1)+" of "+itoa(len(change.Edits))+", first line: "+head+")"+hint)
				}
				content = strings.Replace(content, edit.OldText, edit.NewText, 1)
			}
			value := content
			if _, seen := final[path]; !seen {
				finalOrder = append(finalOrder, path)
			}
			final[path] = &value
		}
	}

	for _, path := range finalOrder {
		content := final[path]
		absolute := filepath.Join(*root, path)
		if content == nil {
			_ = os.Remove(absolute)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
			panic(err)
		}
		if err := os.WriteFile(absolute, []byte(*content), 0o644); err != nil {
			panic(err)
		}
	}

	// `app:build` only matters when the served page or the desktop package can move; a runtime-only
	// change is fully covered by `node --run check`, and rebuilding would overwrite the bundle the
	// running window serves with this checkout's own build.
	var changedPaths []string
	if service.runningCommit != nil {
		changedPaths = rsiChangedSince(*root, *service.runningCommit)
	}
	relevant := append([]string{}, uniquePaths...)
	relevant = append(relevant, ownedOrder...)
	relevant = append(relevant, changedPaths...)
	needsBuild := changedPaths == nil || rsiBuildRelevant(relevant)
	raw := service.validate(RsiValidateInput{Root: *root, Checks: checks, Activate: activate, NeedsBuild: needsBuild})
	outputPath := service.rsiWriteReportFile(id, raw)
	validation := []RsiValidationResult{}
	for _, item := range raw {
		validation = append(validation, rsiSummarizeValidation(item))
	}
	failed := false
	for _, item := range validation {
		if item.Status == "failed" {
			failed = true
			break
		}
	}
	if failed {
		// Keep the working tree so the Agent can iterate; a flaky or genuinely
		// failing check must not discard the change.
		pendingFiles := []string{}
		pendingSeen := map[string]bool{}
		for _, path := range append(append([]string{}, ownedOrder...), uniquePaths...) {
			if !pendingSeen[path] {
				pendingSeen[path] = true
				pendingFiles = append(pendingFiles, path)
			}
		}
		sort.Strings(pendingFiles)
		_ = service.rsiWriteWorking(branch, pendingFiles)
		failure := RsiReceipt{
			Id: id, Status: "checks_failed", Title: title, Root: root, Branch: &branch, Commit: nil,
			Files: uniquePaths, Validation: validation, RestartRequired: false,
			PendingFiles: pendingFiles, OutputPath: &outputPath,
		}
		failure.Report = rsiChecksFailedReport(input, failure)
		service.rsiRecord(context, failure)
		return failure
	}

	// The checks just ran against the working tree, so they verified every path that is dirty
	// here: a run that leaves the checkout dirty must not be committed as if it were green.
	// Paths this attempt wrote are expected to be dirty; anything else was verified by the checks
	// but would stay out of the commit, so the green run must not become a commit.
	unverified := []string{}
	for _, path := range rsiDirtyPaths(*root) {
		if !owned[path] && !seen[path] {
			unverified = append(unverified, path)
		}
	}
	if len(unverified) > 0 {
		Raise("rsi_dirty", RsiDirtyMessage(*root, unverified))
	}

	// Commit every path this attempt or a prior attempt owns, so a checks-only
	// re-run still lands the pending files. Stage only paths that exist now or
	// were tracked before, so a delete of a never-tracked file cannot fail.
	commitPaths := []string{}
	commitSeen := map[string]bool{}
	for _, path := range append(append([]string{}, uniquePaths...), ownedOrder...) {
		if !commitSeen[path] {
			commitSeen[path] = true
			commitPaths = append(commitPaths, path)
		}
	}
	sort.Strings(commitPaths)
	tracked := map[string]bool{}
	for _, path := range strings.Split(Git(*root, append([]string{"ls-files", "--"}, commitPaths...), nil, nil).Stdout, "\n") {
		if path != "" {
			tracked[path] = true
		}
	}
	stagePaths := []string{}
	for _, path := range commitPaths {
		if tracked[path] {
			stagePaths = append(stagePaths, path)
			continue
		}
		if _, err := os.Stat(filepath.Join(*root, path)); err == nil {
			stagePaths = append(stagePaths, path)
		}
	}
	commit := RevParse(*root, "HEAD")
	committedNow := false
	if len(stagePaths) > 0 {
		staged := Git(*root, append([]string{"add", "-A", "--"}, stagePaths...), nil, nil)
		if staged.Code != 0 {
			Raise("rsi_git", rsiFirstText(staged.Stderr, "Failed to stage RSI changes"))
		}
		committed := Git(*root, append([]string{"commit", "--no-verify", "-m", "rsi: " + title, "--"}, stagePaths...), nil, nil)
		if committed.Code != 0 {
			Raise("rsi_git", rsiFirstText(committed.Stderr, "Failed to commit RSI changes"))
		}
		commit = RevParse(*root, "HEAD")
		if commit == nil {
			Raise("rsi_git", "RSI commit did not produce a HEAD")
		}
		committedNow = true
	}
	_ = os.Remove(service.rsiWorkingPath())

	// Activation exists to put a new commit into the running daemon. When this call committed
	// nothing and the daemon already runs HEAD (a checks-only re-run, for example), a reload would
	// only interrupt the user, so it is skipped and reported as such.
	live := commit != nil && service.runningCommit != nil && *commit == *service.runningCommit
	restartRequired := activate && !live
	if restartRequired {
		generation := rsiRuntimeGeneration(context.Store)
		if err := service.rsiWriteRestart(id, *root, branch, commit, NowMillis(), int(generation), input.Force); err != nil {
			panic(err)
		}
	}
	var diff *string
	if committedNow && commit != nil {
		diff = rsiDiffFor(*root, *commit)
	}
	described := DescribeActivation(RsiActivationInput{Commit: commit, CommittedNow: committedNow, Activate: activate, Live: live})
	applied := RsiReceipt{
		Id: id, Status: "applied", Title: title, Root: root, Branch: &branch, Commit: commit,
		Files: stagePaths, Validation: validation, RestartRequired: restartRequired,
		Activation: &RsiReceiptActivation{State: described.State},
		OutputPath: &outputPath,
	}
	if input.Force {
		applied.Force = true
	}
	if diff != nil {
		applied.Diff = diff
	}
	applied.Report = rsiSuccessReport(input, applied, described.Note)
	service.rsiRecord(context, applied)
	return applied
}

// rsiHasGitComponent reports whether a path names the .git directory.
func rsiHasGitComponent(path string) bool {
	for _, part := range strings.Split(path, "/") {
		if part == ".git" {
			return true
		}
	}
	return false
}

// rsiFirstText is the first nonempty text.
func rsiFirstText(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

// rsiPanicMessage is the message of a recovered failure.
func rsiPanicMessage(recovered any) string {
	switch err := recovered.(type) {
	case *RuntimeError:
		return err.Message
	case error:
		return err.Error()
	default:
		return fmt.Sprint(recovered)
	}
}

// rsiRecord writes the receipt into the conversation and the event log.
func (service *RsiService) rsiRecord(context RsiApplyContext, receipt RsiReceipt) {
	context.Store.Transaction(func() any {
		if receipt.RestartRequired && receipt.Commit != nil && context.OperationId != nil {
			AwaitRsiReload(context.Store, receipt.Id, *context.OperationId, *receipt.Commit)
		}
		context.Store.Event(context.TaskId, "rsi.change", receipt)
		conversationID := ""
		if context.ConversationId != nil {
			conversationID = *context.ConversationId
		} else {
			conversation := ConversationForTask(context.Store, context.TaskId)
			if conversation == nil {
				return nil
			}
			conversationID = conversation.Id
		}
		AppendMessage(context.Store, MessageInput{
			ConversationID: conversationID, Role: "system", Kind: "rsi",
			OperationID: context.OperationId, Text: receipt.Report, Data: receipt, State: "done",
		})
		// Scheduling a reload drains the daemon, which can close the Agent process
		// before the turn settles. The turn's visible receipt is therefore written
		// here, while the reload is only requested, so the user always sees the
		// outcome of the change and never has to ask for it again.
		if receipt.RestartRequired {
			AppendMessage(context.Store, MessageInput{
				ConversationID: conversationID, Role: "assistant", Kind: "chat",
				OperationID: context.OperationId, Text: RSI_RELOAD_RECEIPT,
				Data: map[string]any{"reloadReceipt": true}, State: "done",
			})
			MarkOperationReplied(context.Store, context.OperationId)
		}
		return nil
	})
}

// RsiChangeShapeHint answers the model's own mistakes about the shape of `changes[]`, in its terms.
//
// The SDK validates the call before this service sees it and prints every schema fact it finds
// (`changes.0.path: must have required properties path`, followed by the received arguments) - accurate,
// and never a word about what went wrong: a top-level field nested one level too deep, or a whole change
// written inside `edits[]`. A missing `path` is answered here too: it measured as the single most frequent
// mistake (a `replace` entry carrying `edits` drops it), and the schema's wording never names the entry it
// lost. Everything else that is only a field problem stays the schema's business.
//
// The empty string means the shape is fine.
func RsiChangeShapeHint(args any) string {
	top := rsiPlainObject(args)
	if top == nil {
		return ""
	}
	topLevel := []string{"title", "problem", "evidence", "diagnosis", "impact", "risk", "checks", "activate", "force"}
	changeKeys := []string{"path", "action", "content", "edits", "from"}
	for index, change := range rsiAsArray(top["changes"]) {
		if rsiIsArray(change) {
			return "changes[" + itoa(index) + "] is an array: changes[] holds one object per file - flatten it."
		}
		entry := rsiPlainObject(change)
		if entry == nil {
			continue
		}
		stray := ""
		for _, key := range topLevel {
			if rsiHasOwn(entry, key) {
				stray = key
				break
			}
		}
		if stray != "" {
			return "changes[" + itoa(index) + "] is one file change: {path, action, content, edits}. \"" + stray +
				"\" belongs at the top level of the call - it is nested one level too deep."
		}
		// Every change needs a path, whatever its action. The measured mistake is a `replace` entry that
		// carries `edits` and quietly drops `path`, and the SDK answers only "must have required
		// properties path" - no index, no shape, so the same call comes back. Name it here instead.
		if _, ok := entry["path"].(string); !ok {
			return "changes[" + itoa(index) + "] is missing \"path\": every change needs one path per file. Write it as " +
				"{path, action: \"write\", content} | {path, action: \"replace\", edits: [{oldText, newText}]}" +
				" | {path, action: \"copy\", from: \"<revision>\"} | {path, action: \"delete\"}."
		}
		// A mirror names a revision instead of retyping content. Shape mistakes in that one field are
		// answered here, before any file is touched, by the same rule the parser enforces.
		if rsiText(entry["action"]) == "copy" {
			if refusal := RevisionRefusal(entry["from"]); refusal != "" {
				return "changes[" + itoa(index) + "].from " + refusal
			}
		}
		for editIndex, edit := range rsiAsArray(entry["edits"]) {
			if rsiIsArray(edit) {
				return "changes[" + itoa(index) + "].edits[" + itoa(editIndex) +
					"] is an array: edits[] holds one {oldText, newText} per edit - flatten it."
			}
			edited := rsiPlainObject(edit)
			if edited == nil {
				continue
			}
			nested := ""
			for _, key := range changeKeys {
				if rsiHasOwn(edited, key) {
					nested = key
					break
				}
			}
			if nested != "" {
				return "changes[" + itoa(index) + "].edits[" + itoa(editIndex) +
					"] is one edit: {oldText, newText}. A change object {path, action, ...} belongs in changes[], not inside edits[] - one change is nested inside another."
			}
		}
	}
	for index, check := range rsiAsArray(top["checks"]) {
		entry := rsiPlainObject(check)
		if entry == nil {
			continue
		}
		for _, key := range changeKeys {
			if rsiHasOwn(entry, key) {
				return "checks[" + itoa(index) + "] is one check: {command, args}. A file change belongs in changes[], not in checks[]."
			}
		}
	}
	return ""
}
