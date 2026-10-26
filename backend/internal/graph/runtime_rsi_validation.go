package graph

import (
	"context"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"bytes"
)

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
