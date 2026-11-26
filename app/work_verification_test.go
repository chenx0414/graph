package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDesktopConfirmsTheVerificationDraftItShows(t *testing.T) {
	requests := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/conversations/c1":
			_, _ = w.Write([]byte(`{"messages":[{"id":"draft","role":"system","kind":"verification_draft","text":"保留等号",
				"data":{"verificationDraft":{"workId":"w1","workRevision":2,"version":4,"draftRevision":3,"targetBranch":"main","checks":["解析 X=a=b 时保留 a=b"]}}}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/orchestration/work/w1/confirm":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			requests <- body
			_, _ = w.Write([]byte(`{"state":"ready","graphId":"g1"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	chat := newChatState(server.URL, "tok")
	chat.open("c1")
	tester := newTester(chat.view, 720, 650)
	render(tester)
	for _, label := range []string{"保留等号", "解析 X=a=b 时保留 a=b", "确认草稿 · main"} {
		if !tester.HasText(label) {
			t.Fatalf("draft must show %q, got %v", label, tester.Texts())
		}
	}
	if err := tester.Click("确认草稿 · main"); err != nil {
		t.Fatal(err)
	}
	providersFrameUntil(t, tester, func() bool { return len(requests) > 0 })
	select {
	case body := <-requests:
		if body["workRevision"] != float64(2) || body["version"] != float64(4) ||
			body["draftRevision"] != float64(3) || body["targetBranch"] != "main" {
			t.Fatalf("approval must identify the draft shown on screen: %v", body)
		}
	default:
		t.Fatal("clicking the draft did not send an approval")
	}
}
