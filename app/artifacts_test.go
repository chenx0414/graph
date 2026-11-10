package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestArtifactsListAndPreview(t *testing.T) {
	listed := `{"artifacts":[
		{"artifactId":"a1","taskId":"t1","namespace":"plans","name":"shape","version":46,"size":36804,"mediaType":"application/json"},
		{"artifactId":"a2","taskId":"t1","namespace":"reviews","name":"pass","version":2,"size":900,"mediaType":"text/markdown"}
	]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"做完了"}]}`))
		case "/api/conversations/c1/artifacts":
			w.Write([]byte(listed))
		case "/api/tasks/t1/artifacts/a1/46/content":
			w.Write([]byte(`{"shape":"parallel"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if len(state.artifacts) != 2 {
		t.Fatalf("artifacts %+v", state.artifacts)
	}
	if artifactLabel(state.artifacts[0]) != "plans/shape · v46 · 35.9 KB" {
		t.Fatalf("label %q", artifactLabel(state.artifacts[0]))
	}
	tester := ui.NewTester(state.view, 760, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("产物 · 2 件") {
		t.Fatalf("the artifacts toggle must show the count, texts %q", tester.Texts())
	}
	if tester.HasText("plans/shape · v46 · 35.9 KB") {
		t.Fatalf("the list must stay collapsed until asked, texts %q", tester.Texts())
	}
	if err := tester.Click("产物 · 2 件"); err != nil {
		t.Fatalf("click the artifacts toggle: %v", err)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("plans/shape · v46 · 35.9 KB") || !tester.HasText("reviews/pass · v2 · 900 B") {
		t.Fatalf("the expanded list must show both artifacts, texts %q", tester.Texts())
	}
	if err := tester.Click("plans/shape · v46 · 35.9 KB"); err != nil {
		t.Fatalf("click an artifact: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.preview == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("产物预览 · plans/shape · v46 · 35.9 KB") || !tester.HasText(`{"shape":"parallel"}`) {
		t.Fatalf("the preview must show the content, texts %q", tester.Texts())
	}
}

func TestArtifactListStopsAtTheLimit(t *testing.T) {
	listed := `{"artifacts":[`
	for index := 0; index < 12; index++ {
		if index > 0 {
			listed += ","
		}
		listed += `{"artifactId":"a` + strconv.Itoa(index) + `","taskId":"t1","namespace":"plans","name":"p` + strconv.Itoa(index) + `","version":1,"size":100}`
	}
	listed += `]}`
	rows, err := parseArtifacts([]byte(listed))
	if err != nil {
		t.Fatal(err)
	}
	state := newChatState("http://127.0.0.1:1", "tok")
	state.status = ""
	state.artifacts = rows
	state.artifactsOpen = true
	tester := ui.NewTester(state.view, 760, 900)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("还有 4 件未列出") {
		t.Fatalf("the list must stop at %d and count the rest, texts %q", artifactListLimit, tester.Texts())
	}
	if tester.HasText("plans/p11 · v1 · 100 B") {
		t.Fatalf("the ninth artifact must stay out of the list, texts %q", tester.Texts())
	}
}

func TestArtifactFileNameFollowsTheMediaType(t *testing.T) {
	cases := []struct {
		row  artifactRow
		name string
	}{
		{artifactRow{namespace: "plans", name: "shape", version: 46, mediaType: "application/json"}, "plans-shape-v46.json"},
		{artifactRow{namespace: "reviews", name: "pass", version: 2, mediaType: "text/markdown"}, "reviews-pass-v2.md"},
		{artifactRow{namespace: "shots", name: "a/b", version: 1, mediaType: "image/png"}, "shots-a-b-v1.png"},
		{artifactRow{namespace: "blobs", version: 3, mediaType: "application/octet-stream"}, "blobs-v3.bin"},
		{artifactRow{namespace: "pages", name: "index", version: 7, mediaType: "text/html; charset=utf-8"}, "pages-index-v7.html"},
	}
	for _, want := range cases {
		if got := artifactFileName(want.row); got != want.name {
			t.Fatalf("artifactFileName(%+v) = %q, want %q", want.row, got, want.name)
		}
	}
}

func TestExportWritesTheWholeArtifactNotThePreview(t *testing.T) {
	full := strings.Repeat("x", artifactPreviewLimit+600)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"做完了"}]}`))
		case "/api/conversations/c1/artifacts":
			w.Write([]byte(`{"artifacts":[{"artifactId":"a1","taskId":"t1","namespace":"plans","name":"shape","version":46,"size":4600,"mediaType":"application/json"}]}`))
		case "/api/tasks/t1/artifacts/a1/46/content":
			w.Write([]byte(full))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	state.showArtifact(state.artifacts[0])
	if len(state.preview) != artifactPreviewLimit+len("…") {
		t.Fatalf("the preview must stay truncated, got %d runes", len(state.preview))
	}
	target := filepath.Join(t.TempDir(), "export", "plans-shape-v46.json")
	state.exportArtifactTo(state.artifacts[0], target)
	written, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != len(full) {
		t.Fatalf("the export must carry the whole artifact, wrote %d of %d bytes", len(written), len(full))
	}
	if state.status != "已导出到 "+target {
		t.Fatalf("status %q", state.status)
	}
	tester := ui.NewTester(state.view, 820, 640)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("导出 plans-shape-v46.json") {
		t.Fatalf("the preview must offer the export button, texts %q", tester.Texts())
	}
}

func TestExportReportsAWriteFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"artifact":true}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.exportArtifactTo(artifactRow{artifactID: "a1", taskID: "t1", namespace: "plans", version: 1}, "/")
	if !strings.HasPrefix(state.status, "导出失败：") {
		t.Fatalf("a failed write must be reported, status %q", state.status)
	}
}
