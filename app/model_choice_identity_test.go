package main

import (
	"strings"
	"testing"
)

// Nine providers serve 262 models and 35 short names are duplicated, so a short name alone cannot name a choice.
func TestTheModelChipNamesTheProviderThatServesTheChoice(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.models = []modelChoice{
		{id: "command-goat:deepseek/deepseek-v4.1-flash", provider: "command-goat"},
		{id: "opencode-go:deepseek-v4.1-flash", provider: "opencode-go"},
		{id: "commandcode-plan:commandcode-plan/deepseek/deepseek-v4.1-flash", provider: "commandcode-plan"},
	}
	state.currentModel = "opencode-go:deepseek-v4.1-flash"
	text := state.modelChipLabel()
	if !strings.Contains(text, "opencode-go") {
		t.Fatalf("the chip must name the provider when several serve the same model, got %q", text)
	}
}

// Every picker row must be tellable from its neighbours.
func TestEveryPickerRowIsDistinctWhenProvidersShareAModelName(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.models = []modelChoice{
		{id: "command-goat:deepseek/deepseek-v4.1-flash", provider: "command-goat"},
		{id: "opencode-go:deepseek-v4.1-flash", provider: "opencode-go"},
		{id: "commandcode-plan:commandcode-plan/deepseek/deepseek-v4.1-flash", provider: "commandcode-plan"},
		{id: "grok:grok-4.5", provider: "grok"},
	}
	seen := map[string]string{}
	for _, model := range state.pickerModels() {
		label := state.pickerRowLabel(model)
		if previous, ok := seen[label]; ok {
			t.Fatalf("%s and %s both read %q in the picker", previous, model.id, label)
		}
		seen[label] = model.id
	}
}

func TestAnUnambiguousPickerRowStaysShort(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.models = []modelChoice{
		{id: "grok:grok-4.5", provider: "grok"},
		{id: "opencode-go:deepseek-v4.1-flash", provider: "opencode-go"},
	}
	for _, model := range state.pickerModels() {
		if label := state.pickerRowLabel(model); label != shortModel(model.id) {
			t.Fatalf("an unambiguous row shows its short name, got %q for %s", label, model.id)
		}
	}
}

// One provider serves deepseek-v4.1-flash under three ids here, so the id has to separate them.
func TestRowsStayDistinctWhenOneProviderServesTheSameNameTwice(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.models = []modelChoice{
		{id: "opencode-go:deepseek-v4.1-flash", provider: "opencode-go"},
		{id: "opencode-go:auto/deepseek-v4.1-flash", provider: "opencode-go"},
		{id: "opencode-go:opencode-go/deepseek-v4.1-flash", provider: "opencode-go"},
	}
	seen := map[string]string{}
	for _, model := range state.pickerModels() {
		label := state.pickerRowLabel(model)
		if previous, ok := seen[label]; ok {
			t.Fatalf("%s and %s both read %q", previous, model.id, label)
		}
		seen[label] = model.id
	}
}
