package graph

import (
	"os"
	"path/filepath"

	"encoding/json"
)

type ConsoleAddress struct {
	URL       string `json:"url"`
	PID       int    `json:"pid"`
	Mode      string `json:"mode"`
	StartedAt int64  `json:"startedAt"`
}

func ConsoleAddressPath(stateDir string) string {
	return filepath.Join(stateDir, "console.json")
}

func WriteConsoleAddress(stateDir string, address ConsoleAddress) {
	raw, err := json.MarshalIndent(address, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(ConsoleAddressPath(stateDir), append(raw, '\n'), 0o600); err != nil {
		panic(err)
	}
}

func ReadConsoleAddress(stateDir string) *ConsoleAddress {
	raw, err := os.ReadFile(ConsoleAddressPath(stateDir))
	if err != nil {
		return nil
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	url, _ := value["url"].(string)
	if url == "" || len(url) < 4 || url[:4] != "http" {
		return nil
	}
	pid, ok := consoleJSONNumber(value["pid"])
	if !ok {
		return nil
	}
	mode := "view"
	if value["mode"] == "execute" {
		mode = "execute"
	}
	started := int64(0)
	if n, ok := consoleJSONNumber(value["startedAt"]); ok {
		started = int64(n)
	}
	return &ConsoleAddress{URL: url, PID: int(pid), Mode: mode, StartedAt: started}
}

func consoleJSONNumber(value any) (float64, bool) {
	switch n := value.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}
