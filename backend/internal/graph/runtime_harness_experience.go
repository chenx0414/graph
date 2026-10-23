package graph

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// The harness experience store holds what a project has learned about its own
// harness: the friction it has met and the lessons it has adopted. They are one
// body of knowledge at two stages - something noticed, and something that
// worked - so they live in one store and are read by one tool.
//
// Only the adopted lessons travel into a prompt. A friction is a suspicion; a
// lesson is what the project saw happen. Injecting both would put guesses in
// front of the next task as if they were facts.

// HarnessExperienceEntry is one piece of harness knowledge: what the situation
// looked like, what to do about it, and what shows that it worked.
//
// Axis says how far it reaches. A general lesson holds for every kind of work
// and is found by every domain; a specific lesson holds for the domain it was
// learned in and is found only there.
//
// Kind says which stage it is at: a friction is noticed, a lesson is adopted.
// Status says where a friction stands.
type HarnessExperienceEntry struct {
	Domain   string `json:"domain"`
	Axis     string `json:"axis"`
	Kind     string `json:"kind"`
	Status   string `json:"status"`
	Chosen   string `json:"chosen,omitempty"`
	Cue      string `json:"cue"`
	Lesson   string `json:"lesson,omitempty"`
	Evidence string `json:"evidence,omitempty"`
	Harness  string `json:"harness,omitempty"`
	// Overlay is the prompt text the adopted candidate ran under. A later
	// probe can start from it, so each round builds on the last winner
	// instead of every round starting from nothing.
	Overlay   map[string]string `json:"overlay,omitempty"`
	GraphId   string            `json:"graphId,omitempty"`
	CreatedAt int64             `json:"createdAt"`
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

// HarnessDecisionInput records which candidate was adopted and why.
type HarnessDecisionInput struct {
	GraphId string
	Domain  string
	// Axis is general or specific. It decides the scope the lesson lands in.
	Axis string
	// Overlay is the prompt text the adopted candidate ran under.
	Overlay   map[string]string
	Chosen    string
	Cue       string
	Lesson    string
	Evidence  string
	Harness   string
	RequestId string
}

// HarnessDecisionResult is what a recorded decision returns.

type HarnessDecisionResult struct {
	Domain     string                   `json:"domain"`
	Axis       string                   `json:"axis"`
	Scope      string                   `json:"scope"`
	Chosen     string                   `json:"chosen"`
	Entries    []HarnessExperienceEntry `json:"entries"`
	ArtifactId string                   `json:"artifactId"`
	Version    int                      `json:"version"`
}

// harnessArtifactStore is the artifact surface the harness tools use. The
// session's artifact service fills in the producer, so a lesson is written the
// same way every other artifact is written.

type harnessArtifactStore = agentToolsArtifacts

// harnessExperienceReader reads the lesson set of one domain from the shared
// artifact workspace.
//
// The read is scope-free on purpose. A lesson another task promoted lives in
// the project scope, and the next task of that domain has to find it - a read
// that only looked at the current task's own artifacts would find nothing.

type harnessExperienceReader interface {
	List(query ArtifactQuery) ArtifactPage
	ReadVerifiedContent(taskId string, artifactId string, version int, maxBytes ...int) []byte
}

// harnessAnonID names the n-th candidate. A, B, C ... AA, AB: a chooser reads
// one of these without learning which lane produced it.

type HarnessExperienceInput struct {
	Domain string
	// Scope reads one scope only. Empty means the domain's own scope.
	Scope string
}

// HarnessExperienceResult is what one read returns. With no domain it names
// the domains that hold lessons.

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
	result.Entries = append(
		harnessExperienceEntries(service.artifacts, service.ownerTaskId, harnessSlug(domain)),
		harnessExperienceEntries(service.artifacts, service.ownerTaskId, HARNESS_GENERAL_SCOPE)...,
	)
	return result
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
		if cue == "" || lesson == "" {
			continue
		}
		line := "- " + cue + " -> " + lesson
		if entry.Evidence != "" {
			line += " (because " + harnessEvidenceBound(entry.Evidence, 160) + ")"
		}
		lines = append(lines, line)
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

// harnessSlug reduces a domain name to the slug the artifact store accepts.

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

// harnessExperienceEntries reads the lessons of one scope, newest store
// first. The project scope wins over the task scope: a lesson another task
// already promoted is the lesson this task must see.

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
	return entries
}

// harnessExperienceScopes lists the scopes that hold lessons.

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

// harnessPromote promotes one artifact version, turning a refusal into an
// error instead of a panic: the caller keeps what it already has.

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

// HarnessDecision records which candidate was adopted and the lesson that came
// with it.
func (service *graphManagementService) HarnessDecision(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessDecisionInput) HarnessDecisionResult {
	input.Chosen = service.harnessResolveChosen(input.GraphId, input.Chosen)
	input.Overlay = service.harnessCandidateOverlay(input.GraphId, input.Chosen)
	return harnessRecordDecision(store, entries, input)
}

// harnessRecordDecision appends one adopted lesson to a domain's store and
// promotes it, so the next task of that domain finds it.

func harnessRecordDecision(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessDecisionInput) HarnessDecisionResult {
	if store == nil || !store.present || store.publish == nil {
		Raise("invalid_input", "The artifact surface is unavailable, so a lesson cannot be stored")
	}
	domain := strings.TrimSpace(input.Domain)
	if domain == "" {
		Raise("invalid_input", "A domain is required: the lesson is only useful where it can be found again")
	}
	chosen := strings.TrimSpace(input.Chosen)
	if chosen == "" {
		Raise("invalid_input", "The chosen candidate is required")
	}
	cue := strings.TrimSpace(input.Cue)
	lesson := strings.TrimSpace(input.Lesson)
	evidence := strings.TrimSpace(input.Evidence)
	if cue == "" || lesson == "" || evidence == "" {
		Raise("invalid_input", "A lesson needs a cue, a lesson and the evidence that supports it")
	}
	if len(cue) > 2000 || len(lesson) > 4000 || len(evidence) > 4000 {
		Raise("invalid_input", "A cue is at most 2000 characters, a lesson and its evidence at most 4000")
	}
	if len(entries) >= HARNESS_EXPERIENCE_MAX_ENTRIES {
		Raise("invalid_input", fmt.Sprintf("This domain already holds %d lessons; retire the oldest before adding one", HARNESS_EXPERIENCE_MAX_ENTRIES))
	}
	axis := strings.TrimSpace(input.Axis)
	if axis == "" {
		axis = HARNESS_AXIS_SPECIFIC
	}
	if axis != HARNESS_AXIS_GENERAL && axis != HARNESS_AXIS_SPECIFIC {
		Raise("invalid_input", "A lesson is claimed on the general or the specific axis")
	}
	scope := harnessExperienceScope(domain, axis)
	entry := HarnessExperienceEntry{
		Domain:    domain,
		Axis:      axis,
		Kind:      HARNESS_KIND_LESSON,
		Status:    HARNESS_STATUS_ADOPTED,
		Chosen:    chosen,
		Cue:       cue,
		Lesson:    lesson,
		Evidence:  evidence,
		Harness:   strings.TrimSpace(input.Harness),
		Overlay:   input.Overlay,
		GraphId:   input.GraphId,
		CreatedAt: NowMillis(),
	}
	entries = append(entries, entry)
	body, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		Raise("invalid_input", "The lesson set could not be serialized")
	}
	content := string(body)
	requestId := strings.TrimSpace(input.RequestId)
	if requestId == "" {
		requestId = "harness-decision-" + harnessSlug(domain) + "-" + itoa(int(entry.CreatedAt))
	}
	published := store.publish(PublishArtifactInput{
		Namespace: HARNESS_EXPERIENCE_NAMESPACE,
		Name:      harnessExperienceName(scope),
		Content:   &content,
		MediaType: "application/json",
		Schema:    HARNESS_EXPERIENCE_SCHEMA,
		Title:     "Harness lessons: " + scope,
		Summary:   fmt.Sprintf("%d lesson(s) adopted in %s", len(entries), scope),
		RequestId: requestId,
		Metadata:  map[string]any{"domain": harnessSlug(domain), "scope": scope, "axis": axis, "chosen": chosen},
	})
	promoted := published
	if store.promote != nil {
		// A task that belongs to no project keeps the lesson in its own scope:
		// there is no project scope to promote it to, and a lesson that was
		// already written must not be lost to that.
		if record, promoteErr := harnessPromote(store, published, requestId+"-promote"); promoteErr == nil {
			promoted = record
		}
	}
	return HarnessDecisionResult{
		Domain:     domain,
		Axis:       axis,
		Scope:      scope,
		Chosen:     chosen,
		Entries:    entries,
		ArtifactId: promoted.ArtifactId,
		Version:    promoted.Version,
	}
}
