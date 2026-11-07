// graph:table-writes-exempt: no table is written by this test
package graph

import (
	"testing"
)

type harnessHeadStore struct {
	head   int64
	writes int
	seen   []int64
}

func (fake *harnessHeadStore) store(t *testing.T) *harnessArtifactStore {
	t.Helper()
	artifacts := agentToolsArtifacts{present: true, publish: func(input PublishArtifactInput) ArtifactRecord {
		if input.ExpectedVersion == nil {
			t.Fatalf("publish ran with no version guard, so a concurrent record can be lost silently")
		}
		fake.seen = append(fake.seen, *input.ExpectedVersion)
		if *input.ExpectedVersion != fake.head {
			Raise("artifact_conflict", "Artifact head changed")
		}
		fake.head++
		fake.writes++
		return ArtifactRecord{ArtifactId: "harness-doc", Version: int(fake.head)}
	}}
	return &artifacts
}

func harnessDecisionFixture(version int64) HarnessDecisionInput {
	return HarnessDecisionInput{
		Domain:          "parser",
		Axis:            HARNESS_AXIS_GENERAL,
		Chosen:          "A",
		Cue:             "A document with a folded header.",
		Lesson:          "Unfold the header before mapping columns.",
		Evidence:        "The candidate that unfolded it mapped the columns.",
		ExpectedVersion: &version,
	}
}

func TestHarnessDecisionFailsLoudlyWhenTheHeadMovedUnderIt(t *testing.T) {
	fake := &harnessHeadStore{}
	store := fake.store(t)
	first := harnessDecisionFixture(0)
	if result := harnessRecordDecision(store, []HarnessExperienceEntry{}, first); len(result.Entries) != 1 {
		t.Fatalf("the first record did not land: %+v", result)
	}
	stale := harnessDecisionFixture(0)
	code := ""
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				if problem, ok := recovered.(*RuntimeError); ok {
					code = problem.Code
				}
			}
		}()
		harnessRecordDecision(store, []HarnessExperienceEntry{}, stale)
	}()
	if code != "artifact_conflict" {
		t.Fatalf("a record written against a stale head was accepted instead of raising artifact_conflict (code=%q, writes=%d)", code, fake.writes)
	}
	if fake.writes != 1 {
		t.Fatalf("the stale write reached the store: %d writes", fake.writes)
	}
}

func TestHarnessRetryConflictRereadsAfterAConflictSoBothRecordsLand(t *testing.T) {
	fake := &harnessHeadStore{}
	store := fake.store(t)
	entries := []HarnessExperienceEntry{}
	attempts := 0
	versions := []int64{}
	harnessRetryConflict(func() {
		attempts++
		version := fake.head
		versions = append(versions, version)
		fake.seen = fake.seen[:0]
		harnessRecordDecision(store, entries, harnessDecisionFixture(version))
		fake.seen = append([]int64{}, version)
	})
	if attempts != 1 {
		t.Fatalf("an uncontended record needed %d attempts", attempts)
	}
	if fake.head != 1 {
		t.Fatalf("the record did not land: head=%d", fake.head)
	}
}

func TestHarnessRetryConflictRetriesTheRetryableCodeOnly(t *testing.T) {
	calls := 0
	harnessRetryConflict(func() {
		calls++
		if calls < 3 {
			Raise("artifact_conflict", "Artifact head changed")
		}
	})
	if calls != 3 {
		t.Fatalf("the retry loop made %d calls instead of 3", calls)
	}
	fatal := 0
	code := ""
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				if problem, ok := recovered.(*RuntimeError); ok {
					code = problem.Code
				}
			}
		}()
		harnessRetryConflict(func() {
			fatal++
			Raise("invalid_input", "A lesson needs a cue")
		})
	}()
	if fatal != 1 || code != "invalid_input" {
		t.Fatalf("a non-retryable error was retried (%d calls) or swallowed (code=%q)", fatal, code)
	}
}

func TestHarnessFrictionAlsoGuardsTheHead(t *testing.T) {
	fake := &harnessHeadStore{}
	store := fake.store(t)
	version := int64(0)
	if result := harnessRecordFriction(store, []HarnessExperienceEntry{}, HarnessFrictionInput{
		Domain: "parser", Axis: HARNESS_AXIS_GENERAL, Cue: "A table with no header.", Why: "The columns had to be guessed.", ExpectedVersion: &version,
	}); len(result.Entries) != 1 {
		t.Fatalf("friction did not land: %+v", result)
	}
	staleVersion := int64(0)
	code := ""
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				if problem, ok := recovered.(*RuntimeError); ok {
					code = problem.Code
				}
			}
		}()
		harnessRecordFriction(store, []HarnessExperienceEntry{}, HarnessFrictionInput{
			Domain: "parser", Axis: HARNESS_AXIS_GENERAL, Cue: "A heading with no body.", Why: "Nothing to work from.", ExpectedVersion: &staleVersion,
		})
	}()
	if code != "artifact_conflict" {
		t.Fatalf("friction written against a stale head was accepted (code=%q)", code)
	}
}

type harnessReaderFixture struct {
	artifacts []ArtifactRecord
	bodies    map[string]string
}

func (fake harnessReaderFixture) List(query ArtifactQuery) ArtifactPage {
	return ArtifactPage{Artifacts: fake.artifacts}
}

func (fake harnessReaderFixture) ReadVerifiedContent(taskId string, artifactId string, version int, maxBytes ...int) []byte {
	return []byte(fake.bodies[artifactId])
}

func TestHarnessDecisionReadReportsTheHeadItSawSoTheNextWriteCanGuardIt(t *testing.T) {
	reader := harnessReaderFixture{
		artifacts: []ArtifactRecord{
			{ArtifactId: "task-doc", Name: harnessExperienceName("parser"), Version: 4},
			{ArtifactId: "project-doc", Name: harnessExperienceName("parser"), Version: 3, Scope: "project"},
		},
		bodies: map[string]string{"project-doc": "[]"},
	}
	_, version := harnessExperienceSnapshot(reader, "task", "parser")
	if version != 4 {
		t.Fatalf("the read reported head version %d instead of the task-scoped 4", version)
	}
	empty := harnessReaderFixture{}
	if _, none := harnessExperienceSnapshot(empty, "task", "parser"); none != 0 {
		t.Fatalf("a scope with no document reported version %d instead of 0", none)
	}
}
