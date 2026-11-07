package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"encoding/json"
)

func harnessRecordingId(prefix string, parts ...string) string {
	digest := sha256.New()
	for _, part := range parts {
		digest.Write([]byte(part))
		digest.Write([]byte{0})
	}
	return prefix + "-" + hex.EncodeToString(digest.Sum(nil)[:8])
}

const HARNESS_KIND_FRICTION = "friction"

const (
	HARNESS_STATUS_OPEN = "open"
	HARNESS_STATUS_ADOPTED = "adopted"
	HARNESS_STATUS_FIXED = "fixed"
	HARNESS_STATUS_REJECTED = "rejected"
)

const HARNESS_DOMAIN_ARTIFACT = "harness-domain"

func harnessDeclaredDomain(artifacts *ArtifactWorkspace, taskId string) string {
	if artifacts == nil || taskId == "" {
		return ""
	}
	page := artifacts.List(ArtifactQuery{
		TaskId:    taskId,
		Namespace: HARNESS_EXPERIENCE_NAMESPACE,
		Prefix:    HARNESS_DOMAIN_ARTIFACT,
		Limit:     intPointer(10),
	})
	record := ArtifactRecord{}
	found := false
	for _, artifact := range page.Artifacts {
		if artifact.Name != HARNESS_DOMAIN_ARTIFACT {
			continue
		}
		if !found || artifact.Scope == "project" || (record.Scope != "project" && artifact.Version > record.Version) {
			record = artifact
			found = true
		}
	}
	if !found {
		return ""
	}
	body := artifacts.ReadVerifiedContent(taskId, record.ArtifactId, record.Version, HARNESS_EXPERIENCE_MAX_BYTES)
	return strings.TrimSpace(string(body))
}

func (service *graphManagementService) harnessAdoptedOverlay(taskId, domain string) map[string]string {
	scope := harnessSlug(domain)
	for _, entry := range harnessAdoptedLessons(harnessExperienceEntries(service.artifacts, taskId, scope)) {
		if len(entry.Overlay) > 0 {
			return entry.Overlay
		}
	}
	return nil
}

func harnessAdoptedLessons(entries []HarnessExperienceEntry) []HarnessExperienceEntry {
	out := []HarnessExperienceEntry{}
	for _, entry := range entries {
		if entry.Status == HARNESS_STATUS_ADOPTED && entry.Lesson != "" && entry.Evidence != "" {
			out = append(out, entry)
		}
	}
	return out
}

type HarnessDecisionInput struct {
	GraphId string
	Domain  string
	Axis string
	Overlay   map[string]string
	Chosen    string
	Cue       string
	Lesson    string
	Evidence  string
	Harness   string
	RequestId string
}

type HarnessDecisionResult struct {
	Domain     string                   `json:"domain"`
	Axis       string                   `json:"axis"`
	Scope      string                   `json:"scope"`
	Chosen     string                   `json:"chosen"`
	Entries    []HarnessExperienceEntry `json:"entries"`
	ArtifactId string                   `json:"artifactId"`
	Version    int                      `json:"version"`
}

func (service *graphManagementService) HarnessDecision(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessDecisionInput) HarnessDecisionResult {
	input.Chosen = service.harnessResolveChosen(input.GraphId, input.Chosen)
	input.Overlay = service.harnessCandidateOverlay(input.GraphId, input.Chosen)
	return harnessRecordDecision(store, entries, input)
}

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
	merged := []HarnessExperienceEntry{}
	completed := false
	for _, existing := range entries {
		if existing.Cue == cue && !completed {
			existing.Domain = domain
			existing.Axis = axis
			existing.Status = HARNESS_STATUS_ADOPTED
			existing.Chosen = chosen
			existing.Lesson = lesson
			existing.Evidence = evidence
			existing.Harness = strings.TrimSpace(input.Harness)
			existing.Overlay = input.Overlay
			existing.GraphId = input.GraphId
			existing.Kind = ""
			merged = append(merged, existing)
			completed = true
			continue
		}
		merged = append(merged, existing)
	}
	if !completed {
		merged = append(merged, entry)
	}
	entries = merged
	body, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		Raise("invalid_input", "The lesson set could not be serialized")
	}
	content := string(body)
	requestId := strings.TrimSpace(input.RequestId)
	if requestId == "" {
		requestId = harnessRecordingId("harness-decision", scope, entry.Chosen, entry.Cue, entry.Lesson, entry.Evidence, entry.Harness)
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

func (service *graphManagementService) HarnessFriction(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessFrictionInput) HarnessFrictionResult {
	return harnessRecordFriction(store, entries, input)
}

func (service *graphManagementService) harnessCandidateOverlay(graphId, nodeId string) map[string]string {
	if graphId == "" || nodeId == "" {
		return nil
	}
	revision := service.kernel.LatestRevision(graphId)
	if revision == nil {
		return nil
	}
	node, ok := revision.Definition.Nodes[nodeId]
	if !ok || len(node.Harness) == 0 {
		return nil
	}
	overlay := map[string]string{}
	for key, text := range node.Harness {
		overlay[key] = text
	}
	return overlay
}

type HarnessFrictionInput struct {
	Domain    string
	Axis      string
	Cue       string
	Why       string
	Status    string
	Ref       string
	RequestId string
}

type HarnessFrictionResult struct {
	Domain     string                   `json:"domain"`
	Axis       string                   `json:"axis"`
	Status     string                   `json:"status"`
	Entries    []HarnessExperienceEntry `json:"entries"`
	ArtifactId string                   `json:"artifactId"`
	Version    int                      `json:"version"`
}

func harnessRecordFriction(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessFrictionInput) HarnessFrictionResult {
	if store == nil || !store.present || store.publish == nil {
		Raise("invalid_input", "The artifact surface is unavailable, so friction cannot be stored")
	}
	domain := strings.TrimSpace(input.Domain)
	if domain == "" {
		Raise("invalid_input", "A domain is required: friction is only useful where it can be found again")
	}
	cue := strings.TrimSpace(input.Cue)
	if cue == "" {
		Raise("invalid_input", "A friction needs the situation it happened in")
	}
	why := strings.TrimSpace(input.Why)
	if why == "" {
		Raise("invalid_input", "A friction needs why it matters")
	}
	if len(cue) > 2000 || len(why) > 4000 {
		Raise("invalid_input", "A cue is at most 2000 characters and a reason at most 4000")
	}
	axis := strings.TrimSpace(input.Axis)
	if axis == "" {
		axis = HARNESS_AXIS_SPECIFIC
	}
	if axis != HARNESS_AXIS_GENERAL && axis != HARNESS_AXIS_SPECIFIC {
		Raise("invalid_input", "Friction is claimed on the general or the specific axis")
	}
	status := strings.TrimSpace(input.Status)
	if status == "" {
		status = HARNESS_STATUS_OPEN
	}
	if status != HARNESS_STATUS_OPEN && status != HARNESS_STATUS_FIXED && status != HARNESS_STATUS_REJECTED {
		Raise("invalid_input", "Friction is open, fixed or rejected")
	}
	scope := harnessExperienceScope(domain, axis)
	entry := HarnessExperienceEntry{
		Domain:    domain,
		Axis:      axis,
		Status:    status,
		Cue:       cue,
		Note:      why,
		Ref:       strings.TrimSpace(input.Ref),
		CreatedAt: NowMillis(),
	}
	merged := []HarnessExperienceEntry{}
	updated := false
	for _, existing := range entries {
		if existing.Cue == cue && !updated {
			existing.Domain = domain
			existing.Axis = axis
			existing.Status = status
			existing.Note = why
			existing.Ref = strings.TrimSpace(input.Ref)
			existing.Kind = ""
			merged = append(merged, existing)
			updated = true
			continue
		}
		merged = append(merged, existing)
	}
	if !updated {
		if len(merged) >= HARNESS_EXPERIENCE_MAX_ENTRIES {
			Raise("invalid_input", fmt.Sprintf("This scope already holds %d entries; retire the oldest before adding one", HARNESS_EXPERIENCE_MAX_ENTRIES))
		}
		merged = append(merged, entry)
	}
	body, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		Raise("invalid_input", "The entry set could not be serialized")
	}
	content := string(body)
	requestId := strings.TrimSpace(input.RequestId)
	if requestId == "" {
		requestId = harnessRecordingId("harness-friction", scope, entry.Cue, entry.Status, entry.Ref, entry.Note)
	}
	published := store.publish(PublishArtifactInput{
		Namespace: HARNESS_EXPERIENCE_NAMESPACE,
		Name:      harnessExperienceName(scope),
		Content:   &content,
		MediaType: "application/json",
		Schema:    HARNESS_EXPERIENCE_SCHEMA,
		Title:     "Harness knowledge: " + scope,
		Summary:   fmt.Sprintf("%d entry/entries in %s", len(merged), scope),
		RequestId: requestId,
		Metadata:  map[string]any{"domain": harnessSlug(domain), "scope": scope, "axis": axis, "status": status},
	})
	promoted := published
	if store.promote != nil {
		if record, promoteErr := harnessPromote(store, published, requestId+"-promote"); promoteErr == nil {
			promoted = record
		}
	}
	return HarnessFrictionResult{
		Domain:     domain,
		Axis:       axis,
		Status:     status,
		Entries:    merged,
		ArtifactId: promoted.ArtifactId,
		Version:    promoted.Version,
	}
}
