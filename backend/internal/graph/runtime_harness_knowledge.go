package graph

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The knowledge side of the harness store: what a project met and what it
// adopted, and the two ways one is found again.
//
// A friction is a suspicion the project has not resolved. A lesson is what the
// project saw happen and chose to keep. They are the same kind of record at
// two stages, so they share one store - but only a lesson travels into a
// prompt, because a guess is not a fact.

// The two kinds of harness knowledge.
const (
	// HARNESS_KIND_FRICTION is something the project met and has not solved.
	HARNESS_KIND_FRICTION = "friction"
	// HARNESS_KIND_LESSON is something the project adopted, with evidence.
	HARNESS_KIND_LESSON = "lesson"
)

// Where a piece of harness knowledge stands.
const (
	// HARNESS_STATUS_OPEN is friction that is still open.
	HARNESS_STATUS_OPEN = "open"
	// HARNESS_STATUS_ADOPTED is a lesson the project adopted.
	HARNESS_STATUS_ADOPTED = "adopted"
	// HARNESS_STATUS_FIXED is friction that was addressed.
	HARNESS_STATUS_FIXED = "fixed"
	// HARNESS_STATUS_REJECTED is friction that was judged not worth fixing.
	HARNESS_STATUS_REJECTED = "rejected"
)

// HARNESS_DOMAIN_ARTIFACT is the artifact that holds the kind of work this
// project does. Its lessons reach every task of the project.
const HARNESS_DOMAIN_ARTIFACT = "harness-domain"

// harnessDeclaredDomain is the kind of work this project does, as the project
// declared it. An empty name means the project never said.
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

// harnessAdoptedOverlay is the prompt text the project last adopted in a scope.
// The most recent adopted lesson wins: it is the harness the project runs under
// now.
func (service *graphManagementService) harnessAdoptedOverlay(taskId, domain string) map[string]string {
	scope := harnessSlug(domain)
	for _, entry := range harnessAdoptedLessons(harnessExperienceEntries(service.artifacts, taskId, scope)) {
		if len(entry.Overlay) > 0 {
			return entry.Overlay
		}
	}
	return nil
}

// harnessAdoptedLessons keeps the lessons a project adopted. A friction is a
// suspicion and does not travel into a prompt.
func harnessAdoptedLessons(entries []HarnessExperienceEntry) []HarnessExperienceEntry {
	out := []HarnessExperienceEntry{}
	for _, entry := range entries {
		if entry.Kind == HARNESS_KIND_LESSON && entry.Status == HARNESS_STATUS_ADOPTED {
			out = append(out, entry)
		}
	}
	return out
}

// HarnessFriction records friction the project met but has not solved, in the
// same store the adopted lessons live in.
func (service *graphManagementService) HarnessFriction(store *harnessArtifactStore, entries []HarnessExperienceEntry, input HarnessFrictionInput) HarnessFrictionResult {
	return harnessRecordFriction(store, entries, input)
}

// harnessCandidateOverlay is the prompt text one candidate ran under.
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

// HarnessFrictionInput records friction the project met but has not solved.
type HarnessFrictionInput struct {
	Domain    string
	Axis      string
	Cue       string
	Why       string
	Status    string
	Ref       string
	RequestId string
}

// HarnessFrictionResult is what a recorded friction returns.
type HarnessFrictionResult struct {
	Domain     string                   `json:"domain"`
	Axis       string                   `json:"axis"`
	Status     string                   `json:"status"`
	Entries    []HarnessExperienceEntry `json:"entries"`
	ArtifactId string                   `json:"artifactId"`
	Version    int                      `json:"version"`
}

// harnessRecordFriction records a piece of friction in a scope, or moves the
// one it already recorded there to a new status. The cue names the friction, so
// the same friction is updated rather than duplicated.
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
		Kind:      HARNESS_KIND_FRICTION,
		Status:    status,
		Cue:       cue,
		Lesson:    why,
		Evidence:  strings.TrimSpace(input.Ref),
		CreatedAt: NowMillis(),
	}
	merged := []HarnessExperienceEntry{}
	updated := false
	for _, existing := range entries {
		if existing.Kind == HARNESS_KIND_FRICTION && existing.Cue == cue {
			if updated {
				continue
			}
			entry.CreatedAt = existing.CreatedAt
			merged = append(merged, entry)
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
		requestId = "harness-friction-" + harnessSlug(scope) + "-" + itoa(int(entry.CreatedAt))
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
		Metadata:  map[string]any{"domain": harnessSlug(domain), "scope": scope, "axis": axis, "kind": HARNESS_KIND_FRICTION},
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
