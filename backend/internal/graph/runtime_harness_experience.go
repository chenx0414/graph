package graph

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"encoding/json"
)

// HarnessExperienceEntry is one piece of harness knowledge: the situation, and
// what the project knows about it.
//
// Axis says how far it reaches. A general lesson holds for every kind of work
// and is found by every domain; a specific lesson holds for the domain it was
// learned in and is found only there.
//
// Status says where the record stands: open while the situation is unsolved,
// adopted once a lesson with its evidence belongs to it, rejected when the
// project judged it not worth solving.
type HarnessExperienceEntry struct {
	Domain string `json:"domain"`
	Axis   string `json:"axis"`
	Status string `json:"status"`
	// Cue is the situation, and the identity of the record: one record per
	// scope and cue.
	Cue string `json:"cue"`
	// Note says why the situation matters. It belongs to the friction.
	Note string `json:"note,omitempty"`
	// Lesson is what to do about the situation.
	Lesson string `json:"lesson,omitempty"`
	// Evidence is what shows the lesson worked.
	Evidence string `json:"evidence,omitempty"`
	// Ref points at what addressed the situation: a commit, a legacy id.
	Ref string `json:"ref,omitempty"`
	// Source says where the record came from: the store, or the retired
	// backlog artifact the project used before.
	Source string `json:"source,omitempty"`
	// Chosen names the candidate a lesson was adopted from.
	Chosen string `json:"chosen,omitempty"`
	// Harness is the harness change that produced the adopted behavior.
	Harness string `json:"harness,omitempty"`
	// Overlay is the prompt text the adopted candidate ran under. A later
	// probe can start from it, so each round builds on the last winner
	// instead of every round starting from nothing.
	Overlay   map[string]string `json:"overlay,omitempty"`
	GraphId   string            `json:"graphId,omitempty"`
	CreatedAt int64             `json:"createdAt"`
	// Kind is the old name for the stage. It is read for the records written
	// before the two stages became one, and never written.
	Kind string `json:"kind,omitempty"`
}

// harnessNormalizeEntry brings a record written before the two stages became
// one into the current shape. The old friction kept its note in the lesson
// field and what addressed it in the evidence field.
func harnessNormalizeEntry(entry HarnessExperienceEntry) HarnessExperienceEntry {
	if entry.Kind != HARNESS_KIND_FRICTION {
		return entry
	}
	if entry.Note == "" {
		entry.Note = entry.Lesson
	}
	if entry.Ref == "" {
		entry.Ref = entry.Evidence
	}
	entry.Lesson = ""
	entry.Evidence = ""
	return entry
}

// The two axes a lesson can be claimed on.
const (
	// HARNESS_AXIS_GENERAL is a lesson that holds for every kind of work.
	HARNESS_AXIS_GENERAL = "general"
	// HARNESS_AXIS_SPECIFIC is a lesson that holds for one domain.
	HARNESS_AXIS_SPECIFIC = "specific"
)

// HARNESS_GENERAL_SCOPE is the scope the general lessons live in. Every
// domain reads it, which is what makes a general lesson general.
const HARNESS_GENERAL_SCOPE = "general"

type harnessArtifactStore = agentToolsArtifacts

type harnessExperienceReader interface {
	List(query ArtifactQuery) ArtifactPage
	ReadVerifiedContent(taskId string, artifactId string, version int, maxBytes ...int) []byte
}

type HarnessExperienceInput struct {
	Domain string
	// Scope reads one scope only. Empty means the domain's own scope.
	Scope string
}

type HarnessExperienceResult struct {
	Domain string `json:"domain,omitempty"`
	// Scopes names the scopes that hold knowledge.
	Scopes []string `json:"scopes,omitempty"`
	// Entries are everything the domain should know: its own entries and the
	// ones that hold for every domain. One list, because it is one body of
	// knowledge; each entry says which axis it belongs to.
	Entries []HarnessExperienceEntry `json:"entries,omitempty"`
}

// HarnessExperience reads the lessons earlier tasks adopted.
//
// With a domain it returns that domain's own lessons and the general ones:
// a lesson claimed on the general axis is found by every domain, which is the
// whole point of claiming it that way. With a scope it returns one scope only,
// which is what the recording path needs before it appends to it.
func (service *graphManagementService) HarnessExperience(input HarnessExperienceInput) HarnessExperienceResult {
	scope := strings.TrimSpace(input.Scope)
	domain := strings.TrimSpace(input.Domain)
	if scope == "" && domain == "" {
		return HarnessExperienceResult{Scopes: harnessExperienceScopes(service.artifacts, service.ownerTaskId)}
	}
	result := HarnessExperienceResult{Domain: domain}
	if scope != "" {
		result.Entries = harnessExperienceEntries(service.artifacts, service.ownerTaskId, scope)
		return result
	}
	// One list: the domain's own records, the ones that hold for every domain,
	// and the friction the retired backlog artifact still holds. The backlog is
	// the project's own history, so it belongs where the rest of its knowledge
	// is read from.
	result.Entries = append(
		harnessExperienceEntries(service.artifacts, service.ownerTaskId, harnessSlug(domain)),
		harnessExperienceEntries(service.artifacts, service.ownerTaskId, HARNESS_GENERAL_SCOPE)...,
	)
	result.Entries = append(result.Entries, harnessBacklogEntries(service.artifacts, service.ownerTaskId)...)
	return result
}

// HarnessExperienceView is what one read answers: the records that matched,
// bounded, and how many there were.
type HarnessExperienceView struct {
	Domain      string                   `json:"domain,omitempty"`
	Scopes      []string                 `json:"scopes,omitempty"`
	Entries     []HarnessExperienceEntry `json:"entries"`
	Total       int                      `json:"total"`
	Truncated   bool                     `json:"truncated"`
}

// HARNESS_EXPERIENCE_READ_MAX bounds one read when the caller names no limit.
const HARNESS_EXPERIENCE_READ_MAX = 12

// harnessExperiencePage narrows one read.
//
// Measured 2026-11-02: the read answered with the whole scope - about 46 KB in
// this project - because the call could not say what it was looking for. A
// caller that wants "what is still open" now says so, and pays for that list
// instead of the whole history.
func harnessExperiencePage(result HarnessExperienceResult, status string, limit int) HarnessExperienceView {
	status = strings.TrimSpace(status)
	if limit <= 0 || limit > 200 {
		limit = HARNESS_EXPERIENCE_READ_MAX
	}
	matched := []HarnessExperienceEntry{}
	for _, entry := range result.Entries {
		if status != "" && !strings.EqualFold(entry.Status, status) {
			continue
		}
		matched = append(matched, entry)
	}
	// The slice is the newest one, because a caller that just recorded something
	// has to be able to read it back without asking for the whole history. The
	// order inside the slice stays oldest first, which is how it reads.
	kept := matched
	if len(matched) > limit {
		kept = matched[len(matched)-limit:]
	}
	return HarnessExperienceView{
		Domain: result.Domain, Scopes: result.Scopes,
		Entries: kept, Total: len(matched), Truncated: len(matched) > len(kept),
	}
}

// harnessWrittenEntry is the record a write just produced: the one with this
// cue, or the newest record when the caller named no cue.
func harnessWrittenEntry(entries []HarnessExperienceEntry, cue string) *HarnessExperienceEntry {
	if cue != "" {
		for index := range entries {
			if entries[index].Cue == cue {
				return &entries[index]
			}
		}
	}
	if len(entries) > 0 {
		return &entries[len(entries)-1]
	}
	return nil
}

// HARNESS_EXPERIENCE_PROMPT_MAX bounds how many lessons travel in a prompt.
const HARNESS_EXPERIENCE_PROMPT_MAX = 5

// harnessExperiencePrompt renders the lessons that hold for every kind of work
// as a short block for the system prompt.
//
// Only the general scope travels: a lesson claimed for every kind of work
// belongs to every task, and a domain lesson needs a domain the host does not
// know. The block states what happened and what it was based on; it never
// states a conclusion the host would enforce.
func harnessExperiencePrompt(artifacts *ArtifactWorkspace, taskId string) string {
	if artifacts == nil || taskId == "" {
		return ""
	}
	// The lessons that reach a task are the ones of the kind of work the
	// project declared, plus the ones that hold for every kind of work.
	entries := []HarnessExperienceEntry{}
	if domain := harnessDeclaredDomain(artifacts, taskId); domain != "" {
		entries = append(entries, harnessAdoptedLessons(harnessExperienceEntries(artifacts, taskId, harnessSlug(domain)))...)
	}
	entries = append(entries, harnessAdoptedLessons(harnessExperienceEntries(artifacts, taskId, HARNESS_GENERAL_SCOPE))...)
	if len(entries) == 0 {
		return ""
	}
	lines := []string{}
	for _, entry := range entries {
		if len(lines) >= HARNESS_EXPERIENCE_PROMPT_MAX {
			break
		}
		cue := harnessEvidenceBound(entry.Cue, 200)
		lesson := harnessEvidenceBound(entry.Lesson, 300)
		evidence := harnessEvidenceBound(entry.Evidence, 160)
		// The three parts are one thing: a situation, what to do, and what
		// shows it worked. Without the evidence there is nothing to inject.
		if cue == "" || lesson == "" || evidence == "" {
			continue
		}
		lines = append(lines, "- "+cue+" -> "+lesson+" (because "+evidence+")")
	}
	if len(lines) == 0 {
		return ""
	}
	return "Lessons earlier runs of this project learned:\n" + strings.Join(lines, "\n")
}

// harnessExperienceScope is the scope a lesson lands in: the general scope for
// a general lesson, the domain's own scope for a specific one.
func harnessExperienceScope(domain, axis string) string {
	if axis == HARNESS_AXIS_GENERAL {
		return HARNESS_GENERAL_SCOPE
	}
	return harnessSlug(domain)
}

func harnessExperienceName(domain string) string {
	return HARNESS_EXPERIENCE_PREFIX + "-" + harnessSlug(domain)
}

func harnessSlug(domain string) string {
	normalized := strings.ToLower(strings.TrimSpace(domain))
	out := []rune{}
	for _, r := range normalized {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			out = append(out, r)
		case r == '-' || r == '_':
			out = append(out, r)
		case r == ' ' || r == '/' || r == '.':
			out = append(out, '-')
		}
	}
	slug := strings.Trim(string(out), "-")
	if slug == "" {
		return "unknown"
	}
	if len(slug) > 80 {
		slug = slug[:80]
	}
	return slug
}

func harnessExperienceEntries(reader harnessExperienceReader, taskId, scope string) []HarnessExperienceEntry {
	if reader == nil {
		return []HarnessExperienceEntry{}
	}
	name := harnessExperienceName(scope)
	page := reader.List(ArtifactQuery{
		TaskId:    taskId,
		Namespace: HARNESS_EXPERIENCE_NAMESPACE,
		Prefix:    HARNESS_EXPERIENCE_PREFIX,
		Limit:     intPointer(50),
	})
	best := map[string]ArtifactRecord{}
	for _, artifact := range page.Artifacts {
		if artifact.Name != name {
			continue
		}
		current, ok := best[name]
		if !ok || artifact.Scope == "project" || (current.Scope != "project" && artifact.Version > current.Version) {
			best[name] = artifact
		}
	}
	record, ok := best[name]
	if !ok {
		return []HarnessExperienceEntry{}
	}
	body := reader.ReadVerifiedContent(taskId, record.ArtifactId, record.Version, HARNESS_EXPERIENCE_MAX_BYTES)
	if len(body) == 0 {
		return []HarnessExperienceEntry{}
	}
	entries := []HarnessExperienceEntry{}
	if err := json.Unmarshal(body, &entries); err != nil {
		return []HarnessExperienceEntry{}
	}
	for index, entry := range entries {
		entries[index] = harnessNormalizeEntry(entry)
	}
	return entries
}

func harnessExperienceScopes(reader harnessExperienceReader, taskId string) []string {
	if reader == nil {
		return []string{}
	}
	page := reader.List(ArtifactQuery{
		TaskId:    taskId,
		Namespace: HARNESS_EXPERIENCE_NAMESPACE,
		Prefix:    HARNESS_EXPERIENCE_PREFIX,
		Limit:     intPointer(50),
	})
	seen := map[string]bool{}
	scopes := []string{}
	for _, artifact := range page.Artifacts {
		scope := strings.TrimPrefix(artifact.Name, HARNESS_EXPERIENCE_PREFIX+"-")
		if scope == "" || seen[scope] {
			continue
		}
		seen[scope] = true
		scopes = append(scopes, scope)
	}
	sort.Strings(scopes)
	return scopes
}

func harnessPromote(store *harnessArtifactStore, published ArtifactRecord, requestId string) (record ArtifactRecord, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("%v", recovered)
		}
	}()
	return store.promote(ArtifactPromoteInput{
		ArtifactId: published.ArtifactId,
		Version:    published.Version,
		RequestId:  requestId,
	}), nil
}

// harnessAnonIDPattern matches an anonymous candidate id.
var harnessAnonIDPattern = regexp.MustCompile(`^[A-Z]{1,2}$`)

// harnessResolveChosen turns an anonymous candidate id into the node that ran
// it.
//
// The letter only means something inside the comparison it came from. A lesson
// that is read months later has to say which candidate was adopted, and the
// node id is what a reader can still understand.
func (service *graphManagementService) harnessResolveChosen(graphId string, chosen string) string {
	chosen = strings.TrimSpace(chosen)
	if graphId == "" || !harnessAnonIDPattern.MatchString(chosen) {
		return chosen
	}
	nodeIds := []string{}
	for _, row := range kernelRows(service.kernel.Db, "SELECT node_id FROM kernel_nodes WHERE task_id=? ORDER BY node_id", graphId) {
		nodeIds = append(nodeIds, kernelString(row["node_id"]))
	}
	if len(nodeIds) == 0 {
		return chosen
	}
	index := 0
	for _, letter := range chosen {
		index = index*26 + int(letter-'A') + 1
	}
	index--
	if index < 0 || index >= len(nodeIds) {
		return chosen
	}
	return nodeIds[index]
}
