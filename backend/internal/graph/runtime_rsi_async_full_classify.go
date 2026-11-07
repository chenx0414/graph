package graph

import (
	"encoding/json"
	"os"
	"regexp"
	"sort"
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
	Unmatched   []string
}

var (
	asyncFullFailLine = regexp.MustCompile(`^\s*FAIL\s+(tests/\S+)\s*>\s*(.+?)\s*$`)
	asyncFullTestLine = regexp.MustCompile(`^\s*×\s*(.+?)\s+—\s*(.*)$`)
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
	messages := map[string]string{}
	failures := []AsyncFullFailure{}
	seen := map[string]bool{}
	for _, line := range strings.Split(clean, "\n") {
		if match := asyncFullFailLine.FindStringSubmatch(line); match != nil {
			test := strings.TrimSpace(match[2])
			if seen[test] {
				continue
			}
			seen[test] = true
			failures = append(failures, AsyncFullFailure{File: strings.TrimSpace(match[1]), Test: test})
			continue
		}
		if match := asyncFullTestLine.FindStringSubmatch(line); match != nil {
			test := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(match[1]), "[timing] "))
			if _, found := messages[test]; !found {
				messages[test] = strings.TrimSpace(match[2])
			}
		}
	}
	for index := range failures {
		failures[index].Message = messages[failures[index].Test]
	}
	extra := []string{}
	for test := range messages {
		if !seen[test] {
			extra = append(extra, test)
		}
	}
	sort.Strings(extra)
	for _, test := range extra {
		failures = append(failures, AsyncFullFailure{Test: test, Message: messages[test]})
	}
	return failures
}

func ClassifyAsyncFull(output string, known []EnvKnownRed) AsyncFullVerdict {
	verdict := AsyncFullVerdict{Environment: true, Unmatched: []string{}}
	failures := AsyncFullFailures(output)
	if len(failures) == 0 {
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
