package eval

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/chenx0414/graph/backend/internal/graph"
)

func openSurfaceGate() graph.SendGate {
	return graph.SendGate{
		Dispatch: func(_ string, _ float64, send func() any) any { return send() },
		Settle:   func(string, *graph.TokenUsage) {},
	}
}

func openSurface(t *T) *graph.WorkspaceCommandRunner {
	workspace := t.TempDirPath()
	return graph.OpenWorkspaceCommandRunner(workspace, filepath.Join(workspace, "scratch"), openSurfaceGate(), nil, 30_000)
}

func sandboxCases() []Case {
	return []Case{
		{
			Name:     "sandbox-runs-a-host-command-through-the-unified-executor",
			Group:    "sandbox",
			Layer:    LayerIntegration,
			Contract: "every agent runs host commands through the one execution surface, which reports the command's exit code and stdout",
			Run: func(t *T) {
				runner := openSurface(t)
				defer runner.Close()
				result := runner.Run("/bin/sh", []string{"-c", "printf 'hello from the surface'; exit 7"}, nil)
				if result.Code == nil {
					t.Fatal("surface.exitCode", os.ErrInvalid)
				}
				t.Equal("surface.exitCode", 7, *result.Code)
				t.Equal("surface.stdout", "hello from the surface", strings.TrimSpace(result.Stdout))
			},
		},
		{
			Name:     "sandbox-lets-an-agent-touch-the-whole-host-filesystem",
			Group:    "sandbox",
			Layer:    LayerIntegration,
			Contract: "the open execution surface grants full access, so a command reads and writes outside its workspace exactly as an unsandboxed process would",
			Run: func(t *T) {
				runner := openSurface(t)
				defer runner.Close()
				outside := filepath.Join(t.TempDirPath(), "outside.txt")
				if err := os.WriteFile(outside, []byte("host file"), 0o600); err != nil {
					t.Fatal("openAccess.fixture", err)
				}
				read := runner.Run("/bin/cat", []string{outside}, nil)
				if read.Code == nil {
					t.Fatal("openAccess.readExitCode", os.ErrInvalid)
				}
				t.Equal("openAccess.readExitCode", 0, *read.Code)
				t.Equal("openAccess.read", "host file", strings.TrimSpace(read.Stdout))

				target := filepath.Join(t.TempDirPath(), "written.txt")
				write := runner.Run("/bin/sh", []string{"-c", "printf written > " + target}, nil)
				if write.Code == nil {
					t.Fatal("openAccess.writeExitCode", os.ErrInvalid)
				}
				t.Equal("openAccess.writeExitCode", 0, *write.Code)
				body, err := os.ReadFile(target)
				t.True("openAccess.writeLanded", err == nil)
				t.Equal("openAccess.write", "written", string(body))
			},
		},
	}
}
