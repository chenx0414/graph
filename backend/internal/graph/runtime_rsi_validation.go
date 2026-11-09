package graph

import (
	"context"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"bytes"
)

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

func rsiRunCommand(root string, command RsiCommand, timeoutMs int) RsiValidationResult {
	resolved := ValidationCommand(command, nil)
	label := strings.Join(append([]string{command.Command}, command.Args...), " ")
	executable, args := resolved.Executable, resolved.Args
	if command.Nice > 0 {
		if nice, err := exec.LookPath("nice"); err == nil {
			executable = nice
			args = append([]string{"-n", strconv.Itoa(command.Nice), resolved.Executable}, resolved.Args...)
			label = "nice -n " + strconv.Itoa(command.Nice) + " " + label
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	process := exec.CommandContext(ctx, executable, args...)
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
		return RsiValidationResult{Command: label, Status: "failed", Output: rsiCommandOutput("", err.Error())}
	}
	return RsiValidationResult{Command: label, Status: "failed", Output: rsiCommandOutput(stdout.String(), stderr.String())}
}

func rsiSummarizeValidation(result RsiValidationResult) RsiValidationResult {
	if result.Status == "passed" {
		result.Output = ""
	}
	return result
}

func rsiNeedsWebBuild(paths []string) bool {
	for _, path := range paths {
		if strings.HasPrefix(path, "src/web/") || path == "index.html" || strings.HasPrefix(path, "vite.config") {
			return true
		}
	}
	return false
}

func rsiNeedsAppBuild(paths []string) bool {
	for _, path := range paths {
		if strings.HasPrefix(path, "desktop/") || path == "package.json" ||
			path == "scripts/package-app.mjs" || strings.HasPrefix(path, "build/") {
			return true
		}
	}
	return false
}

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

func rsiRunCheckWithEnvironmentRetry(root string, command RsiCommand, timeoutMs int) RsiValidationResult {
	first := rsiRunCommand(root, command, timeoutMs)
	if first.Status != "failed" || !rsiEnvironmentFailureAtTheEnd(first.Output) {
		return first
	}
	label := command.Command + " " + strings.Join(command.Args, " ")
	retry := rsiRunCommand(root, command, timeoutMs)
	if retry.Status == "passed" {
		return RsiValidationResult{Command: retry.Command, Status: retry.Status,
			Output: label + " 第一次因环境/网络故障失败，已自动重跑一次并成功（与改动无关）。\n" + retry.Output}
	}
	return RsiValidationResult{Command: retry.Command, Status: retry.Status, Environment: true,
		Output: label + " 连续两次失败，其中至少一次是环境/网络问题，而不是改动本身。\n--- 第一次 ---\n" + first.Output + "\n--- 第二次 ---\n" + retry.Output}
}

func rsiEnvironmentFailureAtTheEnd(output string) bool {
	const tailLength = 4_000
	tail := output
	if len(tail) > tailLength {
		tail = tail[len(tail)-tailLength:]
	}
	return IsEnvironmentFailure(tail)
}

func rsiDefaultValidate(input RsiValidateInput) []RsiValidationResult {
	results := []RsiValidationResult{}
	for _, check := range input.Checks {
		result := rsiRunCheckWithEnvironmentRetry(input.Root, check, RSI_CHECK_TIMEOUT_MS)
		results = append(results, result)
		if result.Status == "failed" {
			return results
		}
	}
	if len(input.Checks) > 0 && !input.Activate {
		return results
	}
	if rsiNeedsDefaultGate(input.Checks, input.Activate) {
		check := rsiRunCheckWithEnvironmentRetry(input.Root, RsiCommand{Command: "node", Args: []string{"--run", "check"}}, RSI_CHECK_TIMEOUT_MS)
		results = append(results, check)
		if check.Status == "failed" || !input.Activate {
			return results
		}
	} else if !input.Activate {
		return results
	}
	if input.NeedsAppBuild {
		build := rsiRunCheckWithEnvironmentRetry(input.Root, RsiCommand{Command: "node", Args: []string{"--run", "app:build"}}, RSI_BUILD_TIMEOUT_MS)
		return append(results, build)
	}
	if input.NeedsWebBuild {
		web := rsiRunCheckWithEnvironmentRetry(input.Root, RsiCommand{Command: "node", Args: []string{"--run", "build:web"}}, RSI_BUILD_TIMEOUT_MS)
		return append(results, web)
	}
	return results
}

func rsiNeedsDefaultGate(checks []RsiCommand, activate bool) bool {
	if !activate {
		return false
	}
	for _, check := range checks {
		if check.Command == "node" && len(check.Args) == 2 && check.Args[0] == "--run" && check.Args[1] == "check" {
			return false
		}
	}
	return true
}


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
