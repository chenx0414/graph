package graph

import (
	"path/filepath"
	"strings"
)

// rsiInstallDesktopApp puts the package this commit built where the reader
// launches it from.
//
// Building proved the package can be built; it did not make the running window
// run it. Measured 2026-11-05: /Applications kept the bundle from 2026-10-20
// while three receipts reported a desktop fix as live, so the reader was asked
// to restart an app that never contained the change. bundleRoot is the tree the
// package was built in - the isolated worktree when the change was verified
// there - because the checkout's own dist/app predates the commit.
func rsiInstallDesktopApp(root, bundleRoot string) RsiAppInstall {
	bundle := filepath.Join(bundleRoot, "dist/app/mac-arm64/Graph.app")
	if bundleRoot == root {
		bundle = filepath.Join(root, "dist/app/mac-arm64/Graph.app")
	}
	run := rsiRunCommand(root, RsiCommand{
		Command: "node",
		Args:    []string{"scripts/install-desktop-app.mjs", "--bundle", bundle},
	}, RSI_BUILD_TIMEOUT_MS)
	if run.Status == "passed" {
		return RsiAppInstall{State: "installed", Note: rsiLastLine(run.Output)}
	}
	reason := rsiLastLine(run.Output)
	if reason == "" {
		reason = "安装脚本没有输出"
	}
	return RsiAppInstall{State: "failed", Note: reason}
}

// rsiLastLine is the one line of a command's output that names its outcome, so a
// receipt can carry the reason without carrying the whole log.
func rsiLastLine(output string) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		if line := strings.TrimSpace(lines[index]); line != "" {
			return line
		}
	}
	return ""
}
