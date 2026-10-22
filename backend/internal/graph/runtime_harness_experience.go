package graph

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// The harness experience store keeps the lessons earlier tasks adopted per
// domain, so the next task of that domain starts from what was learned.

// HarnessExperienceEntry is one adopted lesson: what the situation looked like,
// what to do about it, and what shows that it worked.
type HarnessExperienceEntry struct {
	Domain    string `json:"domain"`
	Chosen    string `json:"chosen"`
	Cue       string `json:"cue"`
	Lesson    string `json:"lesson"`
	Evidence  string `json:"evidence"`
	Harness   string `json:"harness,omitempty"`
	GraphId   string `json:"graphId,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

// HarnessComparison is the contrast of several candidates of one task.

// HarnessDecisionInput records which candidate was adopted and why.
type HarnessDecisionInput struct {
	GraphId   string
	Domain    string
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
}

// HarnessExperienceResult is what one read returns. With no domain it names
// the domains that hold lessons.

type HarnessExperienceResult struct {
	Domain  string                   `json:"domain,omitempty"`
	Domains []string                 `json:"domains,omitempty"`
	Entries []HarnessExperienceEntry `json:"entries,omitempty"`
}

// HarnessExperience reads the lessons earlier tasks adopted per domain.

func (service *graphManagementService) HarnessExperience(input HarnessExperienceInput) HarnessExperienceResult {
	domain := strings.TrimSpace(input.Domain)
	if domain == "" {
		return HarnessExperienceResult{Domains: harnessExperienceDomains(service.artifacts, service.ownerTaskId)}
	}
	return HarnessExperienceResult{
		Domain:  domain,
		Entries: harnessExperienceEntries(service.artifacts, service.ownerTaskId, domain),
	}
}

// harnessCandidateFacts collects the recorded behavior of each candidate.

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

// harnessExperienceEntries reads the lessons of one domain, newest store
// first. The project scope wins over the task scope: a lesson another task
// already promoted is the lesson this task must see.

func harnessExperienceEntries(reader harnessExperienceReader, taskId, domain string) []HarnessExperienceEntry {
	if reader == nil {
		return []HarnessExperienceEntry{}
	}
	name := harnessExperienceName(domain)
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

// harnessExperienceDomains lists the domains that hold lessons.

func harnessExperienceDomains(reader harnessExperienceReader, taskId string) []string {
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
	domains := []string{}
	for _, artifact := range page.Artifacts {
		domain := strings.TrimPrefix(artifact.Name, HARNESS_EXPERIENCE_PREFIX)
		if domain == "" || seen[domain] {
			continue
		}
		seen[domain] = true
		domains = append(domains, domain)
	}
	sort.Strings(domains)
	return domains
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
	entry := HarnessExperienceEntry{
		Domain:    domain,
		Chosen:    chosen,
		Cue:       cue,
		Lesson:    lesson,
		Evidence:  evidence,
		Harness:   strings.TrimSpace(input.Harness),
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
		Name:      harnessExperienceName(domain),
		Content:   &content,
		MediaType: "application/json",
		Schema:    HARNESS_EXPERIENCE_SCHEMA,
		Title:     "Harness lessons: " + domain,
		Summary:   fmt.Sprintf("%d lesson(s) adopted in %s", len(entries), domain),
		RequestId: requestId,
		Metadata:  map[string]any{"domain": harnessSlug(domain), "chosen": chosen},
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
		Chosen:     chosen,
		Entries:    entries,
		ArtifactId: promoted.ArtifactId,
		Version:    promoted.Version,
	}
}
