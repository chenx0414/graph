package pigkernel

import (
	"github.com/MichaelKinsy/PiG/codemode"
	durablecodemode "github.com/MichaelKinsy/PiG/durable/codemode"
	"github.com/MichaelKinsy/PiG/durable"
)

// Code mode is the kernel's own extension.
//
// The daemon tells the kernel whether to offer it and where the sandbox may
// cache its compiled module; everything else - the tool, its description, the
// prompt section that lists the tools a script can call, the sandbox host and
// the durable replay of a half-finished script - belongs to PiG. A second
// implementation in the daemon would drift from the kernel's on the first
// change of either.

// CodemodeOptions enable the kernel's code mode for one session.
type CodemodeOptions struct {
	// CacheDir holds the sandbox module's compiled form.
	CacheDir string
	// TimeoutMs is the default deadline of one script. Zero is the kernel's own.
	TimeoutMs float64
}

// CodemodeExtension builds the kernel's code mode extension for one session.
func CodemodeExtension(options CodemodeOptions) (*durable.Extension, error) {
	sandbox, err := codemode.NewSandbox(codemode.SandboxOptions{
		CacheDir:  options.CacheDir,
		TimeoutMs: options.TimeoutMs,
	})
	if err != nil {
		return nil, err
	}
	// `models.*` globals classify and generate through the model catalog; the
	// daemon's catalog is not the kernel's, so scripts reach tools only.
	models := false
	return durablecodemode.CreateExtension(durablecodemode.ToolOptions{Sandbox: sandbox, Models: &models}), nil
}
