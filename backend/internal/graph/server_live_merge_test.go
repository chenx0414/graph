package graph

import "testing"

func liveMergeFixture() (GraphConfig, map[string]string) {
	entry := func(id, credential string) ConfiguredModel {
		return ConfiguredModel{
			ModelEntry:   ModelEntry{Id: id, Provider: "p", Api: "openai-completions", BaseUrl: "http://127.0.0.1:1", ContextWindow: 1000, MaxTokens: 100, CredentialId: credential},
			CredentialID: credential,
		}
	}
	config := GraphConfig{
		Configured: true,
		Models:     &GraphModels{Entries: []ConfiguredModel{entry("first", "cred-a"), entry("second", "cred-b")}},
		Credentials: map[string]CredentialConfig{
			"cred-a": {SecretRef: "GRAPH_TEST_KEY_A"},
			"cred-b": {SecretRef: "GRAPH_TEST_KEY_B"},
		},
	}
	return config, map[string]string{"GRAPH_TEST_KEY_A": "ka", "GRAPH_TEST_KEY_B": "kb"}
}

func TestTheDefaultModelDefaultsToTheFirstUsableModel(t *testing.T) {
	config, env := liveMergeFixture()
	if master := liveCompute(config, 1, env, nil, nil).state.MasterModel; master != "first" {
		t.Fatalf("without a choice the first usable model is the default, got %q", master)
	}
}

func TestAConfiguredDefaultModelWins(t *testing.T) {
	config, env := liveMergeFixture()
	config.MasterModel = "second"
	if master := liveCompute(config, 1, env, nil, nil).state.MasterModel; master != "second" {
		t.Fatalf("the configured default model has to win, got %q", master)
	}
}

func TestADefaultModelThatCannotBeUsedFallsBack(t *testing.T) {
	config, env := liveMergeFixture()
	config.MasterModel = "missing"
	if master := liveCompute(config, 1, env, nil, nil).state.MasterModel; master != "first" {
		t.Fatalf("a default model that is not usable has to fall back to the first usable one, got %q", master)
	}
	config.MasterModel = "second"
	if master := liveCompute(config, 1, map[string]string{"GRAPH_TEST_KEY_A": "ka"}, nil, nil).state.MasterModel; master != "first" {
		t.Fatalf("a default model without a credential falls back as well, got %q", master)
	}
}
