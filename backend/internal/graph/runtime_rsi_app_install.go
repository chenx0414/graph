package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"

	"github.com/chenx0414/graph/backend/internal/appinstall"
)

func rsiInstallDesktopApp(root, bundleRoot string) RsiAppInstall {
	bundle := filepath.Join(bundleRoot, "dist/app/mac-arm64/Graph.app")
	if bundleRoot == root {
		bundle = appinstall.DefaultBundle(root)
	}
	dest := appinstall.DefaultDest()
	message, err := appinstall.Install(appinstall.InstallOptions{Root: root, Bundle: bundle, Dest: dest})
	return rsiAppInstallVerdict(bundle, dest, message, err)
}

// The receipt reports what is on disk, not what the installer said: an install
// that fails after copying, or one that returns an error while the copy landed,
// both end with the same question - does the installed binary equal the built
// one? Measured 2026-11-11: a receipt claimed the app was not updated while the
// bundle had in fact been replaced.
func rsiAppInstallVerdict(bundle, dest, message string, installErr error) RsiAppInstall {
	installed := filepath.Join(dest, "Contents", "MacOS", "Graph")
	built := filepath.Join(bundle, "Contents", "MacOS", "Graph")
	builtDigest, builtErr := digestOfFile(built)
	installedDigest, installedErr := digestOfFile(installed)
	match := builtErr == nil && installedErr == nil && builtDigest == installedDigest
	switch {
	case installErr != nil && !match:
		reason := strings.TrimSpace(installErr.Error())
		if reason == "" {
			reason = "安装失败且没有输出"
		}
		return RsiAppInstall{State: "failed", Note: reason + "; built " + built + ", installed " + installed + " (installer: " + message + ")"}
	case installErr != nil && match:
		return RsiAppInstall{State: "installed", Note: "installed " + installed + " although the installer reported an error: " + strings.TrimSpace(installErr.Error())}
	case !match:
		reason := "the installed binary does not match the built one"
		if installedErr != nil {
			reason = "the installed binary is missing: " + installedErr.Error()
		} else if builtErr != nil {
			reason = "the built binary is missing: " + builtErr.Error()
		}
		return RsiAppInstall{State: "failed", Note: reason + "; built " + built + ", installed " + installed}
	}
	return RsiAppInstall{State: "installed", Note: message + " (" + installed + ", sha256 " + shortDigest(installedDigest) + ")"}
}

// The digest prefix is what a reader can compare against the build they meant
// to ship; the full path alone cannot tell two installs apart.
func shortDigest(digest string) string {
	if len(digest) <= 12 {
		return digest
	}
	return digest[:12]
}

func digestOfFile(path string) (string, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}
