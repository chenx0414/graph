package graph

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"encoding/json"
)

type BootstrapDefinition struct {
	Id     string `json:"id"`
	Review bool   `json:"review,omitempty"`
}

type PresetFailure struct {
	Id     string `json:"id"`
	Reason string `json:"reason"`
}

type PresetBootstrap struct {
	Available   bool                  `json:"available"`
	Prompts     map[string]string     `json:"prompts"`
	ToolPrompt  string                `json:"toolPrompt,omitempty"`
	Definitions []BootstrapDefinition `json:"definitions"`
	Installed   []string              `json:"installed"`
	Failed      []PresetFailure       `json:"failed"`
}

type PresetCatalog interface {
	PublishDefinition(id string, spec DefinitionSpec) PublishedDefinition
}

type presetDefinitionEnsurer interface {
	EnsureDefinition(id string, spec DefinitionSpec) PublishedDefinition
}

type presetBootstrapSection struct {
	Prompts     map[string]string     `json:"prompts"`
	ToolPrompt  string                `json:"toolPrompt"`
	Definitions []BootstrapDefinition `json:"definitions"`
}

func presetLog(log func(string), line string) {
	if log != nil {
		log(line)
	}
}

func presetRecover(fn func()) (err error) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		if failure, ok := recovered.(error); ok {
			err = failure
			return
		}
		err = fmt.Errorf("%v", recovered)
	}()
	fn()
	return nil
}

func LoadPresetBootstrap(presetsRoot string, log func(string)) PresetBootstrap {
	result := PresetBootstrap{
		Available:   false,
		Prompts:     map[string]string{},
		Definitions: []BootstrapDefinition{},
		Installed:   []string{},
		Failed:      []PresetFailure{},
	}
	bootstrap, err := readPresetBootstrap(presetsRoot)
	if err != nil {
		presetLog(log, "Bootstrap preset pack not available ("+err.Error()+"); built-in definitions stay minimal.")
		return result
	}
	result.Definitions = bootstrap.Definitions
	result.Available = true
	for name, relative := range bootstrap.Prompts {
		text, err := os.ReadFile(filepath.Join(presetsRoot, relative))
		if err != nil {
			result.Failed = append(result.Failed, PresetFailure{Id: "prompt:" + name, Reason: err.Error()})
			continue
		}
		if strings.TrimSpace(string(text)) == "" {
			result.Failed = append(result.Failed, PresetFailure{Id: "prompt:" + name, Reason: "prompt is empty"})
			continue
		}
		result.Prompts[name] = string(text)
	}
	if bootstrap.ToolPrompt != "" {
		text, err := os.ReadFile(filepath.Join(presetsRoot, bootstrap.ToolPrompt))
		if err != nil {
			result.Failed = append(result.Failed, PresetFailure{Id: "prompt:tool-awareness", Reason: err.Error()})
		} else if strings.TrimSpace(string(text)) == "" {
			result.Failed = append(result.Failed, PresetFailure{Id: "prompt:tool-awareness", Reason: "tool prompt is empty"})
		} else {
			result.ToolPrompt = string(text)
		}
	}
	return result
}

func readPresetBootstrap(presetsRoot string) (presetBootstrapSection, error) {
	path := filepath.Join(presetsRoot, "manifest.json")
	body, err := os.ReadFile(path)
	if err != nil {
		return presetBootstrapSection{}, err
	}
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		return presetBootstrapSection{}, err
	}
	raw, ok := document["bootstrap"].(map[string]any)
	if !ok {
		return presetBootstrapSection{}, errors.New("bootstrap.definitions must be an array")
	}
	if _, ok := raw["definitions"].([]any); !ok {
		return presetBootstrapSection{}, errors.New("bootstrap.definitions must be an array")
	}
	section, err := json.Marshal(raw)
	if err != nil {
		return presetBootstrapSection{}, err
	}
	var bootstrap presetBootstrapSection
	if err := json.Unmarshal(section, &bootstrap); err != nil {
		return presetBootstrapSection{}, err
	}
	if bootstrap.Definitions == nil {
		bootstrap.Definitions = []BootstrapDefinition{}
	}
	return bootstrap, nil
}

func PublishBootstrap(catalog PresetCatalog, bootstrap PresetBootstrap, log func(string)) PresetBootstrap {
	result := PresetBootstrap{
		Available:   bootstrap.Available,
		Prompts:     bootstrap.Prompts,
		ToolPrompt:  bootstrap.ToolPrompt,
		Definitions: []BootstrapDefinition{},
		Installed:   []string{},
		Failed:      append([]PresetFailure{}, bootstrap.Failed...),
	}
	ensurer, canEnsure := catalog.(presetDefinitionEnsurer)
	for _, definition := range bootstrap.Definitions {
		spec := DefinitionSpec{}
		if definition.Review {
			spec.Review = true
		}
		err := presetRecover(func() {
			if canEnsure {
				ensurer.EnsureDefinition(definition.Id, spec)
				return
			}
			catalog.PublishDefinition(definition.Id, spec)
		})
		if err != nil {
			result.Failed = append(result.Failed, PresetFailure{Id: definition.Id, Reason: err.Error()})
			presetLog(log, "Bootstrap definition "+definition.Id+" failed: "+err.Error())
			continue
		}
		result.Definitions = append(result.Definitions, definition)
		result.Installed = append(result.Installed, definition.Id)
	}
	return result
}

func InstallPresets(catalog PresetCatalog, presetsRoot string, log func(string)) PresetBootstrap {
	return PublishBootstrap(catalog, LoadPresetBootstrap(presetsRoot, log), log)
}
