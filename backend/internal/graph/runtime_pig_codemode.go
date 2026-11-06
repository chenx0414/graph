package graph

import "path/filepath"

// Code mode is the kernel's own extension: PiG owns the tool, its description,
// the sandbox and the prompt section that lists the tools a script can call.
// The daemon only decides whether to offer it and where the sandbox may cache
// its compiled module, so this file is the whole crossing.

// CodemodeToolName is the name the kernel offers code mode under. The
// transcript reads it to give the row its own label.
const CodemodeToolName = "codemode"

// CodemodeSettings are the daemon's codemode decision for one session.
type CodemodeSettings struct {
	// Enabled offers the kernel's code mode. It is on unless the configuration
	// turns it off.
	Enabled bool
	// TimeoutMs is the default deadline of one script, in milliseconds. Zero
	// is the kernel's own default.
	TimeoutMs int
	// CacheDir holds the sandbox module's on-disk compilation cache.
	CacheDir string
}

// codemodeSettings read the session's code mode settings.
//
// The sandbox's compilation cache lives under the state directory: the module
// is compiled once, so the first script of a later run starts in moments
// rather than hundreds of them.
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
