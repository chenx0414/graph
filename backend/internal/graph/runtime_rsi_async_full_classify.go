package graph

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
)

type EnvKnownRed struct {
	File    string `json:"file"`
	Pattern string `json:"pattern"`
	Why     string `json:"why"`
}

type EnvKnownRedList struct {
	Version int           `json:"version"`
	Reds    []EnvKnownRed `json:"reds"`
}

type AsyncFullFailure struct {
	File    string
	Test    string
	Message string
}

type AsyncFullVerdict struct {
	Environment bool
	Reason      string
	Unmatched   []string
	Flaky       []string
}

var (
	asyncFullFailLine   = regexp.MustCompile(`^\s*FAIL\s+(tests/\S+)\s*>\s*(.+?)\s*$`)
	asyncFullTestLine   = regexp.MustCompile(`^\s*×\s*(.+?)\s+—\s*(.*)$`)
	asyncFullRunnerFile = regexp.MustCompile(`^\s*-\s+(tests/\S+\.test\.ts)\s*$`)
	asyncFullRerunFile  = regexp.MustCompile(`failed once and passed on a re-run:\s*(tests/\S+\.test\.ts)`)
	asyncFullGoFailTest = regexp.MustCompile(`^--- FAIL: (\S+)`)
	asyncFullGoMessage  = regexp.MustCompile(`^\s+(\S+_test\.go:\d+: .*)$`)
	asyncFullGoPackage  = regexp.MustCompile(`^FAIL\s+(\S+)\s+[0-9.]+s`)
)

func LoadEnvKnownReds(path string) ([]EnvKnownRed, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []EnvKnownRed{}, nil
		}
		return nil, err
	}
	list := EnvKnownRedList{}
	if err := json.Unmarshal(content, &list); err != nil {
		return nil, err
	}
	reds := []EnvKnownRed{}
	for _, red := range list.Reds {
		if red.File == "" || red.Pattern == "" {
			continue
		}
		reds = append(reds, red)
	}
	return reds, nil
}

func AsyncFullFailures(output string) []AsyncFullFailure {
	clean := rsiEscapeCode.ReplaceAllString(output, "")
	files := []string{}
	fileSeen := map[string]bool{}
	headers := map[string]string{}
	messages := map[string]string{}
	order := []string{}
	goPackages := []string{}
	for _, line := range strings.Split(clean, "\n") {
		if match := asyncFullFailLine.FindStringSubmatch(line); match != nil {
			headers[strings.TrimSpace(match[2])] = strings.TrimSpace(match[1])
			continue
		}
		if match := asyncFullRunnerFile.FindStringSubmatch(line); match != nil {
			file := strings.TrimSpace(match[1])
			if !fileSeen[file] {
				fileSeen[file] = true
				files = append(files, file)
			}
			continue
		}
		if match := asyncFullGoFailTest.FindStringSubmatch(strings.TrimSpace(line)); match != nil {
			test := strings.TrimSpace(match[1])
			if _, found := headers[test]; !found {
				headers[test] = ""
			}
			if _, found := messages[test]; !found {
				order = append(order, test)
			}
			continue
		}
		if match := asyncFullGoMessage.FindStringSubmatch(line); match != nil {
			message := strings.TrimSpace(match[1])
			file := strings.SplitN(message, ":", 2)[0]
			for index := len(order) - 1; index >= 0; index-- {
				if messages[order[index]] == "" {
					messages[order[index]] = message
					headers[order[index]] = file
					break
				}
			}
			continue
		}
		if match := asyncFullGoPackage.FindStringSubmatch(line); match != nil {
			pkg := strings.TrimSpace(match[1])
			goPackages = append(goPackages, pkg)
			continue
		}
		if match := asyncFullTestLine.FindStringSubmatch(line); match != nil {
			test := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(match[1]), "[timing] "))
			if _, found := messages[test]; !found {
				messages[test] = strings.TrimSpace(match[2])
				order = append(order, test)
			}
		}
	}
	for _, test := range order {
		if headers[test] == "" && len(goPackages) > 0 {
			headers[test] = goPackages[0]
		}
	}
	failures := []AsyncFullFailure{}
	attributed := map[string]bool{}
	for _, test := range order {
		message := messages[test]
		file := headers[test]
		if file == "" {
			file = asyncFullFileInMessage(message, files)
		}
		if file != "" {
			attributed[file] = true
		}
		failures = append(failures, AsyncFullFailure{File: file, Test: test, Message: message})
	}
	if len(order) == 0 {
		for _, pkg := range goPackages {
			failures = append(failures, AsyncFullFailure{File: pkg})
		}
	}
	for _, file := range files {
		if attributed[file] {
			continue
		}
		failures = append(failures, AsyncFullFailure{File: file})
	}
	return failures
}

func asyncFullFileInMessage(message string, files []string) string {
	if message == "" {
		return ""
	}
	for _, file := range files {
		if strings.Contains(message, file) || strings.Contains(message, asyncFullFileStem(file)) {
			return file
		}
	}
	return ""
}

func asyncFullFileStem(file string) string {
	base := file
	if index := strings.LastIndex(base, "/"); index >= 0 {
		base = base[index+1:]
	}
	return strings.TrimSuffix(base, ".test.ts")
}

func AsyncFullReruns(output string) []string {
	clean := rsiEscapeCode.ReplaceAllString(output, "")
	reruns := []string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(clean, "\n") {
		match := asyncFullRerunFile.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		file := strings.TrimSpace(match[1])
		if seen[file] {
			continue
		}
		seen[file] = true
		reruns = append(reruns, file)
	}
	return reruns
}

func ClassifyAsyncFull(output string, known []EnvKnownRed) AsyncFullVerdict {
	verdict := AsyncFullVerdict{Environment: true, Unmatched: []string{}, Flaky: []string{}}
	if reason := MachineExhaustionReason(output); reason != "" {
		verdict.Reason = reason
		verdict.Flaky = AsyncFullReruns(output)
		return verdict
	}
	flaky := map[string]bool{}
	for _, file := range AsyncFullReruns(output) {
		flaky[file] = true
		verdict.Flaky = append(verdict.Flaky, file)
	}
	failures := []AsyncFullFailure{}
	for _, failure := range AsyncFullFailures(output) {
		if failure.File != "" && flaky[failure.File] {
			continue
		}
		failures = append(failures, failure)
	}
	if len(failures) > 0 && asyncFullAllFilesAccounted(failures, known, flaky) {
		kept := []AsyncFullFailure{}
		for _, failure := range failures {
			if failure.File != "" {
				kept = append(kept, failure)
			}
		}
		failures = kept
	}
	if len(failures) == 0 {
		if len(verdict.Flaky) > 0 {
			return verdict
		}
		if IsEnvironmentFailure(output) {
			return verdict
		}
		verdict.Environment = false
		verdict.Unmatched = append(verdict.Unmatched, "没有解析到失败条目，请读完整日志")
		return verdict
	}
	for _, failure := range failures {
		if _, matched := knownRedFor(failure, known); matched {
			continue
		}
		verdict.Environment = false
		switch {
		case failure.File == "":
			verdict.Unmatched = append(verdict.Unmatched, failure.Test+"（无法确定所属文件）")
		case failure.Message == "":
			verdict.Unmatched = append(verdict.Unmatched, failure.File+" 不在已知环境红名单里")
		default:
			verdict.Unmatched = append(verdict.Unmatched, failure.File+": "+failure.Message)
		}
	}
	return verdict
}

func asyncFullAllFilesAccounted(failures []AsyncFullFailure, known []EnvKnownRed, flaky map[string]bool) bool {
	for _, failure := range failures {
		if failure.File == "" {
			continue
		}
		if flaky[failure.File] {
			continue
		}
		if _, matched := knownRedFor(failure, known); !matched {
			return false
		}
	}
	return true
}

func knownRedFor(failure AsyncFullFailure, known []EnvKnownRed) (EnvKnownRed, bool) {
	for _, red := range known {
		if red.File != failure.File {
			continue
		}
		if failure.Message == "" || strings.Contains(failure.Message, red.Pattern) {
			return red, true
		}
	}
	return EnvKnownRed{}, false
}
