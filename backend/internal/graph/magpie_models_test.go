package graph

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func magpieModelsDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeMagpieFile(t, dir, "providers.json", `{"providers":[
		{"id":"codex","name":"ChatGPT","keys":[{"key":"x"}]},
		{"id":"deepseek","name":"DeepSeek","key":"sk-test"},
		{"id":"acme","name":"Acme","key":"a-test"},
		{"id":"gemini","name":"Google Gemini","key":"g-test","off":true},
		{"id":"grok","name":"Grok"}
	]}`)
	return dir
}

type magpieGatewayStub struct {
	models atomic.Value
	hits   atomic.Int32
}

func (stub *magpieGatewayStub) setModels(body string) { stub.models.Store(body) }

func (stub *magpieGatewayStub) server(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		stub.hits.Add(1)
		body, _ := stub.models.Load().(string)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

const magpieModelsGatewayBody = `{"data":[
 {"id":"codex/gpt-6.1-sol","owned_by":"codex","context_window":500000,"max_output_tokens":128000,"reasoning":true,"reasoning_levels":["low","medium","high"]},
 {"id":"deepseek/deepseek-flash","owned_by":"deepseek","context_window":1048576,"max_output_tokens":393216,"reasoning":true,"reasoning_levels":["none","low","high","max"]},
 {"id":"acme/alpha","owned_by":"acme","context_window":128000,"max_output_tokens":8192},
 {"id":"gemini/gemini-4-carbon","owned_by":"gemini","context_window":1000000,"max_output_tokens":64000},
 {"id":"grok/grok-4.7","owned_by":"grok","context_window":256000,"max_output_tokens":256000}
]}`

func TestTheMagpieModelsBecomeGraphModelsForEnabledProviders(t *testing.T) {
	dir := magpieModelsDir(t)
	stub := &magpieGatewayStub{}
	stub.setModels(magpieModelsGatewayBody)
	server := stub.server(t)

	entries := loadMagpieModelEntries(dir, server.URL)
	if len(entries) != 3 {
		t.Fatalf("only configured, switched-on providers offer models, got %+v", entries)
	}
	byID := map[string]ConfiguredModel{}
	for _, entry := range entries {
		byID[entry.Id] = entry
	}
	codex, ok := byID["codex:codex/gpt-6.1-sol"]
	if !ok {
		t.Fatalf("codex keeps its gateway model id, got %+v", byID)
	}
	if codex.Provider != "codex" || codex.ModelId != "codex/gpt-6.1-sol" {
		t.Fatalf("the model keeps its provider and wire id, got %+v", codex.ModelEntry)
	}
	if codex.BaseUrl != server.URL+"/v1" || codex.Api != "openai-completions" {
		t.Fatalf("the model routes through the magpie gateway, got %+v", codex.ModelEntry)
	}
	if codex.ContextWindow != 500000 || codex.MaxTokens != 128000 {
		t.Fatalf("the gateway limits carry over, got %+v", codex.ModelEntry)
	}
	if codex.CredentialId != MAGPIE_CREDENTIAL_ID || codex.DefaultThinkingLevel != "medium" {
		t.Fatalf("the model gets magpie's credential and the gateway's level, got %+v", codex.ModelEntry)
	}
	if _, ok := byID["deepseek:deepseek/deepseek-flash"]; !ok {
		t.Fatalf("deepseek offers its own models, got %+v", byID)
	}
	if _, ok := byID["acme:acme/alpha"]; !ok {
		t.Fatalf("a provider graph has never heard of still appears, got %+v", byID)
	}
	for id := range byID {
		if strings.HasPrefix(id, "gemini:") || strings.HasPrefix(id, "grok:") {
			t.Fatalf("a switched-off or unconfigured provider stays out, got %q", id)
		}
	}
}

func TestAMagpieModelIdIsProviderPrefixedAndNeverReplacesAGraphModel(t *testing.T) {
	dir := magpieModelsDir(t)
	entries := loadMagpieModelEntries(dir, "")
	if len(entries) != 0 {
		t.Fatalf("without a gateway there are no models, got %+v", entries)
	}

	base := []ConfiguredModel{{ModelEntry: ModelEntry{Id: "codex:codex/gpt-6.1-sol", Provider: "codex", BaseUrl: "https://graph.example/v1"}, ID: "codex:codex/gpt-6.1-sol"}}
	extra := []ConfiguredModel{{ModelEntry: ModelEntry{Id: "codex:codex/gpt-6.1-sol", Provider: "codex", BaseUrl: "http://gateway.example/v1"}, ID: "codex:codex/gpt-6.1-sol"}}
	merged := mergeMagpieConfiguredModels(base, extra)
	if len(merged) != 1 {
		t.Fatalf("a clashing magpie id never duplicates a graph model, got %+v", merged)
	}
	if merged[0].BaseUrl != "https://graph.example/v1" {
		t.Fatalf("the graph model stays exactly as configured, got %+v", merged[0])
	}

	generated := []ConfiguredModel{{ModelEntry: ModelEntry{Id: "codex:codex/gpt-6.1-sol", Provider: "codex"}}}
	_ = generated

	for _, entry := range extra {
		prefix, rest, ok := strings.Cut(entry.Id, ":")
		if !ok || prefix != entry.Provider || rest == "" {
			t.Fatalf("the id names its provider first, got %+v", entry.ModelEntry)
		}
	}
}

func TestTheMagpieModelListFollowsAProviderRefresh(t *testing.T) {
	dir := magpieModelsDir(t)
	stub := &magpieGatewayStub{}
	stub.setModels(`{"data":[{"id":"codex/gpt-6.1-sol","owned_by":"codex"}]}`)
	server := stub.server(t)
	t.Setenv("GRAPH_MAGPIE_DIR", dir)
	writeMagpieFile(t, dir, "gateway.json", `{"addr":"`+strings.TrimPrefix(server.URL, "http://")+`"}`)

	source := NewMagpieModels()
	if entries := source.Entries(); len(entries) != 1 {
		t.Fatalf("the source reads magpie's models, got %+v", entries)
	}
	stub.setModels(`{"data":[
		{"id":"codex/gpt-6.1-sol","owned_by":"codex"},
		{"id":"codex/gpt-6.1-terra","owned_by":"codex"}
	]}`)
	if entries := source.Entries(); len(entries) != 1 {
		t.Fatalf("a read is cached until refreshed, got %+v", entries)
	}

	app := &GraphApp{runtime: &TaskRuntime{magpie: source}}
	server2 := httptest.NewServer(http.HandlerFunc(app.serveMagpieProviders))
	defer server2.Close()
	response, err := http.Get(server2.URL)
	if err != nil {
		t.Fatalf("read providers: %v", err)
	}
	_ = response.Body.Close()

	if entries := source.Entries(); len(entries) != 2 {
		t.Fatalf("reading providers refreshes the model list, got %+v", entries)
	}
}

func TestARuntimeSelectsAMagpieModelAndBindsTheGateway(t *testing.T) {
	dir := magpieModelsDir(t)
	stub := &magpieGatewayStub{}
	stub.setModels(magpieModelsGatewayBody)
	gateway := stub.server(t)
	source := newMagpieModels(func() string { return dir }, func() string { return gateway.URL })

	runtime := &TaskRuntime{magpie: source}
	configured := runtime.liveConfiguredEntries()
	if len(configured) != 3 {
		t.Fatalf("the runtime sees magpie's models, got %+v", configured)
	}
	selected := SelectModel(SelectModelInput{Requested: "codex:codex/gpt-6.1-sol", Directory: runtime.liveEntries()})
	if selected == nil || selected.Id != "codex:codex/gpt-6.1-sol" {
		t.Fatalf("the runtime selects a magpie model by its id, got %+v", selected)
	}
	binding := runtime.liveCredentialFor(*selected)
	if binding == nil || binding.ApiKey == "" || binding.CredentialId != MAGPIE_CREDENTIAL_ID {
		t.Fatalf("the magpie model carries a gateway credential, got %+v", binding)
	}
}

func TestAMagpieTurnSendsTheGatewayModelIdAndKey(t *testing.T) {
	dir := magpieModelsDir(t)
	stub := &magpieGatewayStub{}
	stub.setModels(magpieModelsGatewayBody)
	gateway := stub.server(t)
	entries := loadMagpieModelEntries(dir, gateway.URL)
	var codex ConfiguredModel
	for _, entry := range entries {
		if entry.Provider == "codex" {
			codex = entry
		}
	}
	if codex.Id == "" {
		t.Fatalf("the fixture has a codex model, got %+v", entries)
	}

	request := make(chan map[string]any, 1)
	chat := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		body["authorization"] = r.Header.Get("authorization")
		request <- body
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"id\":\"r\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"id\":\"r\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer chat.Close()
	wire := codex.ModelEntry
	wire.BaseUrl = chat.URL + "/v1"

	gate := SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any { return send() },
		Settle:   func(id string, usage *TokenUsage) {},
	}
	stream := ControlledOpenAIStream(gate, wire,
		func(ModelEntry) string { return magpieAPIKey() },
		func(ModelEntry) *piAdapterSlot { return nil },
		"openai-completions", PiAdapterStreamOptions{})
	opened, err := stream(map[string]any{"id": wire.ModelId, "api": "openai-completions", "provider": wire.Provider, "baseUrl": wire.BaseUrl},
		map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hello"}}}, nil)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	for {
		if _, ok := opened.Next(); !ok {
			break
		}
	}
	select {
	case body := <-request:
		if body["model"] != "codex/gpt-6.1-sol" {
			t.Fatalf("the turn names magpie's model id, got %v", body["model"])
		}
		if body["authorization"] != "Bearer "+magpieAPIKey() {
			t.Fatalf("the turn carries the magpie key, got %v", body["authorization"])
		}
	default:
		t.Fatal("the turn reached the gateway")
	}
}

func TestTheSettingsModelListOffersMagpieModelsNextToTheGraphOnes(t *testing.T) {
	dir := magpieModelsDir(t)
	stub := &magpieGatewayStub{}
	stub.setModels(magpieModelsGatewayBody)
	gateway := stub.server(t)
	source := newMagpieModels(func() string { return dir }, func() string { return gateway.URL })
	runtime := &TaskRuntime{
		magpie: source,
		models: &TaskRuntimeModels{Entries: []ConfiguredModel{{
			ModelEntry: ModelEntry{Id: "opencode-go:deepseek-v4.1-flash", Provider: "opencode-go", Api: "openai-completions", BaseUrl: "https://opencode.ai/zen/go/v1"},
		}}},
	}

	listed := runtime.Models()
	ids := []string{}
	for _, row := range listed {
		id, _ := row["id"].(string)
		ids = append(ids, id)
	}
	want := []string{"opencode-go:deepseek-v4.1-flash", "acme:acme/alpha", "codex:codex/gpt-6.1-sol", "deepseek:deepseek/deepseek-flash"}
	if len(ids) != len(want) {
		t.Fatalf("the settings list keeps the graph model and adds magpie's, got %v", ids)
	}
	for index, id := range want {
		if ids[index] != id {
			t.Fatalf("the settings list keeps graph models first, got %v", ids)
		}
	}
	if listed[0]["baseUrl"] != "https://opencode.ai/zen/go/v1" {
		t.Fatalf("the graph model keeps its own endpoint, got %+v", listed[0])
	}
	if listed[1]["baseUrl"] != gateway.URL+"/v1" {
		t.Fatalf("the magpie model routes through the gateway, got %+v", listed[1])
	}
}
