package graph

import (
	"unicode"

	"regexp"
)

const MAX_SLUG_LENGTH = 40

const DEFAULT_SLUG = "task"

var asciiAlnum = regexp.MustCompile(`^[A-Za-z0-9]$`)

func TaskSlug(request string) string {
	source := request
	var tokens []string
	ascii := ""
	for _, char := range source {
		piece := string(char)
		if asciiAlnum.MatchString(piece) {
			ascii += lowerASCII(piece)
			continue
		}
		if ascii != "" {
			tokens = append(tokens, ascii)
			ascii = ""
		}
		pinyin := PinyinFor(piece)
		if pinyin != nil && *pinyin != "" {
			tokens = append(tokens, *pinyin)
			continue
		}
		if unicode.Is(unicode.Han, char) {
			tokens = append(tokens, piece)
		}
	}
	if ascii != "" {
		tokens = append(tokens, ascii)
	}
	collapsed := collapseHyphens(joinHyphen(tokens))
	truncated := trimHyphens(collapsed)
	if len(truncated) > MAX_SLUG_LENGTH {
		truncated = trimHyphens(truncated[:MAX_SLUG_LENGTH])
	}
	if truncated == "" {
		return DEFAULT_SLUG
	}
	return truncated
}

func TaskShortId(taskId string) string {
	compact := nonAlnum.ReplaceAllString(taskId, "")
	if len(compact) > 8 {
		compact = compact[:8]
	}
	if compact == "" {
		return DEFAULT_SLUG
	}
	return compact
}

var nonAlnum = regexp.MustCompile(`[^0-9a-zA-Z]`)

func TaskBranchName(request, taskId string) string {
	return "graph/task/" + TaskSlug(request) + "-" + TaskShortId(taskId)
}

func WorkCopyBranchName(request, taskId, nodeId string) string {
	return "graph/copy/" + TaskSlug(request) + "-" + TaskShortId(taskId) + "/" + nodeId
}

func TaskWorktreeDirName(request, taskId string) string {
	return TaskSlug(request) + "-" + TaskShortId(taskId)
}

func UniqueWorktreeDirName(preferred string, taken []string) string {
	used := map[string]bool{}
	for _, name := range taken {
		used[name] = true
	}
	if !used[preferred] {
		return preferred
	}
	for suffix := 2; ; suffix++ {
		candidate := preferred + "-" + itoa(suffix)
		if !used[candidate] {
			return candidate
		}
	}
}

func lowerASCII(value string) string {
	out := make([]byte, len(value))
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out[i] = c
	}
	return string(out)
}

func joinHyphen(tokens []string) string {
	out := ""
	for i, token := range tokens {
		if i > 0 {
			out += "-"
		}
		out += token
	}
	return out
}

func collapseHyphens(value string) string {
	out := make([]byte, 0, len(value))
	prev := false
	for i := 0; i < len(value); i++ {
		if value[i] == '-' {
			if prev {
				continue
			}
			prev = true
		} else {
			prev = false
		}
		out = append(out, value[i])
	}
	return trimHyphens(string(out))
}

func trimHyphens(value string) string {
	for len(value) > 0 && value[0] == '-' {
		value = value[1:]
	}
	for len(value) > 0 && value[len(value)-1] == '-' {
		value = value[:len(value)-1]
	}
	return value
}
