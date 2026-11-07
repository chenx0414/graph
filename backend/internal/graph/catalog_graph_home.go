package graph

import (
	"path/filepath"
	"strings"

	"os"
)

func GraphHome(env ...map[string]string) string {
	configured := ""
	if len(env) > 0 && env[0] != nil {
		configured = strings.TrimSpace(env[0]["GRAPH_HOME"])
	} else {
		configured = strings.TrimSpace(os.Getenv("GRAPH_HOME"))
	}
	if configured != "" {
		return filepath.Clean(configured)
	}
	return filepath.Join(homeDir(), ".graph")
}

func homeDir() string {
	dir, err := os.UserHomeDir()
	if err != nil {
		panic(err)
	}
	return dir
}

func CapabilityRoot(home ...string) string {
	root := GraphHome()
	if len(home) > 0 && home[0] != "" {
		root = home[0]
	}
	return filepath.Join(root, "capabilities")
}
