package graph

import (
	"path/filepath"
	"strings"
)

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

func rsiLastLine(output string) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		if line := strings.TrimSpace(lines[index]); line != "" {
			return line
		}
	}
	return ""
}
