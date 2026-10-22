package graph

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// The two search tools of the native set.
//
// A search answers with the matches it found, and a tree can hold more
// matches than an answer can carry: the walk stops at the limit the call
// asked for, and the answer says what it left out.

// pigFindTool is the SDK's find tool.
func pigFindTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "find",
		Label:       "Find files",
		Description: "Find files by pattern. The answer is truncated to 1000 matches or 50KB, whichever comes first.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{"type": "string", "description": "The pattern the file name must match."},
				"path":    map[string]any{"type": "string", "description": "The directory to search."},
				"limit":   map[string]any{"type": "number", "description": "How many matches to return."},
			},
			"required": []any{"pattern"},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			pattern := agentToolsString(arguments["pattern"])
			if pattern == "" {
				return nil, errors.New("find needs a pattern")
			}
			expression, err := regexp.Compile(pigNativePattern(pattern))
			if err != nil {
				return nil, err
			}
			root := paths.walkRoot(agentToolsString(arguments["path"]))
			found := []string{}
			limit := pigNativeLimit(arguments["limit"], pigNativeFindLimit)
			more := false
			walkErr := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
				if err != nil {
					return nil
				}
				if info.IsDir() {
					if info.Name() == ".git" {
						return filepath.SkipDir
					}
					return nil
				}
				if expression.MatchString(info.Name()) {
					found = append(found, path)
					// The walk stops at the limit: a tree with a million
					// matching files costs the memory of the limit.
					if len(found) >= limit {
						more = true
						return filepath.SkipAll
					}
				}
				return nil
			})
			if walkErr != nil {
				return nil, walkErr
			}
			sort.Strings(found)
			notices := []string{}
			if more {
				notices = append(notices, fmt.Sprintf("%d matches limit reached. Use limit=%d for more", limit, limit*2))
			}
			return agentToolsText(pigNativeRender(found, notices)), nil
		},
	}
}

// pigGrepTool is the SDK's grep tool.
func pigGrepTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "grep",
		Label:       "Search files",
		Description: "Search file contents.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern":    map[string]any{"type": "string", "description": "The text to search for."},
				"path":       map[string]any{"type": "string", "description": "The directory to search."},
				"glob":       map[string]any{"type": "string", "description": "The file name pattern the files must match."},
				"ignoreCase": map[string]any{"type": "boolean", "description": "Whether the search ignores case."},
				"literal":    map[string]any{"type": "boolean", "description": "Whether the pattern is literal text."},
				"context":    map[string]any{"type": "number", "description": "How many lines around a match to return."},
				"limit":      map[string]any{"type": "number", "description": "How many matches to return."},
			},
			"required": []any{"pattern"},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			pattern := agentToolsString(arguments["pattern"])
			if pattern == "" {
				return nil, errors.New("grep needs a pattern")
			}
			expression := pattern
			if !agentToolsTruthy(arguments["literal"]) {
				expression = pigNativePattern(pattern)
			}
			flags := ""
			if agentToolsTruthy(arguments["ignoreCase"]) {
				flags += "i"
			}
			matcher, err := regexp.Compile("(?s)" + flags + expression)
			if err != nil {
				return nil, err
			}
			glob := agentToolsString(arguments["glob"])
			var globMatcher *regexp.Regexp
			if glob != "" {
				globMatcher, err = regexp.Compile(pigNativePattern(glob))
				if err != nil {
					return nil, err
				}
			}
			root := paths.walkRoot(agentToolsString(arguments["path"]))
			context := pigNativeNumber(arguments["context"])
			limit := pigNativeLimit(arguments["limit"], pigNativeGrepLimit)
			matches := []string{}
			found := 0
			more := false
			walkErr := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
				if err != nil {
					return nil
				}
				if info.IsDir() {
					if info.Name() == ".git" {
						return filepath.SkipDir
					}
					return nil
				}
				if globMatcher != nil && !globMatcher.MatchString(info.Name()) {
					return nil
				}
				body, err := os.ReadFile(path)
				if err != nil {
					return nil
				}
				lines := strings.Split(string(body), "\n")
				for index, line := range lines {
					if !matcher.MatchString(line) {
						continue
					}
					found++
					start := index - context
					if start < 0 {
						start = 0
					}
					end := index + context
					if end >= len(lines) {
						end = len(lines) - 1
					}
					for number := start; number <= end; number++ {
						matches = append(matches, fmt.Sprintf("%s:%d:%s", path, number+1, pigNativeGrepLine(lines[number])))
					}
					if found >= limit {
						more = true
						return filepath.SkipAll
					}
				}
				return nil
			})
			if walkErr != nil {
				return nil, walkErr
			}
			notices := []string{}
			if more {
				notices = append(notices, fmt.Sprintf("%d matches limit reached. Use limit=%d for more", limit, limit*2))
			}
			return agentToolsText(pigNativeRender(matches, notices)), nil
		},
	}
}

// pigNativeGrepLine cuts one matching line to the length a search answer
// carries. A line of a generated file can be megabytes long, and one such
// line is enough to fill the answer.
func pigNativeGrepLine(line string) string {
	runes := []rune(line)
	if len(runes) <= pigNativeGrepLineLength {
		return line
	}
	return string(runes[:pigNativeGrepLineLength]) + "…"
}
