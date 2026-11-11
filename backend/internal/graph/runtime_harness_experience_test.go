package graph

import (
	"encoding/json"
	"testing"
)

type fakeExperienceReader struct {
	artifacts []ArtifactRecord
	content   map[string][]byte
}

func (reader fakeExperienceReader) List(ArtifactQuery) ArtifactPage {
	return ArtifactPage{Artifacts: reader.artifacts}
}

func (reader fakeExperienceReader) ReadVerifiedContent(string, string, int, ...int) []byte {
	for name, body := range reader.content {
		if name == "content" {
			return body
		}
	}
	return nil
}

func experienceEntryBody(t *testing.T, entries ...HarnessExperienceEntry) []byte {
	t.Helper()
	body, err := json.Marshal(entries)
	if err != nil {
		t.Fatalf("marshal entries: %v", err)
	}
	return body
}

func experienceReaderWith(t *testing.T, scope string, entries ...HarnessExperienceEntry) fakeExperienceReader {
	t.Helper()
	name := harnessExperienceName(scope)
	return fakeExperienceReader{
		artifacts: []ArtifactRecord{{ArtifactId: "a1", Name: name, Version: 1, Namespace: HARNESS_EXPERIENCE_NAMESPACE}},
		content:   map[string][]byte{"content": experienceEntryBody(t, entries...)},
	}
}

// A read without a domain still has to answer: a status filter that only ever
// saw the scope list reported "no open entries" while the ledger held dozens.
func TestExperienceReadWithoutDomainReturnsEveryScope(t *testing.T) {
	reader := experienceReaderWith(t, "graph-self-improvement",
		HarnessExperienceEntry{Status: "open", Cue: "one"}, HarnessExperienceEntry{Status: "fixed", Cue: "two"})
	scopes, entries := harnessExperienceAll(reader, "task-1")
	if len(entries) != 2 || len(scopes) != 1 {
		t.Fatalf("entries = %d, scopes = %v", len(entries), scopes)
	}
	view := harnessExperiencePage(HarnessExperienceResult{Entries: entries}, "open", 10)
	if view.Total != 1 || view.Entries[0].Cue != "one" {
		t.Fatalf("open view = %+v", view)
	}
}

func TestExperienceReadWithDomainFiltersThatScope(t *testing.T) {
	reader := experienceReaderWith(t, "graph-self-improvement", HarnessExperienceEntry{Status: "open", Cue: "one"})
	entries := harnessExperienceEntries(reader, "task-1", "graph-self-improvement")
	if len(entries) != 1 || entries[0].Cue != "one" {
		t.Fatalf("entries = %+v", entries)
	}
	if foreign := harnessExperienceEntries(reader, "task-1", "nobody-home"); len(foreign) != 0 {
		t.Fatalf("an unrelated scope returned %+v", foreign)
	}
}
