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
	// The skill directory is <verification>/skills/verify-graph and the wrapper
	// lives two levels up at <verification>/verify-graph. Looking only one level
	// up pointed at <verification>/skills/verify-graph, so the repository test
	// silently skipped instead of proving the documented command surface.
	candidates := []string{
		filepath.Join(filepath.Dir(filepath.Dir(skillDir)), "verify-graph"),
		filepath.Join(filepath.Dir(skillDir), "verify-graph"),
	}
	var last error
	for _, entry := range candidates {
		command := exec.Command(entry, "help", "--json")
		command.Dir = filepath.Dir(entry)
		output, err := command.Output()
		if err != nil {
			last = fmt.Errorf("skilldoc: %s help --json failed: %w", entry, err)
			continue
		}
		return parseCommandSurface(output)
	}
	return nil, last
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
