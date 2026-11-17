package core

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
)

type Roots struct {
	Verification string
	Repo         string
}

func Locate() (Roots, error) {
	if root := os.Getenv("VERIFY_GRAPH_ROOT"); root != "" {
		absolute, err := filepath.Abs(root)
		if err != nil {
			return Roots{}, err
		}
		return Roots{Verification: absolute, Repo: filepath.Dir(absolute)}, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return Roots{}, err
	}
	directory := filepath.Dir(executable)
	for {
		if exists(filepath.Join(directory, "go.mod")) && exists(filepath.Join(directory, "verify-graph")) {
			return Roots{Verification: directory, Repo: filepath.Dir(directory)}, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			working, err := os.Getwd()
			if err != nil {
				return Roots{}, err
			}
			return Roots{Verification: working, Repo: filepath.Dir(working)}, nil
		}
		directory = parent
	}
}

func (r Roots) RunRoot() string { return filepath.Join(r.Verification, ".run") }

func exists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func NewRunID() string {
	buffer := make([]byte, 4)
	if _, err := rand.Read(buffer); err != nil {
		return "fallback"
	}
	return hex.EncodeToString(buffer)
}
