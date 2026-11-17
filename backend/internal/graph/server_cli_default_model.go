package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

const defaultModelUsage = "usage: graphd default-model [--config <path>] [--state-dir <path>] <model-id>"

func runDefaultModel(args []string, cwd string, env map[string]string) int {
	path := ""
	stateDir := ""
	model := ""
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--config":
			index++
			if index < len(args) {
				path = args[index]
			}
		case "--state-dir":
			index++
			if index < len(args) {
				stateDir = args[index]
			}
		default:
			model = args[index]
		}
	}
	if stateDir == "" {
		stateDir = env["GRAPH_STATE_DIR"]
	}
	if path == "" {
		path = env["GRAPH_CONFIG"]
	}
	if path == "" {
		path = filepath.Join(cwd, "graph.config.json")
	}
	if model == "" {
		fmt.Fprintln(os.Stdout, defaultModelUsage)
		return 2
	}
	text, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "graph: invalid_input: cannot read %s: %v\n", path, err)
		return 1
	}
	document, parseErr := parseOrderedJSON(string(text))
	if parseErr != nil || document.kind != 'o' {
		fmt.Fprintf(os.Stderr, "graph: invalid_config: %s is not a config object\n", path)
		return 1
	}
	revision := 0
	if raw, ok := document.get("revision"); ok && raw.kind == 'f' && orderedInteger(raw.num) {
		if value, err := strconv.Atoi(raw.num); err == nil {
			revision = value
		}
	}
	config := ParseGraphConfig(document.any(), path)
	known := map[string]bool{}
	if config.Models != nil {
		for _, entry := range config.Models.Entries {
			known[entry.Id] = true
		}
	}
	if !known[model] {
		fmt.Fprintf(os.Stderr, "graph: invalid_input: %q is not one of the configured models\n", model)
		return 1
	}
	document.set("masterModel", &orderedJSON{kind: 's', str: model})
	store := OpenConfigStore(path)
	if stateDir != "" {
		store = store.OwnStateDir(stateDir)
	}
	result := store.Save(document, revision, env, nil)
	fmt.Fprintf(os.Stdout, "default model: %s (config revision %d)\n", result.Config.MasterModel, result.Revision)
	return 0
}
