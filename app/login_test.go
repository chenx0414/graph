package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func loginServer(t *testing.T, state *string, posts map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/providers/login":
			payload := make([]byte, 2048)
			read, _ := r.Body.Read(payload)
			posts[r.URL.Path] = string(payload[:read])
			*state = "waiting"
			w.Write([]byte(`{"id":"l1","providerId":"grok","state":"waiting","url":"https://accounts.x.ai/device","userCode":"ABCD-1234"}`))
		case r.Method == "POST" && r.URL.Path == "/api/providers/login/l1/cancel":
			*state = "cancelled"
			w.Write([]byte(`{"id":"l1","providerId":"grok","state":"cancelled"}`))
		case r.URL.Path == "/api/providers/login/l1":
			switch *state {
			case "cancelled":
				w.Write([]byte(`{"id":"l1","providerId":"grok","state":"cancelled"}`))
			case "complete":
				w.Write([]byte(`{"id":"l1","providerId":"grok","state":"complete"}`))
			default:
				w.Write([]byte(`{"id":"l1","providerId":"grok","state":"waiting","url":"https://accounts.x.ai/device","userCode":"ABCD-1234"}`))
			}
		default:
			body, ok := settingsFixtures[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Write([]byte(body))
		}
	}))
}

func TestProviderLoginAsksForTheCodeAndFinishes(t *testing.T) {
	state := "idle"
	posts := map[string]string{}
	server := loginServer(t, &state, posts)
	defer server.Close()

	settings := newSettingsState(server.URL, "tok")
	opened := ""
	settings.openURL = func(url string) error {
		opened = url
		return nil
	}
	settings.load()
	row := settings.rows.credentials[1]
	settings.startLogin(row)
	for _, wanted := range []string{`"providerId":"grok"`, `"credentialRef":"GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN"`} {
		if !contains(posts["/api/providers/login"], wanted) {
			t.Fatalf("开始登录的提交体缺 %q，实际 %q", wanted, posts["/api/providers/login"])
		}
	}
	if settings.login.UserCode != "ABCD-1234" {
		t.Fatalf("login %+v", settings.login)
	}
	tester := ui.NewTester(settings.view, 860, 700)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("在浏览器输入设备码 ABCD-1234（waiting）") {
		t.Fatalf("the device code must be visible, texts %q", tester.Texts())
	}
	if err := tester.Click("打开授权链接"); err != nil {
		t.Fatalf("click 打开授权链接: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for opened == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if opened != "https://accounts.x.ai/device" {
		t.Fatalf("the button must open the authorization URL, opened %q", opened)
	}
	state = "complete"
	next, err := settings.refreshLogin()
	if err != nil {
		t.Fatal(err)
	}
	if next.State != "complete" || !next.done() {
		t.Fatalf("next %+v", next)
	}
	settings.login = next
	if loginLabel(settings.login) != "已登录完成" {
		t.Fatalf("label %q", loginLabel(settings.login))
	}
}

func TestProviderLoginCanBeCancelled(t *testing.T) {
	state := "idle"
	posts := map[string]string{}
	server := loginServer(t, &state, posts)
	defer server.Close()

	settings := newSettingsState(server.URL, "tok")
	settings.load()
	settings.startLogin(settings.rows.credentials[1])
	tester := ui.NewTester(settings.view, 860, 700)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("取消登录") {
		t.Fatalf("a running login must be cancellable, texts %q", tester.Texts())
	}
	if err := tester.Click("取消登录"); err != nil {
		t.Fatalf("click 取消登录: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for settings.login.State != "cancelled" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if settings.login.State != "cancelled" || settings.status != "已取消登录" {
		t.Fatalf("cancel state %q status %q", settings.login.State, settings.status)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if tester.HasText("在浏览器输入设备码") {
		t.Fatalf("a cancelled login must stop asking for the code, texts %q", tester.Texts())
	}
}

func TestLoginLabelCoversTheTerminalStates(t *testing.T) {
	cases := map[string]string{
		"complete":  "已登录完成",
		"cancelled": "已取消登录",
		"expired":   "登录码已过期，重试一次",
	}
	for state, want := range cases {
		if got := loginLabel(providerLogin{State: state}); got != want {
			t.Fatalf("loginLabel(%q) = %q, want %q", state, got, want)
		}
	}
	if got := loginLabel(providerLogin{State: "failed", Message: "boom"}); got != "登录失败：boom" {
		t.Fatalf("loginLabel(failed) = %q", got)
	}
	if got := loginLabel(providerLogin{State: "starting"}); got != "等待授权（starting）" {
		t.Fatalf("loginLabel(starting) = %q", got)
	}
}
