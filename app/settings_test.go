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

func TestSettingsSnapshotReadsRunStateAndProjects(t *testing.T) {
	snapshot, err := parseSettings([]byte(settingsFixtures["/api/startup"]), []byte(settingsFixtures["/api/settings"]))
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.mode != "execute" || snapshot.revision != 42 || snapshot.modelCount != 7 {
		t.Fatalf("snapshot %+v", snapshot)
	}
	if snapshot.branch != "main" || shortCommit(snapshot.commit) != "79a38ef0" || snapshot.defaultModel != "command-goat:deepseek" {
		t.Fatalf("snapshot %+v", snapshot)
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
	for _, wanted := range []string{"运行设置", "运行状态、源码版本与项目归档", "管理供应商", "运行",
		"运行模式", "execute", "配置版本", "42", "源码", "main@79a38ef0", "可用模型", "7 个", "默认模型", "deepseek",
		"项目", "13-Graph", "ready", "归档的项目不再出现在会话列表里",
		"凭据在「供应商」页管理 · 与 magpie 同一套"} {
		if !tester.HasText(wanted) {
			t.Fatalf("missing %q in texts %q", wanted, tester.Texts())
		}
	}
	for _, gone := range []string{"订阅凭据", "填写 chatgpt", "更换 grok", "登录 grok", "保存凭据"} {
		if tester.HasText(gone) {
			t.Fatalf("the credentials section is gone, but %q is still on the page: %q", gone, tester.Texts())
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
	if state.activeBoardKind() != "settings" || !tester.HasText("凭据在「供应商」页管理 · 与 magpie 同一套") {
		t.Fatalf("the settings panel must render, kind %q texts %q", state.activeBoardKind(), tester.Texts())
	}
	if err := tester.Click("轨迹"); err != nil {
		t.Fatalf("click 轨迹: %v", err)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if state.activeBoardKind() != "trajectory" || tester.HasText("凭据在「供应商」页管理 · 与 magpie 同一套") {
		t.Fatalf("the trajectory tab must come back, kind %q texts %q", state.activeBoardKind(), tester.Texts())
	}
}

func TestTheSettingsPageFollowsTheGodwitLayout(t *testing.T) {
	actions := map[string]int{}
	server := settingsServer(t, actions)
	defer server.Close()

	state := newSettingsState(server.URL, "tok")
	state.load()
	tester := ui.NewTester(state.view, 1200, 800)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	rect, ok := tester.Find("运行设置")
	if !ok {
		t.Fatalf("the page has its heading, texts %q", tester.Texts())
	}
	want := (1200 - 760) / 2
	if diff := rect.X - float32(want); diff > 8 || diff < -8 {
		t.Fatalf("the settings column is 760 wide and centred, heading x %v want %v", rect.X, want)
	}
	if _, ok := tester.Find("归档 13-Graph"); !ok {
		t.Fatalf("a project row keeps its action button, texts %q", tester.Texts())
	}
}
