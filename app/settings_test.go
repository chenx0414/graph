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
		"grok":{"displayName":"grok 订阅","secretRef":"GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN","configured":true},
		"chatgpt":{"displayName":"chatgpt 订阅","secretRef":"GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN","configured":false}
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
	if snapshot.credentials[0].secretRef != "GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN" {
		t.Fatalf("the secret ref must survive parsing, got %q", snapshot.credentials[0].secretRef)
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
	for _, wanted := range []string{"运行 · execute · 配置版本 428", "源码 · main@79a38ef0 · 模型 7 个可用", "● grok 订阅", "○ chatgpt 订阅", "13-Graph · ready"} {
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
	tester := ui.NewTester(state.view, 1280, 800)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if err := tester.Click("设置"); err != nil {
		t.Fatalf("click 设置: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for state.settings == nil || state.settings.status != "" {
		if !time.Now().Before(deadline) {
			t.Fatalf("settings did not load")
		}
		time.Sleep(time.Millisecond)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if state.board.lastKind != "settings" || !tester.HasText("订阅凭据") {
		t.Fatalf("the settings panel must render, last %q texts %q", state.board.lastKind, tester.Texts())
	}
	if err := tester.Click("概览"); err != nil {
		t.Fatalf("click 概览: %v", err)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if state.board.lastKind != "overview" || tester.HasText("订阅凭据") {
		t.Fatalf("the overview must come back, last %q texts %q", state.board.lastKind, tester.Texts())
	}
}

func TestSettingsWritesACredential(t *testing.T) {
	posted := ""
	actions := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/api/app/secret" {
			payload := make([]byte, 4096)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			actions["secret"]++
			w.Write([]byte(`{"persisted":true}`))
			return
		}
		body, ok := settingsFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
	defer server.Close()

	state := newSettingsState(server.URL, "tok")
	state.load()
	tester := ui.NewTester(state.view, 860, 640)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("填写 chatgpt") || !tester.HasText("更换 grok") {
		t.Fatalf("每一行凭据都要能被填写或更换，texts %q", tester.Texts())
	}
	if tester.HasText("保存凭据") {
		t.Fatalf("输入框必须点开才出现，texts %q", tester.Texts())
	}
	if err := tester.Click("填写 chatgpt"); err != nil {
		t.Fatalf("click 填写 chatgpt: %v", err)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("保存凭据") || !tester.HasText("取消填写") {
		t.Fatalf("点开后必须有输入与保存，texts %q", tester.Texts())
	}
	state.secretDraft = "sk-live-token"
	state.saveSecret(state.rows.credentials[0])
	if actions["secret"] != 1 {
		t.Fatalf("保存必须打到 /api/app/secret，actions %v", actions)
	}
	for _, wanted := range []string{"GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN", "sk-live-token", `"persisted":true`} {
		if !contains(posted, wanted) {
			t.Fatalf("提交体里缺 %q，实际 %q", wanted, posted)
		}
	}
	if state.editing != "" || state.secretDraft != "" {
		t.Fatalf("保存成功后必须清掉草稿，editing %q draft %q", state.editing, state.secretDraft)
	}
	if state.status != "已保存 chatgpt 订阅" {
		t.Fatalf("status %q", state.status)
	}
}

func TestSettingsRefusesAnEmptySecret(t *testing.T) {
	actions := map[string]int{}
	server := settingsServer(t, actions)
	defer server.Close()

	state := newSettingsState(server.URL, "tok")
	state.load()
	state.secretDraft = "   "
	state.saveSecret(state.rows.credentials[1])
	if actions["/api/app/secret"] != 0 {
		t.Fatalf("an empty value must not be sent, actions %v", actions)
	}
	if state.status == "" {
		t.Fatal("an empty value must be reported, not silently ignored")
	}
}
