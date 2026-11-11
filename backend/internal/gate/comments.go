package gate

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	ExplainBudgetPerFile = 8
	TotalBudget          = 40
)

var directivePattern = regexp.MustCompile(`^(?:graph:|go:|@ts-|eslint|nolint|prettier|\+build|<reference)`)

type CommentCounts struct {
	Directive   int
	Explanatory int
	Lines       int
}

type SourceFile struct {
	Path        string
	Directive   int
	Explanatory int
}

func commentBody(text string) string {
	trimmed := strings.TrimLeft(text, "/")
	trimmed = strings.TrimSuffix(strings.TrimSpace(trimmed), "*/")
	trimmed = strings.TrimPrefix(trimmed, "*")
	lines := strings.Split(trimmed, "\n")
	for index, line := range lines {
		lines[index] = strings.TrimPrefix(strings.TrimLeft(line, " \t"), "*")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func IsDirective(text string) bool {
	return directivePattern.MatchString(commentBody(text))
}

func ScanComments(text, lang string) CommentCounts {
	counts := CommentCounts{Lines: strings.Count(text, "\n") + 1}
	backtick := lang == "go" || lang == "ts"
	var quote byte
	inBlock := false
	blockLine := -1
	line := 0
	var body strings.Builder
	add := func(span string, height int) {
		if IsDirective(span) {
			counts.Directive += height
			return
		}
		counts.Explanatory += height
	}
	for index := 0; index < len(text); index++ {
		ch := text[index]
		var next byte
		if index+1 < len(text) {
			next = text[index+1]
		}
		if quote != 0 {
			if ch == '\\' && quote != '`' {
				index++
			} else if ch == quote {
				quote = 0
			} else if ch == '\n' && quote != '`' {
				quote = 0
			}
			continue
		}
		if inBlock {
			if ch == '*' && next == '/' {
				body.WriteString("*/")
				add(body.String(), line-blockLine+1)
				inBlock = false
				body.Reset()
				index++
				continue
			}
			if ch == '\n' {
				line++
			}
			body.WriteByte(ch)
			continue
		}
		if ch == '/' && next == '/' {
			end := index
			for end < len(text) && text[end] != '\n' {
				end++
			}
			add(text[index:end], 1)
			index = end - 1
			continue
		}
		if ch == '/' && next == '*' {
			blockLine = line
			body.Reset()
			inBlock = true
			index++
			continue
		}
		if ch == '\n' {
			line++
			continue
		}
		if ch == '"' || ch == '\'' || (backtick && ch == '`') {
			quote = ch
		}
	}
	if inBlock {
		add(body.String(), line-blockLine+1)
	}
	return counts
}

func CompareExplanatory(before, after, lang string) bool {
	return ScanComments(after, lang).Explanatory > ScanComments(before, lang).Explanatory
}

func ScanRepo(root string) []SourceFile {
	files := []SourceFile{}
	for _, source := range []struct {
		root      string
		extension string
		lang      string
	}{
		{"backend", ".go", "go"},
		{"src", ".ts", "ts"},
		{"src", ".tsx", "ts"},
	} {
		base := filepath.Join(root, source.root)
		_ = filepath.WalkDir(base, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			name := entry.Name()
			if entry.IsDir() {
				if name == "node_modules" || (strings.HasPrefix(name, ".") && path != base) {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(name, source.extension) || strings.HasSuffix(name, "_test.go") {
				return nil
			}
			payload, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}
			counts := ScanComments(string(payload), source.lang)
			relative, relErr := filepath.Rel(root, path)
			if relErr != nil {
				relative = path
			}
			files = append(files, SourceFile{Path: filepath.ToSlash(relative), Directive: counts.Directive, Explanatory: counts.Explanatory})
			return nil
		})
	}
	return files
}
