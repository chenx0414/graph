package main

import (
	"strings"
	"testing"
)

// Nine providers serve 262 models here, and 35 short names are served by more
// than one of them. The chip named the current model by its short name alone, so
// seven different deepseek-v4.1-flash entries all read "deepseek-v4.1-flash" and
// the chip could not say which one was in use.
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

// The picker lists a row per provider entry. Two rows that read the same are two
// rows the reader cannot choose between, so every row must carry enough of its
// identity to tell it from its neighbours.
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

// A model no other provider duplicates keeps the short name: the provider is
// noise when it is the only one serving that name.
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

// One provider can serve the same short name under several ids - here
// "opencode-go", "opencode-go:auto/..." and "opencode-go:opencode-go/..." all read
// deepseek-v4.1-flash. Naming the provider does not separate them, so the id has
// to.
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
