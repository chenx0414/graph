package graph

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func toolSearchExecute(t *testing.T, args map[string]any) (map[string]any, error) {
	t.Helper()
	options := toolSearchOptions()
	deferred, index := toolDisclosurePlanOf(toolSearchFixture(), options)
	text, failure := toolSearchSpec(deferred, index, options).Execute(context.Background(), args)
	if failure != nil {
		return nil, failure
	}
	payload := map[string]any{}
	if error := json.Unmarshal([]byte(text), &payload); error != nil {
		t.Fatalf("search result is not JSON: %v", error)
	}
	return payload, nil
}

func TestToolSearchRefusesAnInvalidRegex(t *testing.T) {
	_, failure := toolSearchExecute(t, map[string]any{"regex": "["})
	if failure == nil {
		t.Fatal("a regex that does not compile has to be refused; an empty answer reads as no such tool")
	}
	if !strings.Contains(failure.Error(), "regex") {
		t.Fatalf("the refusal has to name the regex, got %v", failure)
	}
}

func TestToolSearchStillAnswersARegexThatMatchesNothing(t *testing.T) {
	payload, failure := toolSearchExecute(t, map[string]any{"regex": "no-such-tool-anywhere"})
	if failure != nil {
		t.Fatalf("a valid regex with no match is an empty answer, not a failure: %v", failure)
	}
	hits, _ := payload["hits"].([]any)
	if len(hits) != 0 {
		t.Fatalf("expected no hits, got %v", hits)
	}
}

func TestToolSearchExplainsAnEmptyAnswer(t *testing.T) {
	payload, failure := toolSearchExecute(t, map[string]any{"query": "停止 子代理 队列"})
	if failure != nil {
		t.Fatalf("search failed: %v", failure)
	}
	hits, _ := payload["hits"].([]any)
	if len(hits) != 0 {
		t.Fatalf("expected no hits, got %v", hits)
	}
	hint, _ := payload["hint"].(string)
	if !strings.Contains(hint, "English") {
		t.Fatalf("an empty answer has to say the tool text is English, got %q", hint)
	}
	if _, present := payload["total"]; !present {
		t.Fatal("an empty answer still has to report how many tools it searched")
	}
}

func TestToolSearchDescriptionStopsClaimingChinese(t *testing.T) {
	options := toolSearchOptions()
	deferred, index := toolDisclosurePlanOf(toolSearchFixture(), options)
	description := toolSearchSpec(deferred, index, options).Description
	if strings.Contains(description, "Chinese") {
		t.Fatalf("the description promises Chinese hits over an English inventory: %q", description)
	}
	for _, want := range []string{"keyword", "regex", "schema"} {
		if !strings.Contains(description, want) {
			t.Fatalf("the description has to name %q, got %q", want, description)
		}
	}
}
