package seed

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

var addressLine = regexp.MustCompile(`address:\s+(http://127\.0\.0\.1:\d+)`)

type httpConsole struct {
	base   string
	cookie string
	client *http.Client
}

func openConsole(t *testing.T, url string) *httpConsole {
	t.Helper()
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Get(url + "/")
	if err != nil {
		t.Fatalf("the console is unreachable at %s: %v", url, err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	console := &httpConsole{base: url, client: client}
	for _, cookie := range response.Cookies() {
		console.cookie = cookie.Name + "=" + cookie.Value
	}
	if console.cookie == "" {
		t.Fatal("the console handed out no session cookie")
	}
	return console
}

func (c *httpConsole) request(method, path string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = strings.NewReader(string(payload))
	}
	request, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("cookie", c.cookie)
	request.Header.Set("origin", c.base)
	request.Header.Set("content-type", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return payload, fmt.Errorf("%s %s -> %d: %s", method, path, response.StatusCode, truncate(string(payload), 300))
	}
	return payload, nil
}

func (c *httpConsole) Post(path string, body, out any) error {
	payload, err := c.request("POST", path, body)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(payload, out)
}

func (c *httpConsole) JSON(path string, out any) error {
	payload, err := c.request("GET", path, nil)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(payload, out)
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "..."
}

type runningDaemon struct {
	url    string
	cmd    *exec.Cmd
	output *strings.Builder
}

func startDaemon(t *testing.T, binary, repository, root, configPath string, env map[string]string) *runningDaemon {
	t.Helper()
	command := exec.Command(binary,
		"--application-root", repository,
		"--state-dir", filepath.Join(root, "state"),
		"--graph-home", filepath.Join(root, "graph-home"),
		"--config", configPath,
		"--port", "0",
		"--execute",
	)
	command.Dir = root
	environment := append(os.Environ(), "HOME="+root)
	for key, value := range env {
		environment = append(environment, key+"="+value)
	}
	command.Env = environment
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("daemon stdout: %v", err)
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		t.Fatalf("daemon stderr: %v", err)
	}
	if err := command.Start(); err != nil {
		t.Fatalf("the daemon did not start: %v", err)
	}
	daemon := &runningDaemon{cmd: command, output: &strings.Builder{}}
	addresses := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			daemon.output.WriteString(line + "\n")
			if match := addressLine.FindStringSubmatch(line); match != nil {
				select {
				case addresses <- match[1]:
				default:
				}
			}
		}
	}()
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			daemon.output.WriteString(scanner.Text() + "\n")
		}
	}()
	select {
	case url := <-addresses:
		daemon.url = url
		return daemon
	case <-time.After(45 * time.Second):
		_ = command.Process.Kill()
		t.Fatalf("the daemon reported no address\n%s", daemon.output.String())
	}
	return nil
}

func (d *runningDaemon) Close() {
	if d == nil || d.cmd == nil || d.cmd.Process == nil {
		return
	}
	_ = d.cmd.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() { _ = d.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = d.cmd.Process.Kill()
		<-done
	}
}

func TestSeedingBuildsRealDataInAnIsolatedDaemon(t *testing.T) {
	binary := os.Getenv("GRAPH_VERIFY_DAEMON")
	repository := os.Getenv("GRAPH_VERIFY_REPO")
	if binary == "" || repository == "" {
		t.Skip("set GRAPH_VERIFY_DAEMON and GRAPH_VERIFY_REPO to seed a real daemon")
	}
	root := t.TempDir()
	project := filepath.Join(root, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatalf("project: %v", err)
	}
	if err := os.WriteFile(filepath.Join(project, "README.md"), []byte("# seeded project\n"), 0o644); err != nil {
		t.Fatalf("project file: %v", err)
	}

	provider, err := StartProvider(Script{Final: "已就绪：这是一个由替身模型产生的回答。"})
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	defer provider.Close()

	configPath := filepath.Join(root, "graph.config.json")
	config := DefaultConfig("verify", project, provider.BaseURL)
	if err := WriteConfig(configPath, config); err != nil {
		t.Fatalf("config: %v", err)
	}
	daemon := startDaemon(t, binary, repository, root, configPath, config.Env())
	defer daemon.Close()

	console := openConsole(t, daemon.url)
	result, err := Seed(console, Options{
		ProjectID: "verify",
		Model:     config.ModelID,
		Prompt:    "只回复一个词：就绪。",
		RequestID: "seed-integration",
		Timeout:   120 * time.Second,
		Poll:      250 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("seed: %v\n%s", err, daemon.output.String())
	}
	if !result.Completed || !result.Succeeded {
		t.Fatalf("the seeded run must settle as succeeded, got %+v\n%s", result, daemon.output.String())
	}
	if result.ConversationID == "" || result.TaskID == "" {
		t.Fatalf("the seed must report the conversation and task it created, got %+v", result)
	}

	var conversation struct {
		Messages []struct {
			Role string `json:"role"`
			Text string `json:"text"`
		} `json:"messages"`
	}
	if err := console.JSON("/api/conversations/"+result.ConversationID, &conversation); err != nil {
		t.Fatalf("read the seeded conversation: %v", err)
	}
	if len(conversation.Messages) == 0 {
		t.Fatalf("the seeded conversation must hold the messages the model produced, got %+v", conversation)
	}
	if provider.Requests() == 0 {
		t.Fatal("the daemon must have called the stub provider")
	}

	var task map[string]any
	if err := console.JSON("/api/tasks/"+result.TaskID, &task); err != nil {
		t.Fatalf("read the seeded task: %v", err)
	}
	if len(task) == 0 {
		t.Fatal("a seeded run must leave a task behind")
	}
	var trajectory struct {
		Requests []map[string]any `json:"requests"`
		Agents   []map[string]any `json:"agents"`
		Totals   struct {
			Input  int64 `json:"input"`
			Output int64 `json:"output"`
			Total  int64 `json:"total"`
		} `json:"totals"`
	}
	if err := console.JSON("/api/conversations/"+result.ConversationID+"/trajectory", &trajectory); err != nil {
		t.Fatalf("read the seeded trajectory: %v", err)
	}
	if len(trajectory.Requests) == 0 {
		t.Fatal("a seeded conversation must record the model request it made")
	}
	if trajectory.Totals.Input == 0 || trajectory.Totals.Output == 0 {
		t.Fatalf("the recorded request must carry token usage, got %+v", trajectory.Totals)
	}
	if len(trajectory.Agents) == 0 {
		t.Fatal("the recorded trajectory must name the agent that answered")
	}

	var conversations []map[string]any
	if err := console.JSON("/api/conversations", &conversations); err != nil {
		t.Fatalf("list conversations: %v", err)
	}
	listed := false
	for _, item := range conversations {
		if item["id"] == result.ConversationID {
			listed = true
			break
		}
	}
	if !listed {
		t.Fatalf("the seeded conversation must appear in the list the sidebar reads, got %+v", conversations)
	}

	var fleet struct {
		Stats struct {
			Agents int `json:"agents"`
		} `json:"stats"`
	}
	if err := console.JSON("/api/fleet", &fleet); err != nil {
		t.Fatalf("read the fleet page data: %v", err)
	}
	if fleet.Stats.Agents != 0 {
		t.Fatalf("a seeded conversation must not invent fleet agents, got %+v", fleet.Stats)
	}

	if directory := os.Getenv("GRAPH_VERIFY_EVIDENCE"); directory != "" {
		writeSeedEvidence(t, directory, result, conversation.Messages, len(trajectory.Requests), trajectory.Totals.Input+trajectory.Totals.Output, provider.Requests(), daemon.output.String())
	}
}

func writeSeedEvidence(t *testing.T, directory string, result Result, messages []struct {
	Role string `json:"role"`
	Text string `json:"text"`
}, requests int, tokens int64, providerRequests int, daemonOutput string) {
	t.Helper()
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("evidence dir: %v", err)
	}
	payload := map[string]any{
		"seededAt":           time.Now().UTC().Format(time.RFC3339),
		"seed":               result,
		"messageCount":       len(messages),
		"trajectoryRequests": requests,
		"trajectoryTokens":   tokens,
		"providerRequests":   providerRequests,
	}
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		t.Fatalf("encode evidence: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "seed.json"), append(encoded, '\n'), 0o644); err != nil {
		t.Fatalf("write evidence: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "daemon.log"), []byte(daemonOutput), 0o644); err != nil {
		t.Fatalf("write daemon log: %v", err)
	}
}
