package graph

import "path/filepath"


const CodemodeToolName = "codemode"

type CodemodeSettings struct {
	Enabled bool
	TimeoutMs int
	CacheDir string
}

func codemodeSettings(config GraphCodemode, stateDir string) CodemodeSettings {
	settings := CodemodeSettings{Enabled: config.Enabled}
	if stateDir != "" {
		settings.CacheDir = filepath.Join(stateDir, "codemode-cache")
	}
	if config.TimeoutMs != nil {
		settings.TimeoutMs = *config.TimeoutMs
	}
	return settings
}
