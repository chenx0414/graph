package pigkernel

import (
	"github.com/MichaelKinsy/PiG/codemode"
	durablecodemode "github.com/MichaelKinsy/PiG/durable/codemode"
	"github.com/MichaelKinsy/PiG/durable"
)


type CodemodeOptions struct {
	CacheDir string
	TimeoutMs float64
}

func CodemodeExtension(options CodemodeOptions) (*durable.Extension, error) {
	sandbox, err := codemode.NewSandbox(codemode.SandboxOptions{
		CacheDir:  options.CacheDir,
		TimeoutMs: options.TimeoutMs,
	})
	if err != nil {
		return nil, err
	}
	models := false
	return durablecodemode.CreateExtension(durablecodemode.ToolOptions{Sandbox: sandbox, Models: &models}), nil
}
