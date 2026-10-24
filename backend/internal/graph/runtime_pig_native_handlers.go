package graph

// The handlers of the native tools.
import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

func pigReadTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "read",
		Label:       "Read file",
		Description: "Read a UTF-8 file from the instance workspace or a bound capability.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":   map[string]any{"type": "string", "description": "The file to read."},
				"offset": map[string]any{"type": "number", "description": "The first line to return, counted from 1."},
				"limit":  map[string]any{"type": "number", "description": "How many lines to return."},
			},
			"required": []any{"path"},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			requested := agentToolsString(arguments["path"])
			if requested == "" {
				return nil, errors.New("read needs a path")
			}
			text := paths.readText(requested)
			offset := pigNativeNumber(arguments["offset"])
			limit := pigNativeNumber(arguments["limit"])
			return agentToolsText(pigNativeLines(text, offset, limit)), nil
		},
	}
}

// pigNativeLines cuts the lines one read returns.

func pigNativeLines(text string, offset, limit int) string {
	lines := strings.Split(text, "\n")
	if offset > 0 {
		if offset > len(lines) {
			return ""
		}
		lines = lines[offset-1:]
	}
	if limit > 0 && limit < len(lines) {
		lines = lines[:limit]
	}
	return strings.Join(lines, "\n")
}

// pigWriteTool is the SDK's write tool.

func pigWriteTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "write",
		Label:       "Write file",
		Description: "Create or overwrite files.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":    map[string]any{"type": "string", "description": "The file to write."},
				"content": map[string]any{"type": "string", "description": "The content of the file."},
			},
			"required": []any{"path", "content"},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			requested := agentToolsString(arguments["path"])
			if requested == "" {
				return nil, errors.New("write needs a path")
			}
			paths.writeText(requested, agentToolsString(arguments["content"]))
			return agentToolsText("Wrote " + requested), nil
		},
	}
}

// pigEditTool is the SDK's edit tool.
//
// An edit replaces an exact text. Every replacement must match exactly once:
// an ambiguous replacement is refused rather than guessed.

func pigEditTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "edit",
		Label:       "Edit file",
		Description: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "The file to edit."},
				"edits": map[string]any{
					"type":        "array",
					"description": "The replacements to apply, in order.",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"oldText": map[string]any{"type": "string", "description": "The text to replace."},
							"newText": map[string]any{"type": "string", "description": "The text to write instead."},
						},
						"required": []any{"oldText", "newText"},
					},
				},
			},
			"required": []any{"path", "edits"},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			requested := agentToolsString(arguments["path"])
			if requested == "" {
				return nil, errors.New("edit needs a path")
			}
			edits, _ := arguments["edits"].([]any)
			if len(edits) == 0 {
				return nil, errors.New("edit needs at least one replacement")
			}
			text := paths.readText(requested)
			for _, item := range edits {
				edit := agentToolsParams(item)
				oldText := agentToolsString(edit["oldText"])
				newText := agentToolsString(edit["newText"])
				if oldText == "" {
					return nil, errors.New("An edit needs the text to replace")
				}
				if strings.Count(text, oldText) != 1 {
					return nil, fmt.Errorf("The text to replace occurs %d times in %s; it must occur exactly once", strings.Count(text, oldText), requested)
				}
				text = strings.Replace(text, oldText, newText, 1)
			}
			paths.writeText(requested, text)
			return agentToolsText("Edited " + requested), nil
		},
	}
}

// pigLsTool is the SDK's ls tool.

func pigLsTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "ls",
		Label:       "List directory",
		Description: "List directory contents.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":  map[string]any{"type": "string", "description": "The directory to list."},
				"limit": map[string]any{"type": "number", "description": "How many entries to return."},
			},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			requested := "."
			if agentToolsTruthy(arguments["path"]) {
				requested = agentToolsString(arguments["path"])
			}
			names := paths.listNames(requested)
			limit := pigNativeNumber(arguments["limit"])
			if limit > 0 && limit < len(names) {
				names = names[:limit]
			}
			return agentToolsText(strings.Join(names, "\n")), nil
		},
	}
}

// pigFindTool is the SDK's find tool.

func pigFindTool(paths *pigNativePaths) ToolDefinition {
	return ToolDefinition{
		Name:        "find",
		Label:       "Find files",
		Description: "Find files by pattern.",
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
			limit := pigNativeNumber(arguments["limit"])
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
				}
				return nil
			})
			if walkErr != nil {
				return nil, walkErr
			}
			sort.Strings(found)
			if limit > 0 && limit < len(found) {
				found = found[:limit]
			}
			return agentToolsText(strings.Join(found, "\n")), nil
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
			limit := pigNativeNumber(arguments["limit"])
			matches := []string{}
			found := 0
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
						matches = append(matches, fmt.Sprintf("%s:%d:%s", path, number+1, lines[number]))
					}
					if limit > 0 && found >= limit {
						return filepath.SkipAll
					}
				}
				return nil
			})
			if walkErr != nil {
				return nil, walkErr
			}
			return agentToolsText(strings.Join(matches, "\n")), nil
		},
	}
}

// pigNativePattern turns a shell-style pattern into a regular expression.
//
// The SDK's find and grep take a glob, not a regular expression, so `*` and
// `?` mean what they mean in a file name.

func pigNativePattern(pattern string) string {
	out := []rune{}
	for index, character := range pattern {
		switch character {
		case '*':
			out = append(out, []rune(".*")...)
		case '?':
			out = append(out, '.')
		case '.', '+', '(', ')', '|', '{', '}', '[', ']', '^', '$', '\\':
			out = append(out, '\\', character)
		default:
			out = append(out, character)
		}
		_ = index
	}
	return string(out)
}

// pigBashTool is the SDK's shell tool.
//
// The command runs through the Graph's own command runner, so it passes the
// same sandbox, the same policy and the same gate as every other command the
// Graph runs.

func pigBashTool(input AgentToolsInput) ToolDefinition {
	return ToolDefinition{
		Name:        "bash",
		Label:       "Run command",
		Description: "Execute bash commands (ls, grep, find, etc.)",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{"type": "string", "description": "The command to run."},
				"timeout": map[string]any{"type": "number", "description": "How long the command may run, in milliseconds."},
			},
			"required": []any{"command"},
		},
		Execute: func(_ string, params any) (any, error) {
			arguments := agentToolsParams(params)
			command := agentToolsString(arguments["command"])
			if command == "" {
				return nil, errors.New("bash needs a command")
			}
			if input.Run == nil {
				return nil, errors.New("This Agent may not run commands")
			}
			result := input.Run("sh", []string{"-c", command}, nil)
			return agentToolsText(agentToolsCommandOutput(result)), nil
		},
	}
}
