package graph

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"encoding/json"
)

// BootstrapDefinition is one preset definition the bootstrap pack publishes.
type BootstrapDefinition struct {
	Id               string     `json:"id"`
	Review           bool       `json:"review,omitempty"`
}

// PresetFailure is one preset entry that could not be loaded or published.
type PresetFailure struct {
	Id     string `json:"id"`
	Reason string `json:"reason"`
}

// PresetBootstrap is the immutable Graph bootstrap content. Third-party capabilities
// never live in presets; they are scanned from the user's ~/.graph/capabilities root.
type PresetBootstrap struct {
	Available   bool                  `json:"available"`
	Prompts     map[string]string     `json:"prompts"`
	ToolPrompt  string                `json:"toolPrompt,omitempty"`
	Definitions []BootstrapDefinition `json:"definitions"`
	Installed   []string              `json:"installed"`
	Failed      []PresetFailure       `json:"failed"`
}

// PresetCatalog publishes the preset definitions.
type PresetCatalog interface {
	PublishDefinition(id string, spec DefinitionSpec) PublishedDefinition
}

// presetDefinitionEnsurer is the optional ensure half of the catalog contract. A catalog
// that can ensure a definition reuses the published one instead of adding a version.
type presetDefinitionEnsurer interface {
	EnsureDefinition(id string, spec DefinitionSpec) PublishedDefinition
}

// presetBootstrapSection is the bootstrap block of the preset manifest.
type presetBootstrapSection struct {
	Prompts     map[string]string     `json:"prompts"`
	ToolPrompt  string                `json:"toolPrompt"`
	Definitions []BootstrapDefinition `json:"definitions"`
}

// presetLog writes one line through the caller's logger, if there is one.
func presetLog(log func(string), line string) {
	if log != nil {
		log(line)
	}
}

// presetRecover runs fn and reports the panic it raised as an error.
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

// LoadPresetBootstrap loads the immutable Graph bootstrap content.
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

// readPresetBootstrap reads the bootstrap block of the preset manifest. A manifest without
// a definitions array is not a usable pack.
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

// PublishBootstrap publishes every preset definition into the catalog. A definition that
// cannot be published is reported as a failure and the rest still install.
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

// InstallPresets loads the preset pack and publishes it into the catalog.
func InstallPresets(catalog PresetCatalog, presetsRoot string, log func(string)) PresetBootstrap {
	return PublishBootstrap(catalog, LoadPresetBootstrap(presetsRoot, log), log)
}
