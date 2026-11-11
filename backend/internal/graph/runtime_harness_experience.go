package graph

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"encoding/json"
)

type HarnessExperienceEntry struct {
	Domain    string            `json:"domain"`
	Axis      string            `json:"axis"`
	Status    string            `json:"status"`
	Cue       string            `json:"cue"`
	Note      string            `json:"note,omitempty"`
	Lesson    string            `json:"lesson,omitempty"`
	Evidence  string            `json:"evidence,omitempty"`
	Ref       string            `json:"ref,omitempty"`
	Source    string            `json:"source,omitempty"`
	Chosen    string            `json:"chosen,omitempty"`
	Harness   string            `json:"harness,omitempty"`
	Overlay   map[string]string `json:"overlay,omitempty"`
	GraphId   string            `json:"graphId,omitempty"`
	CreatedAt int64             `json:"createdAt"`
	Kind      string            `json:"kind,omitempty"`
}

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

const (
	HARNESS_AXIS_GENERAL  = "general"
	HARNESS_AXIS_SPECIFIC = "specific"
)

const HARNESS_GENERAL_SCOPE = "general"

type harnessArtifactStore = agentToolsArtifacts

type harnessExperienceReader interface {
	List(query ArtifactQuery) ArtifactPage
	ReadVerifiedContent(taskId string, artifactId string, version int, maxBytes ...int) []byte
}

type HarnessExperienceInput struct {
	Domain string
	Scope  string
}

type HarnessExperienceResult struct {
	Domain  string                   `json:"domain,omitempty"`
	Scopes  []string                 `json:"scopes,omitempty"`
	Entries []HarnessExperienceEntry `json:"entries,omitempty"`
	Version int                      `json:"version,omitempty"`
}

func (service *graphManagementService) HarnessExperience(input HarnessExperienceInput) HarnessExperienceResult {
	scope := strings.TrimSpace(input.Scope)
	domain := strings.TrimSpace(input.Domain)
	if scope == "" && domain == "" {
		scopes, entries := harnessExperienceAll(service.artifacts, service.ownerTaskId)
		return HarnessExperienceResult{Scopes: scopes, Entries: entries}
	}
	result := HarnessExperienceResult{Domain: domain}
	if scope != "" {
		result.Entries, result.Version = harnessExperienceSnapshot(service.artifacts, service.ownerTaskId, scope)
		return result
	}
	result.Entries = append(
		harnessExperienceEntries(service.artifacts, service.ownerTaskId, harnessSlug(domain)),
		harnessExperienceEntries(service.artifacts, service.ownerTaskId, HARNESS_GENERAL_SCOPE)...,
	)
	result.Entries = append(result.Entries, harnessBacklogEntries(service.artifacts, service.ownerTaskId)...)
	return result
}

type HarnessExperienceView struct {
	Domain    string                   `json:"domain,omitempty"`
	Scopes    []string                 `json:"scopes,omitempty"`
	Entries   []HarnessExperienceEntry `json:"entries"`
	Total     int                      `json:"total"`
	Truncated bool                     `json:"truncated"`
}

const HARNESS_EXPERIENCE_READ_MAX = 12

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
	kept := matched
	if len(matched) > limit {
		kept = matched[len(matched)-limit:]
	}
	return HarnessExperienceView{
		Domain: result.Domain, Scopes: result.Scopes,
		Entries: kept, Total: len(matched), Truncated: len(matched) > len(kept),
	}
}

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

const HARNESS_EXPERIENCE_PROMPT_MAX = 5

func harnessExperiencePrompt(artifacts *ArtifactWorkspace, taskId string) string {
	if artifacts == nil || taskId == "" {
		return ""
	}
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

// A read that names no scope still has to answer: returning only the scope list
// made a status filter look at an empty set, so "no open entries" was reported
// while the ledger held more than a hundred.
func harnessExperienceAll(reader harnessExperienceReader, taskId string) ([]string, []HarnessExperienceEntry) {
	scopes := harnessExperienceScopes(reader, taskId)
	entries := []HarnessExperienceEntry{}
	for _, scope := range scopes {
		entries = append(entries, harnessExperienceEntries(reader, taskId, scope)...)
	}
	entries = append(entries, harnessBacklogEntries(reader, taskId)...)
	return scopes, entries
}

func harnessExperienceEntries(reader harnessExperienceReader, taskId, scope string) []HarnessExperienceEntry {
	entries, _ := harnessExperienceSnapshot(reader, taskId, scope)
	return entries
}

func harnessExperienceSnapshot(reader harnessExperienceReader, taskId, scope string) ([]HarnessExperienceEntry, int) {
	if reader == nil {
		return []HarnessExperienceEntry{}, 0
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
		return []HarnessExperienceEntry{}, 0
	}
	version := harnessExperienceHeadVersion(reader, taskId, name)
	body := reader.ReadVerifiedContent(taskId, record.ArtifactId, record.Version, HARNESS_EXPERIENCE_MAX_BYTES)
	if len(body) == 0 {
		return []HarnessExperienceEntry{}, version
	}
	entries := []HarnessExperienceEntry{}
	if err := json.Unmarshal(body, &entries); err != nil {
		return []HarnessExperienceEntry{}, version
	}
	for index, entry := range entries {
		entries[index] = harnessNormalizeEntry(entry)
	}
	return entries, version
}

func harnessExperienceHeadVersion(reader harnessExperienceReader, taskId, name string) int {
	if reader == nil {
		return 0
	}
	page := reader.List(ArtifactQuery{
		TaskId:    taskId,
		Namespace: HARNESS_EXPERIENCE_NAMESPACE,
		Prefix:    HARNESS_EXPERIENCE_PREFIX,
		Limit:     intPointer(50),
	})
	head := 0
	for _, artifact := range page.Artifacts {
		if artifact.Name != name || artifact.Scope == "project" {
			continue
		}
		if artifact.Version > head {
			head = artifact.Version
		}
	}
	return head
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

var harnessAnonIDPattern = regexp.MustCompile(`^[A-Z]{1,2}$`)

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
