package graph

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf16"
)

const (
	sedimentDescriptionLimit = 300
	sedimentBodyLimit        = 24000
	sedimentIDLimit          = 60
	sedimentExistingLimit    = 40
)

var (
	sedimentTrigger = regexp.MustCompile(`(?i)use when|use for|use before|use this when|use this skill when|when the user|when you|何时|当你|适用于`)
	sedimentID      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	sedimentFence   = regexp.MustCompile("```(?:markdown|md)?[ \t]*\r?\n[\\s\\S]*?```")
	sedimentBody    = regexp.MustCompile("```(?:markdown|md)?[ \t]*\r?\n([\\s\\S]*?)\r?\n?```")
	sedimentOwned   = regexp.MustCompile(`(?m)^---[\s\S]*?^created-by:\s*graph-agent\s*$`)
	sedimentDesc    = regexp.MustCompile(`(?m)^description:\s*(.*)$`)
)

// SedimentSettings is the skill-library sedimentation switch.
type SedimentSettings struct {
	Enabled        bool    `json:"enabled"`
	AfterToolCalls int     `json:"afterToolCalls"`
	Model          *string `json:"model"`
	BudgetTokens   int     `json:"budgetTokens"`
}

// DEFAULT_SEDIMENT_SETTINGS keeps sedimentation off until a threshold is configured.
var DEFAULT_SEDIMENT_SETTINGS = SedimentSettings{Enabled: false, AfterToolCalls: 10, Model: nil, BudgetTokens: 40_000}

// SedimentSettingsFrom reads a tolerant settings block. A missing block means the feature is off.
func SedimentSettingsFrom(config any) SedimentSettings {
	block := sedimentBlock(config)
	preferred := ""
	if text, ok := block["model"].(string); ok {
		preferred = strings.TrimSpace(text)
	}
	settings := SedimentSettings{
		Enabled:        block["enabled"] == true,
		AfterToolCalls: sedimentPositive(block["afterToolCalls"], DEFAULT_SEDIMENT_SETTINGS.AfterToolCalls),
		BudgetTokens:   sedimentPositive(block["budgetTokens"], DEFAULT_SEDIMENT_SETTINGS.BudgetTokens),
	}
	if preferred != "" {
		settings.Model = &preferred
	}
	return settings
}

func sedimentBlock(config any) map[string]any {
	root, ok := config.(map[string]any)
	if !ok {
		return nil
	}
	skills, ok := root["skills"].(map[string]any)
	if !ok {
		return nil
	}
	block, _ := skills["sedimentation"].(map[string]any)
	return block
}

func sedimentPositive(value any, fallback int) int {
	number, ok := value.(float64)
	if !ok {
		if integer, isInt := value.(int); isInt {
			number = float64(integer)
			ok = true
		} else if integer, isInt := value.(int64); isInt {
			number = float64(integer)
			ok = true
		}
	}
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return fallback
	}
	return int(math.Round(number))
}

// SedimentGate decides whether one operation earned a review.
type SedimentGate struct {
	Enabled         bool
	Role            *string
	ToolCalls       int
	Threshold       int
	Paused          bool
	AlreadyReviewed bool
}

// SedimentProposal is the document a review asked to write.
type SedimentProposal struct {
	Action      string
	Id          string
	Description string
	Body        string
	Reason      string
}

// SedimentWritten is one skill file this review wrote.
type SedimentWritten struct {
	Id       string `json:"id"`
	Path     string `json:"path"`
	Replaced bool   `json:"replaced"`
}

// SedimentOutcome is the result of applying a proposal.
type SedimentOutcome struct {
	Nothing  bool              `json:"nothing"`
	Written  []SedimentWritten `json:"written"`
	Refused  []string          `json:"refused"`
	Proposed *string           `json:"proposed"`
}

func sedimentNothing() SedimentOutcome {
	return SedimentOutcome{Nothing: true, Written: []SedimentWritten{}, Refused: []string{}, Proposed: nil}
}

// ShouldSediment reports whether the master's own operation did enough work to review.
func ShouldSediment(gate SedimentGate) bool {
	role := ""
	if gate.Role != nil {
		role = *gate.Role
	}
	return gate.Enabled && role == "master" && !gate.Paused && !gate.AlreadyReviewed && gate.Threshold > 0 && gate.ToolCalls >= gate.Threshold
}

// SEDIMENT_ATTEMPT_LIMIT is how many models one review may ask.
const SEDIMENT_ATTEMPT_LIMIT = 2

// SedimentCandidates lists models to ask, best first, excluding the model that did the work.
func SedimentCandidates(main ModelEntry, directory []ModelEntry, preferred *string) []ModelEntry {
	var ordered []ModelEntry
	add := func(candidate *ModelEntry) {
		if candidate == nil {
			return
		}
		for _, existing := range ordered {
			if existing.Id == candidate.Id {
				return
			}
		}
		ordered = append(ordered, *candidate)
	}
	mainIdentity := ModelIdentity(main)
	var eligible []ModelEntry
	for _, model := range directory {
		if model.Id != main.Id && ModelIdentity(model) != mainIdentity {
			eligible = append(eligible, model)
		}
	}
	if preferred != nil && *preferred != "" {
		for i := range eligible {
			if eligible[i].Id == *preferred {
				add(&eligible[i])
				break
			}
		}
	}
	for _, grade := range MODEL_GRADE_ORDER {
		for i := range eligible {
			if eligible[i].Grade == grade {
				add(&eligible[i])
			}
		}
	}
	if len(ordered) > SEDIMENT_ATTEMPT_LIMIT {
		ordered = ordered[:SEDIMENT_ATTEMPT_LIMIT]
	}
	return ordered
}

// SelectSedimentModel picks the configured model, else the cheapest distinct one.
func SelectSedimentModel(main ModelEntry, directory []ModelEntry, preferred *string) *ModelEntry {
	if preferred != nil && *preferred != "" {
		for i := range directory {
			if directory[i].Id == *preferred {
				return &directory[i]
			}
		}
	}
	mainIdentity := ModelIdentity(main)
	var candidates []ModelEntry
	for _, model := range directory {
		if model.Id != main.Id && ModelIdentity(model) != mainIdentity {
			candidates = append(candidates, model)
		}
	}
	for _, grade := range MODEL_GRADE_ORDER {
		for i := range candidates {
			if candidates[i].Grade == grade {
				found := candidates[i]
				return &found
			}
		}
	}
	return nil
}

func escapeControlCharacters(value string) string {
	var out strings.Builder
	for _, char := range value {
		switch char {
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if char >= 0 && char <= 0x1f {
				out.WriteString(`\u`)
				hex := "0123456789abcdef"
				out.WriteByte(hex[(char>>12)&0xf])
				out.WriteByte(hex[(char>>8)&0xf])
				out.WriteByte(hex[(char>>4)&0xf])
				out.WriteByte(hex[char&0xf])
				continue
			}
			out.WriteRune(char)
		}
	}
	return out.String()
}

func firstJsonObject(text string) string {
	start := strings.IndexByte(text, '{')
	if start < 0 {
		return ""
	}
	depth := 0
	quoted := false
	escaped := false
	for index := start; index < len(text); index++ {
		char := text[index]
		if quoted {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				quoted = false
			}
			continue
		}
		if char == '"' {
			quoted = true
			continue
		}
		if char == '{' {
			depth++
		} else if char == '}' {
			depth--
			if depth == 0 {
				return text[start : index+1]
			}
		}
	}
	return ""
}

// SedimentReplyShape records what the parser saw in a review reply.
type SedimentReplyShape struct {
	MetadataLine bool   `json:"metadataLine"`
	Fence        bool   `json:"fence"`
	Chars        int    `json:"chars"`
	Tail         string `json:"tail"`
}

// SedimentReplyShapeOf describes an unreadable review without discarding the shape.
func SedimentReplyShapeOf(text string) SedimentReplyShape {
	raw := strings.TrimSpace(text)
	tail := raw
	runes := []rune(raw)
	if len(runes) > 200 {
		tail = string(runes[len(runes)-200:])
	}
	return SedimentReplyShape{MetadataLine: firstJsonObject(raw) != "", Fence: sedimentFence.MatchString(raw), Chars: len(text), Tail: tail}
}

// ParseSedimentProposal reads a proposal out of a model reply.
func ParseSedimentProposal(text string) *SedimentProposal {
	raw := strings.TrimSpace(text)
	if raw == "" {
		return nil
	}
	candidate := firstJsonObject(raw)
	if candidate == "" {
		return nil
	}
	var value any
	if err := json.Unmarshal([]byte(candidate), &value); err != nil {
		if err := json.Unmarshal([]byte(escapeControlCharacters(candidate)), &value); err != nil {
			return nil
		}
	}
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	action, _ := record["action"].(string)
	if action != "create" && action != "update" && action != "nothing" {
		return nil
	}
	if action == "nothing" {
		return &SedimentProposal{Action: action}
	}
	textOf := func(value any) string {
		text, ok := value.(string)
		if !ok {
			return ""
		}
		return strings.TrimSpace(text)
	}
	fenced := ""
	if match := sedimentBody.FindStringSubmatch(raw); len(match) > 1 {
		fenced = strings.TrimSpace(match[1])
	}
	prose := strings.TrimSpace(raw[strings.Index(raw, candidate)+len(candidate):])
	proseBody := ""
	if prose != "" && !strings.HasPrefix(prose, "{") && !strings.HasPrefix(prose, "```") {
		runes := []rune(prose)
		if len(runes) > sedimentBodyLimit {
			prose = string(runes[:sedimentBodyLimit])
		}
		proseBody = prose
	}
	body := textOf(record["body"])
	if body == "" {
		if fenced != "" {
			body = fenced
		} else {
			body = proseBody
		}
	}
	return &SedimentProposal{Action: action, Id: textOf(record["id"]), Description: textOf(record["description"]), Body: body, Reason: textOf(record["reason"])}
}

// ExistingSkillSummaries lists skills already in the project so a review can fold into one.
func ExistingSkillSummaries(projectRoot string) []struct {
	Id          string
	Description string
} {
	base := filepath.Join(projectRoot, ".agents", "skills")
	info, err := os.Stat(base)
	if err != nil || !info.IsDir() {
		return []struct {
			Id          string
			Description string
		}{}
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		panic(err)
	}
	summaries := []struct {
		Id          string
		Description string
	}{}
	for _, entry := range entries {
		path := filepath.Join(base, entry.Name(), "SKILL.md")
		if _, err := os.Stat(path); err != nil {
			continue
		}
		text, err := os.ReadFile(path)
		if err != nil {
			panic(err)
		}
		description := ""
		if match := sedimentDesc.FindStringSubmatch(string(text)); len(match) > 1 {
			description = strings.TrimSpace(match[1])
		}
		runes := []rune(description)
		if len(runes) > sedimentDescriptionLimit {
			description = string(runes[:sedimentDescriptionLimit])
		}
		summaries = append(summaries, struct {
			Id          string
			Description string
		}{Id: entry.Name(), Description: description})
		if len(summaries) >= sedimentExistingLimit {
			break
		}
	}
	return summaries
}

// ApplySedimentProposal writes a reviewed skill or refuses it.
func ApplySedimentProposal(projectRoot string, proposal *SedimentProposal) SedimentOutcome {
	if proposal == nil {
		return sedimentNothing()
	}
	if proposal.Action == "nothing" {
		outcome := sedimentNothing()
		proposed := "nothing"
		outcome.Proposed = &proposed
		return outcome
	}
	var refused []string
	id := proposal.Id
	description := proposal.Description
	body := strings.TrimSpace(proposal.Body)
	if !sedimentID.MatchString(id) || len(id) > sedimentIDLimit {
		encoded, _ := json.Marshal(id)
		refused = append(refused, "refused: id "+string(encoded)+" is not a lowercase slug of at most 60 characters")
	}
	if description == "" || len([]rune(description)) > sedimentDescriptionLimit || !sedimentTrigger.MatchString(description) {
		refused = append(refused, `refused: description must be one sentence that says when to use the skill ("Use when …"), under 300 characters`)
	}
	if body == "" || len([]rune(body)) > sedimentBodyLimit {
		refused = append(refused, "refused: body must be markdown between 1 and 24000 characters")
	}
	if len(refused) > 0 {
		return SedimentOutcome{Nothing: false, Written: []SedimentWritten{}, Refused: refused, Proposed: &proposal.Action}
	}
	skillsRoot, err := filepath.Abs(filepath.Join(projectRoot, ".agents", "skills"))
	if err != nil {
		panic(err)
	}
	dir := filepath.Join(skillsRoot, id)
	resolved, err := filepath.Abs(dir)
	if err != nil {
		panic(err)
	}
	if !strings.HasPrefix(resolved+string(os.PathSeparator), skillsRoot+string(os.PathSeparator)) {
		return SedimentOutcome{Nothing: false, Written: []SedimentWritten{}, Refused: []string{"refused: " + id + " resolves outside the project skill folder"}, Proposed: &proposal.Action}
	}
	path := filepath.Join(dir, "SKILL.md")
	replaced := false
	if text, err := os.ReadFile(path); err == nil {
		if !sedimentOwned.Match(text) {
			return SedimentOutcome{Nothing: false, Written: []SedimentWritten{}, Refused: []string{"refused: skill '" + id + "' was not written by us (no created-by: graph-agent); it is somebody else's text"}, Proposed: &proposal.Action}
		}
		replaced = true
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		panic(err)
	}
	document := "---\nname: " + id + "\ncreated-by: graph-agent\ndescription: " + description + "\n---\n\n" + body + "\n"
	if err := os.WriteFile(path, []byte(document), 0o644); err != nil {
		panic(err)
	}
	return SedimentOutcome{Nothing: false, Written: []SedimentWritten{{Id: id, Path: path, Replaced: replaced}}, Refused: []string{}, Proposed: &proposal.Action}
}

// SedimentReply is what one review call gave back.
type SedimentReply struct {
	Text       *string
	Raw        string
	StopReason *string
	Error      *string
}

// SedimentStream is the injected model call. It receives the plain context; the
// controlled adapter folds it into the transcript the way the Pi SDK's
// normalizeContext does.
type SedimentStream func(model any, context map[string]any, options map[string]any) (message map[string]any, err error)

// GenerateSkillProposal asks one model for a skill document. The transcript crosses as data.
func GenerateSkillProposal(stream SedimentStream, model any, systemPrompt string, payload any, signal any) (reply SedimentReply) {
	prompt := strings.TrimSpace(systemPrompt)
	if prompt == "" {
		prompt = DEFAULT_SEDIMENT_PROMPT
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	body := string(encoded)
	units := utf16.Encode([]rune(body))
	if len(units) > 16000 {
		body = string(utf16.Decode(units[:16000]))
	}
	context := map[string]any{
		"systemPrompt": prompt,
		"messages": []any{map[string]any{
			"role":      "user",
			"content":   body,
			"timestamp": NowMillis(),
		}},
	}
	options := map[string]any{"maxTokens": 2000, "reasoning": "minimal"}
	if signal != nil {
		options["signal"] = signal
	}
	defer func() {
		if rec := recover(); rec != nil {
			message := panicText(rec)
			reply = SedimentReply{Raw: "", Error: &message}
		}
	}()
	message, err := stream(model, context, options)
	if err != nil {
		messageText := err.Error()
		return SedimentReply{Raw: "", Error: &messageText}
	}
	raw := sedimentTextFromMessage(message)
	stop, _ := message["stopReason"].(string)
	var stopPtr *string
	if stop != "" {
		stopPtr = &stop
	}
	var textPtr *string
	if stop == "stop" {
		textPtr = &raw
	}
	var errorPtr *string
	if reported, ok := message["errorMessage"].(string); ok && reported != "" {
		errorPtr = &reported
	}
	return SedimentReply{Text: textPtr, Raw: raw, StopReason: stopPtr, Error: errorPtr}
}

func sedimentTextFromMessage(message map[string]any) string {
	parts, ok := message["content"].([]any)
	if !ok {
		return ""
	}
	var out strings.Builder
	for _, part := range parts {
		record, ok := part.(map[string]any)
		if !ok {
			continue
		}
		if record["type"] == "text" {
			if text, ok := record["text"].(string); ok {
				out.WriteString(text)
			}
		}
	}
	return out.String()
}

// RunSedimentReview gates, asks, parses and applies one review.
func RunSedimentReview(gate SedimentGate, settings SedimentSettings, projectRoot string, review func() *string) struct {
	Reviewed bool
	Outcome  SedimentOutcome
} {
	gate.Enabled = gate.Enabled && settings.Enabled
	gate.Threshold = settings.AfterToolCalls
	if !ShouldSediment(gate) {
		return struct {
			Reviewed bool
			Outcome  SedimentOutcome
		}{Reviewed: false, Outcome: sedimentNothing()}
	}
	reply := ""
	if text := review(); text != nil {
		reply = *text
	}
	return struct {
		Reviewed bool
		Outcome  SedimentOutcome
	}{Reviewed: true, Outcome: ApplySedimentProposal(projectRoot, ParseSedimentProposal(reply))}
}

func panicText(rec any) string {
	if err, ok := rec.(error); ok {
		return err.Error()
	}
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(
		strings.TrimPrefix(strings.TrimPrefix(jsonQuote(rec), `"`), `"`), "\n", " "), `"`, ""))
}

func jsonQuote(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}
