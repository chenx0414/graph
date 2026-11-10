package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

var settingsFixtures = map[string]string{
	"/api/startup": `{"mode":"execute","modelCount":7,"effectiveRevision":42,"source":{"branch":"main","commit":"79a38ef04d600046c55d1a81e57dc7ee04de629b"}}`,
	"/api/settings": `{"defaultModel":"command-goat:deepseek","projects":[
		{"id":"13-Graph","archivedAt":null,"preparation":{"state":"ready"}},
		{"id":"00-项目模板","archivedAt":1793178492561,"preparation":null}
	]}`,
	"/api/config": `{"revision":428,"config":{"credentials":{
		"grok":{"displayName":"grok 订阅","configured":true},
		"chatgpt":{"displayName":"chatgpt 订阅","configured":false}
	}}}`,
}

func settingsServer(t *testing.T, actions map[string]int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			actions[r.URL.Path]++
			w.Write([]byte(`{}`))
			return
		}
		body, ok := settingsFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
}

func TestSettingsSnapshotReadsRunStateCredentialsAndProjects(t *testing.T) {
	snapshot, err := parseSettings([]byte(settingsFixtures["/api/startup"]), []byte(settingsFixtures["/api/settings"]), []byte(settingsFixtures["/api/config"]))
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.mode != "execute" || snapshot.revision != 428 || snapshot.modelCount != 7 {
		t.Fatalf("snapshot %+v", snapshot)
	}
	if snapshot.branch != "main" || shortCommit(snapshot.commit) != "79a38ef0" || snapshot.defaultModel != "command-goat:deepseek" {
		t.Fatalf("snapshot %+v", snapshot)
	}
	if len(snapshot.credentials) != 2 || snapshot.credentials[0].id != "chatgpt" || snapshot.credentials[1].name != "grok 订阅" {
		t.Fatalf("credentials %+v", snapshot.credentials)
	}
	if credentialLabel(snapshot.credentials[0]) != "○ chatgpt 订阅" || credentialLabel(snapshot.credentials[1]) != "● grok 订阅" {
		t.Fatalf("labels %q %q", credentialLabel(snapshot.credentials[0]), credentialLabel(snapshot.credentials[1]))
	}
	if len(snapshot.projects) != 2 || snapshot.projects[0].state != "ready" || snapshot.projects[1].state != "未准备" || !snapshot.projects[1].archived {
		t.Fatalf("projects %+v", snapshot.projects)
	}
	if projectLabel(snapshot.projects[1]) != "00-项目模板 · 未准备 · 已归档" {
		t.Fatalf("project label %q", projectLabel(snapshot.projects[1]))
	}
}

func TestSettingsPaneRendersAndArchivesAProject(t *testing.T) {
	actions := map[string]int{}
	server := settingsServer(t, actions)
	defer server.Close()

	state := newSettingsState(server.URL, "tok")
	state.load()
	if state.status != "" {
		t.Fatalf("status %q", state.status)
	}
	tester := ui.NewTester(state.view, 820, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	for _, wanted := range []string{"设置", "运行 · execute · 配置版本 428", "源码 · main@79a38ef0 · 模型 7 个可用", "● grok 订阅", "○ chatgpt 订阅", "13-Graph · ready"} {
		if !tester.HasText(wanted) {
			t.Fatalf("missing %q in texts %q", wanted, tester.Texts())
		}
	}
	state.toggleProject(state.rows.projects[0])
	if actions["/api/projects/13-Graph/archive"] != 1 {
		t.Fatalf("archiving must hit the archive route, actions %v", actions)
	}
	state.toggleProject(state.rows.projects[1])
	if actions["/api/projects/00-项目模板/restore"] != 1 {
		t.Fatalf("an archived project must be restored, actions %v", actions)
	}
}

func TestShellSwitchesBetweenChatsAndSettings(t *testing.T) {
	actions := map[string]int{}
	server := settingsServer(t, actions)
	defer server.Close()

	state := newShellState(server.URL, "tok")
	tester := ui.NewTester(state.view, 1000, 640)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if err := tester.Click("设置"); err != nil {
		t.Fatalf("click 设置: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.settings == nil || state.settings.status != "" {
		if !time.Now().Before(deadline) {
			t.Fatalf("settings did not load, status %q", state.section)
		}
		time.Sleep(time.Millisecond)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if state.section != "settings" || !tester.HasText("订阅凭据") {
		t.Fatalf("the settings pane must render, section %q texts %q", state.section, tester.Texts())
	}
	if err := tester.Click("会话"); err != nil {
		t.Fatalf("click 会话: %v", err)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if state.section != "chat" || tester.HasText("订阅凭据") {
		t.Fatalf("the chat pane must come back, section %q texts %q", state.section, tester.Texts())
	}
}
