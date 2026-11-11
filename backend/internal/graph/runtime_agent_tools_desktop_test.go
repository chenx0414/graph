package graph

import (
	"path/filepath"
	"testing"
)

func TestDesktopBinaryPrefersTheNativeBinaryOverTheNodeLauncher(t *testing.T) {
	root := t.TempDir()
	candidates := desktopCapabilityBinaries(root)
	want := filepath.Join(root, "agent-desktop", "node_modules", "agent-desktop", "bin", "agent-desktop-"+desktopPlatformSuffix())
	if len(candidates) == 0 || candidates[0] != want {
		t.Fatalf("first desktop candidate %q, want the native binary %q", candidates, want)
	}
}
