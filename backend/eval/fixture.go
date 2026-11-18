package eval

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/chenx0414/graph/backend/internal/appinstall"
	"github.com/chenx0414/graph/backend/internal/harness"
)

type Fixture struct {
	provider  *scriptedProvider
	Root      string
	Project   string
	Config    string
	DaemonURL string
	Console   *harness.Console
	Env       map[string]string
	daemon    *harness.Daemon
}

type FixtureOptions struct {
	Repository string
	Mode       string
	Files      map[string]string
	Env        map[string]string
	Steps      []scriptStep
}

func StartFixture(t *T, options FixtureOptions) *Fixture {
	root, err := os.MkdirTemp("", "graph-eval-")
	if err != nil {
		t.Fatal("temp-dir", err)
	}
	fixture := &Fixture{Root: root, Project: filepath.Join(root, "project"), Env: map[string]string{"HOME": root}}
	for key, value := range options.Env {
		fixture.Env[key] = value
	}
	if err := os.MkdirAll(fixture.Project, 0o755); err != nil {
		t.Fatal("project-dir", err)
	}
	for name, content := range options.Files {
		path := filepath.Join(fixture.Project, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal("fixture-file", err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal("fixture-file", err)
		}
	}
	fixture.Config = filepath.Join(root, "graph.config.json")
	config := stubConfig(fixture.Project)
	if len(options.Steps) > 0 {
		provider, providerErr := startScriptedProvider(options.Steps)
		if providerErr != nil {
			t.Fatal("provider", providerErr)
		}
		fixture.provider = provider
		fixture.Env["GRAPH_EVAL_LOCAL_KEY"] = "eval-key"
		config = providerConfig(fixture.Project, provider.BaseURL)
	}
	if err := os.WriteFile(fixture.Config, []byte(config), 0o600); err != nil {
		t.Fatal("config", err)
	}
	mode := options.Mode
	if mode == "" {
		mode = "view-only"
	}
	if _, buildErr := appinstall.BuildBackend(options.Repository, true); buildErr != nil {
		t.Fatal("daemon-build", buildErr)
	}
	daemon, err := harness.StartDaemon(harness.DaemonOptions{
		Repository: options.Repository,
		Root:       root,
		ConfigPath: fixture.Config,
		Mode:       mode,
		Env:        fixture.Env,
	})
	if err != nil {
		t.Fatal("daemon", err)
	}
	fixture.daemon = daemon
	fixture.DaemonURL = daemon.URL
	console, err := harness.OpenConsole(daemon.URL)
	if err != nil {
		t.Fatal("console", err)
	}
	fixture.Console = console
	return fixture
}

func (fixture *Fixture) StateDir() string {
	return filepath.Join(fixture.Root, "state")
}

func (fixture *Fixture) Close() {
	if fixture == nil || fixture.daemon == nil {
		return
	}
	fixture.daemon.Close()
	if fixture.provider != nil {
		fixture.provider.Close()
	}
	if os.Getenv("GRAPH_EVAL_KEEP_ROOTS") != "1" {
		_ = os.RemoveAll(fixture.Root)
	}
}

func (fixture *Fixture) Output() string {
	if fixture == nil || fixture.daemon == nil {
		return ""
	}
	return fixture.daemon.Output()
}

func (fixture *Fixture) Post(t *T, name, path string, body map[string]any, out any) {
	response, err := fixture.Console.Request("POST", path, body)
	if err != nil {
		t.Fatal(name+":request", err)
	}
	if response.Status < 200 || response.Status >= 300 {
		t.Fatal(name+":status", fmt.Errorf("POST %s -> %d: %s", path, response.Status, truncate(response.Text, 400)))
	}
	decode(t, name, response.Body, out)
}

func (fixture *Fixture) Get(t *T, name, path string, out any) harness.Response {
	response, err := fixture.Console.Request("GET", path, nil)
	if err != nil {
		t.Fatal(name+":request", err)
	}
	if response.Status < 200 || response.Status >= 300 {
		t.Fatal(name+":status", fmt.Errorf("GET %s -> %d: %s", path, response.Status, truncate(response.Text, 400)))
	}
	if out != nil {
		decode(t, name, response.Body, out)
	}
	return response
}

func decode(t *T, name string, body any, out any) {
	if out == nil {
		return
	}
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(name+":encode", err)
	}
	if err := json.Unmarshal(payload, out); err != nil {
		t.Fatal(name+":decode", err)
	}
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "..."
}

const settleTimeout = 90 * time.Second

func stubConfig(project string) string {
	return fmt.Sprintf(`{"version":1,"projects":[{"id":"p","root":%q}]}`, project)
}

func awaitSettled(name string, timeout time.Duration, probe func() (settled bool, detail string)) (string, bool) {
	deadline := time.Now().Add(timeout)
	last := ""
	for {
		settled, detail := probe()
		if settled {
			return detail, true
		}
		last = detail
		if time.Now().After(deadline) {
			return last, false
		}
		time.Sleep(100 * time.Millisecond)
	}
}
