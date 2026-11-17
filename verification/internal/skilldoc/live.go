package skilldoc

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

func LiveCommands(skillDir string) ([]string, error) {
	entry := filepath.Join(filepath.Dir(skillDir), "verify-graph")
	command := exec.Command(entry, "help", "--json")
	command.Dir = filepath.Dir(skillDir)
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("skilldoc: %s help --json failed: %w", entry, err)
	}
	return parseCommandSurface(output)
}

func parseCommandSurface(payload []byte) ([]string, error) {
	var document struct {
		Data struct {
			Commands []map[string]any `json:"commands"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, fmt.Errorf("skilldoc: help --json is not readable: %w", err)
	}
	commands := []string{}
	for _, entry := range document.Data.Commands {
		name, _ := entry["name"].(string)
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		commands = append(commands, name)
	}
	if len(commands) == 0 {
		return nil, fmt.Errorf("skilldoc: help --json named no command")
	}
	sort.Strings(commands)
	return commands, nil
}
