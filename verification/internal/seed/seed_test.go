package seed

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func postChat(t *testing.T, endpoint string, body string) string {
	t.Helper()
	response, err := http.Post(endpoint+"/chat/completions", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("the stub provider refused a request: %v", err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("the stub provider sent no body: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the stub provider answered %d: %s", response.StatusCode, payload)
	}
	return string(payload)
}

func TestTheProviderAnswersWithTextWhenTheScriptHasNoStep(t *testing.T) {
	provider, err := StartProvider(Script{Final: "已就绪"})
	if err != nil {
		t.Fatalf("start provider: %v", err)
	}
	defer provider.Close()

	stream := postChat(t, provider.BaseURL, `{"messages":[{"role":"user","content":"hi"}],"stream":true}`)
	if !strings.Contains(stream, `"content":"已就绪"`) {
		t.Fatalf("the answer must carry the script text, stream %q", stream)
	}
	if !strings.Contains(stream, "data: [DONE]") {
		t.Fatalf("the stream must end with [DONE], stream %q", stream)
	}
	if !strings.Contains(stream, `"prompt_tokens":40`) {
		t.Fatalf("the stream must report usage so trajectory pages have numbers, stream %q", stream)
	}
	if answers := provider.Answers(); len(answers) != 1 || answers[0] != "已就绪" {
		t.Fatalf("the provider must remember what it answered, got %q", answers)
	}
}

func TestTheProviderCallsTheScriptedToolOnceThenAnswers(t *testing.T) {
	provider, err := StartProvider(Script{
		Steps: []Step{{Tool: "read", Arguments: map[string]any{"path": "README.md"}}},
		Final: "读完了",
	})
	if err != nil {
		t.Fatalf("start provider: %v", err)
	}
	defer provider.Close()

	first := postChat(t, provider.BaseURL, `{"messages":[{"role":"user","content":"读 README"}],"tools":[{"function":{"name":"read"}}]}`)
	if !strings.Contains(first, `"name":"read"`) || !strings.Contains(first, `README.md`) {
		t.Fatalf("the first turn must ask for the scripted tool, stream %q", first)
	}
	if !strings.Contains(first, `"finish_reason":"tool_calls"`) {
		t.Fatalf("a tool turn must finish as tool_calls, stream %q", first)
	}

	second := postChat(t, provider.BaseURL, `{"messages":[
		{"role":"user","content":"读 README"},
		{"role":"assistant","content":"","tool_calls":[{"id":"seed-step","type":"function","function":{"name":"read","arguments":"{}"}}]},
		{"role":"tool","content":"done"}
	],"tools":[{"function":{"name":"read"}}]}`)
	if !strings.Contains(second, `"content":"读完了"`) {
		t.Fatalf("the second turn must answer with the final text, stream %q", second)
	}
	if provider.Requests() != 2 {
		t.Fatalf("the provider must count both calls, got %d", provider.Requests())
	}
}

func TestTheProviderSkipsAToolTheTurnDoesNotOffer(t *testing.T) {
	provider, err := StartProvider(Script{
		Steps: []Step{{Tool: "read", Text: "没有 read 工具"}},
	})
	if err != nil {
		t.Fatalf("start provider: %v", err)
	}
	defer provider.Close()

	stream := postChat(t, provider.BaseURL, `{"messages":[{"role":"user","content":"hi"}],"tools":[{"function":{"name":"bash"}}]}`)
	if strings.Contains(stream, `"tool_calls"`) {
		t.Fatalf("a tool the turn does not offer must not be called, stream %q", stream)
	}
	if !strings.Contains(stream, `"content":"没有 read 工具"`) {
		t.Fatalf("the step text must be used instead, stream %q", stream)
	}
}

func TestWriteConfigPinsTheStubProviderAsAnExecutableModel(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "graph.config.json")
	project := filepath.Join(dir, "project")
	config := DefaultConfig("verify", project, "http://127.0.0.1:1234/v1")
	if err := WriteConfig(path, config); err != nil {
		t.Fatalf("write config: %v", err)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatalf("the config must be JSON: %v", err)
	}
	projects := document["projects"].([]any)
	first := projects[0].(map[string]any)
	if first["id"] != "verify" || first["root"] != project {
		t.Fatalf("the project must point at the seeded root, got %v", first)
	}
	entries := document["models"].(map[string]any)["entries"].([]any)
	model := entries[0].(map[string]any)
	if model["api"] != "openai-completions" || model["baseUrl"] != "http://127.0.0.1:1234/v1" {
		t.Fatalf("the model must speak openai-completions at the stub, got %v", model)
	}
	if model["credentialId"] != "local" {
		t.Fatalf("the model must reference the local credential, got %v", model)
	}
	credentials := document["credentials"].(map[string]any)["local"].(map[string]any)
	if credentials["secretRef"] != DefaultCredentialRef {
		t.Fatalf("the credential must be a secret reference, got %v", credentials)
	}
	if env := config.Env(); env[DefaultCredentialRef] == "" {
		t.Fatalf("the config must name the environment variable holding the seed key, got %v", env)
	}
}

type fakeConsole struct {
	posts    []string
	created  Created
	bodies   []map[string]any
	batches  [][]Operation
	requests int
}

func (f *fakeConsole) Post(path string, body, out any) error {
	f.posts = append(f.posts, path)
	if payload, ok := body.(map[string]any); ok {
		f.bodies = append(f.bodies, payload)
	}
	if out != nil {
		*(out.(*Created)) = f.created
	}
	return nil
}

func (f *fakeConsole) JSON(path string, out any) error {
	f.requests++
	batch := f.batches[0]
	if len(f.batches) > 1 {
		f.batches = f.batches[1:]
	}
	*(out.(*[]Operation)) = batch
	return nil
}

func TestSeedCreatesAConversationAndWaitsForTheOperationsToSettle(t *testing.T) {
	console := &fakeConsole{
		created: Created{ConversationID: "c1", TaskID: "t1"},
		batches: [][]Operation{
			{{ID: "o1", State: "running", WorkerActive: true}},
			{{ID: "o1", State: "succeeded"}},
		},
	}
	clock := time.Unix(0, 0)
	result, err := Seed(console, Options{
		Model: "seed",
		Now:   func() time.Time { return clock },
		Sleep: func(d time.Duration) { clock = clock.Add(d) },
		Poll:  time.Second,
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	if !result.Completed || !result.Succeeded {
		t.Fatalf("a settled successful operation must be reported as succeeded, got %+v", result)
	}
	if result.ConversationID != "c1" || result.TaskID != "t1" {
		t.Fatalf("the console's ids must come back, got %+v", result)
	}
	if len(console.posts) != 1 || console.posts[0] != "/api/conversations" {
		t.Fatalf("the seed must create one conversation, got %v", console.posts)
	}
	body := console.bodies[0]
	if body["projectId"] != "verify" || body["model"] != "seed" || body["text"] == "" || body["requestId"] == "" {
		t.Fatalf("the conversation must carry project, model, text and request id, got %v", body)
	}
	if result.ElapsedMs != 1000 {
		t.Fatalf("the elapsed time must come from the injected clock, got %d", result.ElapsedMs)
	}
}

func TestSeedReportsAFailedOperationWithoutPretendingItSucceeded(t *testing.T) {
	console := &fakeConsole{
		created: Created{ConversationID: "c1", TaskID: "t1"},
		batches: [][]Operation{{{ID: "o1", State: "failed"}}},
	}
	result, err := Seed(console, Options{})
	if err != nil {
		t.Fatalf("a failed operation is a result, not a transport error: %v", err)
	}
	if !result.Completed || result.Succeeded {
		t.Fatalf("a failed operation must be completed but not succeeded, got %+v", result)
	}
}

func TestSeedTimesOutWhenTheOperationsNeverSettle(t *testing.T) {
	console := &fakeConsole{
		created: Created{ConversationID: "c1", TaskID: "t1"},
		batches: [][]Operation{{{ID: "o1", State: "running", WorkerActive: true}}},
	}
	clock := time.Unix(0, 0)
	result, err := Seed(console, Options{
		Timeout: 2 * time.Second,
		Poll:    time.Second,
		Now:     func() time.Time { return clock },
		Sleep:   func(d time.Duration) { clock = clock.Add(d) },
	})
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("a stuck operation must time out, got %v", err)
	}
	if result.Completed || result.Succeeded {
		t.Fatalf("a timed out seed is neither completed nor succeeded, got %+v", result)
	}
}

func TestSeedRejectsAConsoleThatCreatedNoConversation(t *testing.T) {
	console := &fakeConsole{created: Created{TaskID: "t1"}}
	if _, err := Seed(console, Options{}); err == nil {
		t.Fatal("a console answer without a conversation id must be an error")
	}
}

func TestTheStubProviderServesWhatASeedNeeds(t *testing.T) {
	provider, err := StartProvider(Script{Final: "ok"})
	if err != nil {
		t.Fatalf("start provider: %v", err)
	}
	defer provider.Close()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Write([]byte(`{"conversationId":"c","taskId":"t"}`))
	}))
	defer server.Close()
	var created Created
	if err := json.NewDecoder(strings.NewReader(`{"conversationId":"c","taskId":"t"}`)).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.TaskID != "t" {
		t.Fatalf("the console answer shape must decode, got %+v", created)
	}
}

func TestPrepareGivesALauncherAConfigAndAProviderInOneCall(t *testing.T) {
	root := t.TempDir()
	instance, err := Prepare(root, "verify", "anton")
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	defer instance.Close()
	if instance.Provider == nil || instance.Provider.BaseURL == "" {
		t.Fatal("prepare must start the stub provider")
	}
	payload, err := os.ReadFile(instance.ConfigPath)
	if err != nil {
		t.Fatalf("the config must sit where launch writes it: %v", err)
	}
	if !strings.Contains(string(payload), instance.Provider.BaseURL) {
		t.Fatalf("the config must point the model at the stub provider, got %s", payload)
	}
	if _, err := os.Stat(filepath.Join(root, "project")); err != nil {
		t.Fatalf("the project root the config names must exist: %v", err)
	}
	if env := instance.Env(); env[DefaultCredentialRef] == "" {
		t.Fatalf("prepare must hand back the environment the daemon needs, got %v", env)
	}
	stream := postChat(t, instance.Provider.BaseURL, `{"messages":[{"role":"user","content":"hi"}]}`)
	if !strings.Contains(stream, `"content":"anton"`) {
		t.Fatalf("the prepared provider must answer with the given text, stream %q", stream)
	}
}

func TestPrepareRefusesAnEmptyRunRoot(t *testing.T) {
	if _, err := Prepare("", "verify", ""); err == nil {
		t.Fatal("prepare without a run root must fail instead of writing into the process working directory")
	}
}
