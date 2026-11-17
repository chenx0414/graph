package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeThreadAPI mimics the three calls seedConversation makes. The transcript
// answers with the user message first so the test proves the code polls product
// state instead of assuming the turn landed immediately.
func fakeThreadAPI(t *testing.T, assistant string) (*httptest.Server, *int32) {
	t.Helper()
	reads := int32(0)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/projects/verify/thread", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("thread must be opened with POST, got %s", r.Method)
		}
		w.Write([]byte(`{"conversationId":"c1","taskId":"t1","role":"project","projectId":"verify"}`))
	})
	mux.HandleFunc("/api/conversations/c1/messages", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("a message must be sent with POST, got %s", r.Method)
		}
		w.Write([]byte(`{"conversationId":"c1","messageId":"m1","state":"pending"}`))
	})
	mux.HandleFunc("/api/conversations/c1", func(w http.ResponseWriter, r *http.Request) {
		count := atomic.AddInt32(&reads, 1)
		if count == 1 {
			w.Write([]byte(`{"messages":[{"role":"user","text":"hello","state":"delivered"}]}`))
			return
		}
		w.Write([]byte(`{"messages":[{"role":"user","text":"hello","state":"delivered"},{"role":"assistant","text":"` + assistant + `","state":"done"}]}`))
	})
	mux.HandleFunc("/api/conversations/c1/trajectory", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"turns":[{"id":"m1"}],"totals":{"input":40,"output":10}}`))
	})
	return httptest.NewServer(mux), &reads
}

func seededRunMeta(t *testing.T, url string) runMeta {
	t.Helper()
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "session-token"), []byte("token-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return runMeta{RunID: "run-1", StateDir: stateDir, Daemon: daemonMeta{URL: url}}
}

func TestSeededConversationPollsTheTranscriptAndReadsTokens(t *testing.T) {
	server, reads := fakeThreadAPI(t, "已就绪。")
	defer server.Close()
	outcome, err := seedConversation(seededRunMeta(t, server.URL), seedPrompt{
		Prompt: "hello", Expect: "已就绪。", RequestID: "t", ProjectID: "verify",
	})
	if err != nil {
		t.Fatalf("seedConversation: %v", err)
	}
	if outcome.ConversationID != "c1" || outcome.Messages != 2 || outcome.Turns != 1 {
		t.Fatalf("outcome = %+v", outcome)
	}
	if outcome.InputTokens != 40 || outcome.OutputTokens != 10 {
		t.Fatalf("token totals must come from /trajectory, got %+v", outcome)
	}
	if outcome.AssistantText != "已就绪。" {
		t.Fatalf("assistant text = %q", outcome.AssistantText)
	}
	if atomic.LoadInt32(reads) < 2 {
		t.Fatal("the transcript must be polled until the assistant message exists, not read once")
	}
	record := seedAssertion(outcome, seedPrompt{Prompt: "hello"}, "/tmp/seed.json")
	if !record.OK || !strings.Contains(record.Actual, "tokens=40/10") {
		t.Fatalf("seed assertion = %+v", record)
	}
}

func TestSeededConversationRefusesADifferentAnswerThanTheJourneyExpects(t *testing.T) {
	server, _ := fakeThreadAPI(t, "别的回答")
	defer server.Close()
	if _, err := seedConversation(seededRunMeta(t, server.URL), seedPrompt{
		Prompt: "hello", Expect: "已就绪。", RequestID: "t", ProjectID: "verify",
	}); err == nil || !strings.Contains(err.Error(), "the journey expects") {
		t.Fatalf("a drifted transcript must fail the seed, got %v", err)
	}
}

func TestAConversationWithoutATokenTotalIsNotProof(t *testing.T) {
	record := seedAssertion(seedOutcome{ConversationID: "c1", AssistantText: "已就绪。", Messages: 2}, seedPrompt{Prompt: "hello"}, "/tmp/seed.json")
	if record.OK {
		t.Fatalf("a turn with no output tokens cannot be proof of a real model round trip: %+v", record)
	}
}

func TestJourneysDeclareTheInstanceTheyNeed(t *testing.T) {
	if got := (journey{Instance: "execute"}).mode(); got != "execute" {
		t.Fatalf("explicit execute instance = %q", got)
	}
	if got := (journey{Seed: &seedPrompt{Prompt: "hi"}}).mode(); got != "execute" {
		t.Fatalf("a seeding journey needs the execute instance, got %q", got)
	}
	if got := (journey{}).mode(); got != "view" {
		t.Fatalf("a plain journey must stay on the view instance, got %q", got)
	}
}
