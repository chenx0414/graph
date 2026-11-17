package seed

import (
	"os"
	"path/filepath"
)

type Instance struct {
	Provider   *Provider
	Config     Config
	ConfigPath string
}

func (i *Instance) Env() map[string]string {
	if i == nil {
		return nil
	}
	return i.Config.Env()
}

func (i *Instance) Close() error {
	if i == nil {
		return nil
	}
	return i.Provider.Close()
}

func Prepare(runRoot, projectID, final string) (*Instance, error) {
	if runRoot == "" {
		return nil, os.ErrInvalid
	}
	if projectID == "" {
		projectID = "verify"
	}
	if final == "" {
		final = "已就绪。这条回答来自验证用的替身模型，不消耗任何真实额度。"
	}
	if err := os.MkdirAll(runRoot, 0o755); err != nil {
		return nil, err
	}
	provider, err := StartProvider(Script{Final: final})
	if err != nil {
		return nil, err
	}
	config := DefaultConfig(projectID, filepath.Join(runRoot, "project"), provider.BaseURL)
	configPath := filepath.Join(runRoot, "graph.config.json")
	if err := WriteConfig(configPath, config); err != nil {
		_ = provider.Close()
		return nil, err
	}
	return &Instance{Provider: provider, Config: config, ConfigPath: configPath}, nil
}
