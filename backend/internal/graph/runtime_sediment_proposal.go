package graph

import (
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"encoding/json"
)

type SedimentProposal struct {
	Action      string
	Id          string
	Description string
	Body        string
	Reason      string
}

type SedimentWritten struct {
	Id       string `json:"id"`
	Path     string `json:"path"`
	Replaced bool   `json:"replaced"`
}

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
