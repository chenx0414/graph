package graph

import (
	"path/filepath"
	"strings"

	"github.com/chenx0414/graph/backend/internal/appinstall"
)

func rsiInstallDesktopApp(root, bundleRoot string) RsiAppInstall {
	bundle := filepath.Join(bundleRoot, "dist/app/mac-arm64/Graph.app")
	if bundleRoot == root {
		bundle = appinstall.DefaultBundle(root)
	}
	message, err := appinstall.Install(appinstall.InstallOptions{Root: root, Bundle: bundle, Dest: appinstall.DefaultDest()})
	if err == nil {
		return RsiAppInstall{State: "installed", Note: message}
	}
	reason := err.Error()
	if strings.TrimSpace(reason) == "" {
		reason = "安装失败且没有输出"
	}
	return RsiAppInstall{State: "failed", Note: reason}
}
