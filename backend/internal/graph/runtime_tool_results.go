package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"sync"
)

const (
	TOOL_RESULT_LIMIT       = 4000
	SUMMARY_LIMIT           = 1024
	SHELL_OUTPUT_LIMIT      = 20000
	SYSTEM_SUMMARY_LIMIT    = 12000
	CONVERSATION_READ_LIMIT = 8000
	MAX_RECORDED_KEYS       = 256
	MAX_SCOPES              = 64
	MAX_SPILL_FILES         = 256
	toolResultCountsFile    = "counts.json"
)

var toolResultLimits = map[string]int{
	"bash":                     SHELL_OUTPUT_LIMIT,
	"read_system_capabilities": SYSTEM_SUMMARY_LIMIT,
	"conversation_read":        CONVERSATION_READ_LIMIT,
}

var toolTruncation = regexp.MustCompile(`\n*(\[(?:Showing lines|[\d,]+ more lines in file|Output truncated|Line \d+ is)[^\]]*\])\s*$`)
var toolTruncationBody = regexp.MustCompile(`\n*\[(?:Showing lines|[\d,]+ more lines in file|Output truncated|Line \d+ is)[^\]]*\]\s*$`)

// ToolResultHookContext is the part of an agent-loop result this seam reads.
type ToolResultHookContext struct {
	ToolCall struct{ Name string }
	Args     any
	Result   struct{ Content []map[string]any }
}

// ToolResultTracker counts occurrences in recency order.
type ToolResultTracker struct {
	capacity int
	order    []string
	counts   map[string]int
}

// CreateToolResultTracker starts a bounded recency map.
func CreateToolResultTracker(capacity int, initial map[string]int) *ToolResultTracker {
	if capacity < 1 {
		capacity = 1
	}
	tracker := &ToolResultTracker{capacity: capacity, counts: map[string]int{}}
	if initial != nil {
		keys := make([]string, 0, len(initial))
		for key := range initial {
			keys = append(keys, key)
		}
		// TODO(port): Object key order is insertion order. A decoded JSON object is sorted.
		sort.Strings(keys)
		for _, key := range keys {
			tracker.order = append(tracker.order, key)
			tracker.counts[key] = initial[key]
		}
		tracker.forget()
	}
	return tracker
}

func (tracker *ToolResultTracker) Record(key string) int {
	next := tracker.counts[key] + 1
	tracker.drop(key)
	tracker.order = append(tracker.order, key)
	tracker.counts[key] = next
	tracker.forget()
	return next
}

func (tracker *ToolResultTracker) Counts() map[string]int {
	out := map[string]int{}
	for _, key := range tracker.order {
		out[key] = tracker.counts[key]
	}
	return out
}

func (tracker *ToolResultTracker) drop(key string) {
	if _, ok := tracker.counts[key]; !ok {
		return
	}
	delete(tracker.counts, key)
	next := tracker.order[:0]
	for _, item := range tracker.order {
		if item != key {
			next = append(next, item)
		}
	}
	tracker.order = next
}

func (tracker *ToolResultTracker) forget() {
	for len(tracker.order) > tracker.capacity {
		oldest := tracker.order[0]
		tracker.order = tracker.order[1:]
		delete(tracker.counts, oldest)
	}
}

func toolResultStable(value any) string {
	switch typed := value.(type) {
	case []any:
		parts := make([]string, len(typed))
		for i, item := range typed {
			parts[i] = toolResultStable(item)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		// TODO(port): localeCompare key order. Byte order is the stand-in.
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, key := range keys {
			parts[i] = key + ":" + toolResultStable(typed[key])
		}
		return "{" + strings.Join(parts, ",") + "}"
	default:
		raw, err := json.Marshal(value)
		if err != nil || raw == nil {
			return "null"
		}
		return string(raw)
	}
}

func toolResultsDigest(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])[:16]
}

// ToolResultKey identifies one large result.
func ToolResultKey(conversationID, tool string, params any, text string) string {
	return toolResultsDigest(conversationID + "\x00" + tool + "\x00" + toolResultStable(params) + "\x00" + toolResultsDigest(text))
}

// HoistTruncationNotice moves a trailing truncation banner to the front.
func HoistTruncationNotice(text string) string {
	banner := TruncationBanner(text)
	if banner == "" || strings.HasPrefix(text, banner) {
		return text
	}
	return banner + "\n" + toolTruncationBody.ReplaceAllString(text, "")
}

// TruncationBanner is the leading notice, or empty when nothing was truncated.
func TruncationBanner(text string) string {
	match := toolTruncation.FindStringSubmatch(text)
	if match == nil {
		return ""
	}
	return "[truncated: " + match[1] + "]"
}

// SummarizeToolResult builds a deterministic head and tail.
func SummarizeToolResult(text, handle string, limit int) string {
	if limit == 0 {
		limit = SUMMARY_LIMIT
	}
	lineCount := strings.Count(text, "\n") + 1
	if text == "" {
		lineCount = 1
	}
	// TODO(port): TypeScript string.length is UTF-16 code units. This uses byte length.
	header := "[large tool result: " + itoa(len(text)) + " chars, " + itoa(lineCount) + " lines]"
	trailer := "handle: " + handle + "\nRead the whole result with the read tool (offset/limit) on that path."
	room := limit - len(header) - len(trailer) - 64
	if room < 0 {
		room = 0
	}
	tailBudget := room / 3
	head := toolBoundSide(text, room-tailBudget, false)
	tail := toolBoundSide(text, tailBudget, true)
	dropped := len(text) - len(head) - len(tail)
	if dropped < 0 {
		dropped = 0
	}
	marker := "... omitted " + itoa(dropped) + " of " + itoa(len(text)) + " chars ..."
	summary := strings.Join([]string{header, head, marker, tail, trailer}, "\n")
	if len(summary) > limit {
		return summary[:limit]
	}
	return summary
}

func toolBoundSide(text string, budget int, fromEnd bool) string {
	if budget <= 0 {
		return ""
	}
	lines := strings.Split(text, "\n")
	if fromEnd {
		for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
			lines[i], lines[j] = lines[j], lines[i]
		}
	}
	picked := []string{}
	used := 0
	for _, line := range lines {
		cost := len(line)
		if len(picked) > 0 {
			cost++
		}
		if used+cost > budget {
			if len(picked) == 0 {
				if fromEnd && len(line) > budget {
					picked = append(picked, line[len(line)-budget:])
				} else if len(line) > budget {
					picked = append(picked, line[:budget])
				} else {
					picked = append(picked, line)
				}
			}
			break
		}
		picked = append(picked, line)
		used += cost
	}
	if fromEnd {
		for i, j := 0, len(picked)-1; i < j; i, j = i+1, j-1 {
			picked[i], picked[j] = picked[j], picked[i]
		}
	}
	return strings.Join(picked, "\n")
}

func pruneSpills(spillDir string, keep int) {
	if keep == int(math.Inf(1)) || keep < 0 && keep == -1 {
		return
	}
	if keep > 1_000_000_000 {
		return
	}
	entries, err := os.ReadDir(spillDir)
	if err != nil {
		return
	}
	type dated struct {
		name  string
		mtime int64
	}
	files := []dated{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".txt") {
			continue
		}
		info, err := entry.Info()
		mtime := int64(0)
		if err == nil {
			mtime = info.ModTime().UnixMilli()
		}
		files = append(files, dated{name: entry.Name(), mtime: mtime})
	}
	if len(files) <= keep {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mtime < files[j].mtime })
	for _, item := range files[:len(files)-keep] {
		_ = os.Remove(filepath.Join(spillDir, item.name))
	}
}

// RenderToolResult returns the original text or a spilled summary.
func RenderToolResult(text, conversationID, tool string, params any, spillDir string, tracker *ToolResultTracker, limit *int, maxSpillFiles *int) string {
	text = HoistTruncationNotice(text)
	if limit == nil && len(text) <= TOOL_RESULT_LIMIT {
		return text
	}
	key := ToolResultKey(conversationID, tool, params, text)
	if limit == nil && tracker.Record(key) <= 2 {
		return text
	}
	if err := os.MkdirAll(spillDir, 0o755); err != nil {
		panic(err)
	}
	handle := filepath.Join(spillDir, key+".txt")
	if err := os.WriteFile(handle, []byte(text), 0o600); err != nil {
		panic(err)
	}
	keep := MAX_SPILL_FILES
	if maxSpillFiles != nil {
		keep = *maxSpillFiles
	}
	pruneSpills(spillDir, keep)
	summaryLimit := SUMMARY_LIMIT
	if limit != nil {
		summaryLimit = *limit
	}
	summary := SummarizeToolResult(text, handle, summaryLimit)
	if banner := TruncationBanner(text); banner != "" {
		return banner + "\n" + summary
	}
	return summary
}

type toolScope struct {
	tracker  *ToolResultTracker
	spillDir string
}

var (
	toolScopes   = map[string]toolScope{}
	toolScopeAge []string
	toolDirMu    sync.Mutex
	toolDirLock  = map[string]*sync.Mutex{}
)

func toolDirectoryLock(directory string) *sync.Mutex {
	toolDirMu.Lock()
	defer toolDirMu.Unlock()
	lock := toolDirLock[directory]
	if lock == nil {
		lock = &sync.Mutex{}
		toolDirLock[directory] = lock
	}
	return lock
}

func toolReadCounts(spillDir string) map[string]map[string]int {
	body, err := os.ReadFile(filepath.Join(spillDir, toolResultCountsFile))
	if err != nil {
		return map[string]map[string]int{}
	}
	var parsed struct {
		Version int                       `json:"version"`
		Scopes  map[string]map[string]int `json:"scopes"`
	}
	if json.Unmarshal(body, &parsed) != nil || parsed.Version != 1 || parsed.Scopes == nil {
		return map[string]map[string]int{}
	}
	return parsed.Scopes
}

func toolWriteCounts(spillDir string, scopes map[string]map[string]int) {
	if err := os.MkdirAll(spillDir, 0o755); err != nil {
		panic(err)
	}
	body, err := json.Marshal(map[string]any{"version": 1, "scopes": scopes})
	if err != nil {
		panic(err)
	}
	target := filepath.Join(spillDir, toolResultCountsFile)
	if err := os.WriteFile(target+".tmp", body, 0o600); err != nil {
		panic(err)
	}
	if err := os.Rename(target+".tmp", target); err != nil {
		panic(err)
	}
}

func toolTrackerFor(scopeID, spillDir string) *ToolResultTracker {
	if existing, ok := toolScopes[scopeID]; ok {
		next := toolScopeAge[:0]
		for _, id := range toolScopeAge {
			if id != scopeID {
				next = append(next, id)
			}
		}
		toolScopeAge = append(next, scopeID)
		return existing.tracker
	}
	saved := toolReadCounts(spillDir)
	tracker := CreateToolResultTracker(MAX_RECORDED_KEYS, saved[scopeID])
	toolScopes[scopeID] = toolScope{tracker: tracker, spillDir: spillDir}
	toolScopeAge = append(toolScopeAge, scopeID)
	for len(toolScopeAge) > MAX_SCOPES {
		oldest := toolScopeAge[0]
		toolScopeAge = toolScopeAge[1:]
		delete(toolScopes, oldest)
	}
	return tracker
}

func toolPersistScope(scopeID string, tracker *ToolResultTracker) {
	entry, ok := toolScopes[scopeID]
	if !ok {
		return
	}
	saved := toolReadCounts(entry.spillDir)
	saved[scopeID] = tracker.Counts()
	ids := make([]string, 0, len(saved))
	for id := range saved {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for len(ids) > MAX_SCOPES {
		delete(saved, ids[0])
		ids = ids[1:]
	}
	toolWriteCounts(entry.spillDir, saved)
}

// ToolResultHook rewrites a repeated large result. It returns nil when the tool result should pass through.
func ToolResultHook(scopeID, spillDir string, maxSpillFiles *int, compactShell bool) func(map[string]any) any {
	return func(context map[string]any) any {
		result := asMap(context["result"])
		parts := asSlice(result["content"])
		if parts == nil {
			return nil
		}
		texts := []string{}
		for _, part := range parts {
			record := asMap(part)
			if record["type"] == "text" {
				texts = append(texts, mapString(record, "text"))
			}
		}
		if len(texts) == 0 {
			return nil
		}
		name := mapString(asMap(context["toolCall"]), "name")
		if name == "" {
			name = "unknown"
		}
		text := strings.Join(texts, "\n")
		compact := compactShell && name == "bash"
		ceiling, hasCeiling := toolResultLimits[name]
		if compact {
			ceiling = TOOL_RESULT_LIMIT
			hasCeiling = true
		}
		var limit *int
		if hasCeiling && len(text) > ceiling {
			value := ceiling
			if compact {
				value = SUMMARY_LIMIT
			}
			limit = &value
		}
		if limit == nil && len(text) <= TOOL_RESULT_LIMIT {
			return nil
		}
		lock := toolDirectoryLock(spillDir)
		lock.Lock()
		defer lock.Unlock()
		tracker := toolTrackerFor(scopeID, spillDir)
		dir := spillDir
		var spills *int
		if compact {
			dir = filepath.Join(spillDir, "shell")
			infinite := int(^uint(0) >> 1)
			spills = &infinite
		} else {
			spills = maxSpillFiles
		}
		rendered := RenderToolResult(text, scopeID, name, context["args"], dir, tracker, limit, spills)
		if limit == nil {
			toolPersistScope(scopeID, tracker)
		}
		if rendered == text {
			return nil
		}
		content := []any{}
		summarised := false
		for _, part := range parts {
			record := asMap(part)
			if record["type"] != "text" {
				content = append(content, part)
				continue
			}
			if summarised {
				continue
			}
			content = append(content, map[string]any{"type": "text", "text": rendered})
			summarised = true
		}
		return map[string]any{"content": content}
	}
}
