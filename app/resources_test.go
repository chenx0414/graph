package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

var resourceFixtures = map[string]string{
	"/api/catalog": `{"capabilities":[
		{"id":"article-writing","kind":"skill","version":"local","name":"article-writing","status":"available","origin":"project","source":"/workspace/00-项目模板/.agents/skills/article-writing","snapshot":{"path":"/workspace/00-项目模板/.agents/skills/article-writing"}},
		{"id":"pstack","kind":"skill","version":"local","name":"pstack","status":"available","origin":"agent","source":"/Users/macmini/.graph/agents/main/skills/pstack","snapshot":{"path":"/Users/macmini/.graph/agents/main/skills/pstack"}},
		{"id":"affaan-m-ecc-a11y-architect","kind":"prompt","version":"8321021c54d6","name":"a11y-architect","status":"available","source":"/Users/macmini/.graph/capabilities/agent-md/a11y","snapshot":{"manifest":{"name":"a11y-architect","description":"Accessibility Architect specializing in WCAG 2.2 compliance.","source":"https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/agents/architect.md"}}},
		{"id":"browser-use","kind":"mcp","version":"2026.9.17","name":"Browser Use","status":"available","source":"/Users/macmini/.graph/capabilities/mcp/browser-use","snapshot":{"manifest":{"description":"Browser automation server."}}},
		{"id":"web-search","kind":"skill","version":"1.4.0","name":"web-search","status":"available","source":"/Users/macmini/.graph/capabilities/skills/web-search","snapshot":{"manifest":{"description":"Search the web.","source":"https://github.com/example/skills/tree/main/web-search"}}}
	]}`,
	"/api/capabilities/config": `{"items":[{"id":"browser-use","version":"2026.9.17","kind":"mcp","missing":["BROWSER_USE_API_KEY"],"ready":false}]}`,
	"/api/settings":            `{"capabilityRoot":"/Users/macmini/.graph/capabilities"}`,
}

func resourceServer(t *testing.T, actions map[string]int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/api/catalog/refresh" {
			if actions != nil {
				actions["refresh"]++
			}
			w.Write([]byte(`{}`))
			return
		}
		body, ok := resourceFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
}

func TestTheResourceLibraryKnowsWhereEachResourceComesFrom(t *testing.T) {
	rows, err := parseResourceLibrary([]byte(resourceFixtures["/api/catalog"]), []byte(resourceFixtures["/api/capabilities/config"]))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 5 {
		t.Fatalf("the library has every capability, got %d", len(rows))
	}
	byID := map[string]resourceRow{}
	for _, row := range rows {
		byID[row.id] = row
	}
	if byID["article-writing"].origin != "project" || byID["pstack"].origin != "agent" {
		t.Fatalf("origins survive parsing, got %+v", byID)
	}
	if byID["affaan-m-ecc-a11y-architect"].repo != "affaan-m/ECC" {
		t.Fatalf("a github source becomes owner/repo, got %q", byID["affaan-m-ecc-a11y-architect"].repo)
	}
	if byID["affaan-m-ecc-a11y-architect"].description == "" || len(byID["browser-use"].missing) != 1 || byID["browser-use"].missing[0] != "BROWSER_USE_API_KEY" {
		t.Fatalf("description and missing survive parsing, got %+v", byID)
	}
	if got := resourceSummary(rows); got != "4 / 5 可用 · 1 个待配置" {
		t.Fatalf("summary %q", got)
	}
}

func TestTheResourcePageLooksLikeTheMagpieLibrary(t *testing.T) {
	server := resourceServer(t, nil)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	if state.status != "" {
		t.Fatalf("status %q", state.status)
	}
	tester := ui.NewTester(state.view, 1200, 820)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	for _, wanted := range []string{"使用", "资源库", "AGENT 中已有", "不在资源库中", "发现", "文章写作", "article-writing",
		"pstack", "a11y-architect", "affaan-m/ECC", "Accessibility Architect specializing in WCAG 2.2 compliance.",
		"Browser Use", "web-search", "example/skills"} {
		if !tester.HasText(wanted) && wanted != "文章写作" {
			t.Fatalf("missing %q in texts %q", wanted, tester.Texts())
		}
	}
}

func TestSearchFiltersBothSections(t *testing.T) {
	server := resourceServer(t, nil)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.load()
	state.search = "web-search"
	tester := ui.NewTester(state.view, 1200, 820)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("web-search") {
		t.Fatalf("the match stays, texts %q", tester.Texts())
	}
	for _, gone := range []string{"a11y-architect", "article-writing"} {
		if tester.HasText(gone) {
			t.Fatalf("%q is filtered out, texts %q", gone, tester.Texts())
		}
	}
}

func TestOpeningAResourceAndRefreshingTheCatalog(t *testing.T) {
	actions := map[string]int{}
	server := resourceServer(t, actions)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	opened := []string{}
	state.openPath = func(path string) error {
		opened = append(opened, path)
		return nil
	}
	state.load()
	state.refresh()
	if actions["refresh"] != 1 {
		t.Fatalf("refresh must hit /api/catalog/refresh, actions %v", actions)
	}
	tester := ui.NewTester(state.view, 1200, 820)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if err := tester.Click("打开资源库文件夹"); err != nil {
		t.Fatalf("click the folder action: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(opened) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(opened) != 1 || opened[0] != "/Users/macmini/.graph/capabilities" {
		t.Fatalf("the folder action opens the library root, opened %v", opened)
	}
}

func TestTheAgentSectionShowsFiveThenExpands(t *testing.T) {
	server := resourceServer(t, nil)
	defer server.Close()

	state := newResourceState(server.URL, "tok")
	state.status = ""
	for index := 0; index < 8; index++ {
		state.rows = append(state.rows, resourceRow{
			id: "found-" + itoa(index), kind: "skill", name: "found-" + itoa(index), origin: "project",
			source: "/tmp/found-" + itoa(index), ready: true, status: "available",
		})
	}
	tester := ui.NewTester(state.view, 900, 700)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("显示全部 8 个") {
		t.Fatalf("a long agent list folds behind its count, texts %q", tester.Texts())
	}
	if tester.HasText("found-7") {
		t.Fatalf("the seventh row waits for the expansion, texts %q", tester.Texts())
	}
	if err := tester.Click("展开 AGENT 中已有的全部资源"); err != nil {
		t.Fatalf("expand the agent list: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("found-7") || !tester.HasText("收起") {
		t.Fatalf("the expansion reveals the rest, texts %q", tester.Texts())
	}
}

func itoa(v int) string {
	return strconv.Itoa(v)
}
