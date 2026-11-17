package seed

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const DefaultCredentialRef = "GRAPH_SEED_LOCAL_KEY"

type Config struct {
	ProjectID   string
	ProjectRoot string
	ModelID     string
	BaseURL     string
	Credential  string
}

type projectEntry struct {
	ID   string `json:"id"`
	Root string `json:"root"`
}

type credentialEntry struct {
	SecretRef string `json:"secretRef"`
}

type modelCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

type modelEntry struct {
	ID            string    `json:"id"`
	ModelID       string    `json:"modelId"`
	Provider      string    `json:"provider"`
	Grade         string    `json:"grade"`
	API           string    `json:"api"`
	BaseURL       string    `json:"baseUrl"`
	ContextWindow int       `json:"contextWindow"`
	MaxTokens     int       `json:"maxTokens"`
	CredentialID  string    `json:"credentialId"`
	Cost          modelCost `json:"cost"`
}

type configDocument struct {
	Version     int                        `json:"version"`
	Projects    []projectEntry             `json:"projects"`
	Credentials map[string]credentialEntry `json:"credentials"`
	Models      struct {
		Entries []modelEntry `json:"entries"`
	} `json:"models"`
}

func DefaultConfig(projectID, projectRoot, baseURL string) Config {
	return Config{
		ProjectID:   projectID,
		ProjectRoot: projectRoot,
		ModelID:     "seed",
		BaseURL:     baseURL,
		Credential:  DefaultCredentialRef,
	}
}

func (c Config) Document() configDocument {
	model := c.ModelID
	if model == "" {
		model = "seed"
	}
	credential := c.Credential
	if credential == "" {
		credential = DefaultCredentialRef
	}
	document := configDocument{Version: 1}
	document.Projects = []projectEntry{{ID: c.ProjectID, Root: c.ProjectRoot}}
	document.Credentials = map[string]credentialEntry{"local": {SecretRef: credential}}
	document.Models.Entries = []modelEntry{{
		ID:            model,
		ModelID:       model,
		Provider:      "graph-openai",
		Grade:         "high",
		API:           "openai-completions",
		BaseURL:       c.BaseURL,
		ContextWindow: 32000,
		MaxTokens:     256,
		CredentialID:  "local",
	}}
	return document
}

func WriteConfig(path string, c Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(c.ProjectRoot, 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(c.Document(), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(payload, '\n'), 0o600)
}

func (c Config) Env() map[string]string {
	credential := c.Credential
	if credential == "" {
		credential = DefaultCredentialRef
	}
	return map[string]string{credential: "seed-key"}
}
