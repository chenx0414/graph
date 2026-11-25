package graph

import (
	"encoding/json"
	"os"
	"regexp"
	"sort"
)

var secretRefPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func readRevocations(path string, config GraphConfig) ([]string, string) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ""
		}
		return everySecretRef(config), err.Error()
	}
	var parsed []any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return everySecretRef(config), err.Error()
	}
	refs := []string{}
	for _, item := range parsed {
		text, ok := item.(string)
		if !ok {
			return everySecretRef(config), "expected a JSON array of secret refs"
		}
		refs = append(refs, text)
	}
	return refs, ""
}

func everySecretRef(config GraphConfig) []string {
	seen := map[string]bool{}
	refs := []string{}
	for _, credential := range config.Credentials {
		if credential.SecretRef != "" && !seen[credential.SecretRef] {
			seen[credential.SecretRef] = true
			refs = append(refs, credential.SecretRef)
		}
	}
	sort.Strings(refs)
	return refs
}

func runtimeCatalog(host *GraphHost) *Catalog {
	if host == nil {
		return nil
	}
	if host.Runtime == nil {
		return nil
	}
	return host.Runtime.catalog
}

func ensureMainRecipe(catalog *Catalog, bootstrap PresetBootstrap, log func(string)) {
	if catalog == nil || bootstrap.Prompts["main"] == "" {
		return
	}
	if problem := catalog.AgentCombinationError(); problem != nil && *problem != "" {
		log("Main Agent recipe unavailable (" + *problem + "); using bootstrap master@1.")
		return
	}
	var existing *AgentCombinationView
	for _, item := range catalog.AgentCombinations() {
		if item.Id == "main" {
			copied := item
			existing = &copied
			break
		}
	}
	err := portRecover(func() {
		if existing == nil {
			catalog.SaveAgentCombination(AgentCombination{
				Id: "main", Name: "Atlas_main",
				Description: "持续面对用户、规划任务、设计并监控 Graph，并在确认范围内组装和调用 subagents。",
				Mode:        "main",
				Tags:        []string{"main", "system"},
				Resources:   []AgentCombinationResource{},
			})
			return
		}
		if existing.Mode != "main" {
			updated := existing.AgentCombination
			updated.Mode = "main"
			catalog.SaveAgentCombination(updated)
			return
		}
		catalog.CompileAgentCombination("main")
	})
	if err != nil {
		log("Main Agent recipe unavailable (" + err.Error() + "); using bootstrap master@1.")
	}
}
