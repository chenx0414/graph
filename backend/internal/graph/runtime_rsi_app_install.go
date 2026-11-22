package graph

import (
	"os/exec"
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

// The receipt reports what is on disk, not what the installer said. Installing
// signs the copy, so the installed bytes never equal the built ones: the shared
// identity is the bundle's own identity - its identifier and version - plus a
// signature that verifies.
func rsiAppInstallVerdict(bundle, dest, message string, installErr error) RsiAppInstall {
	installed := filepath.Join(dest, "Contents", "MacOS", "Graph")
	built := filepath.Join(bundle, "Contents", "MacOS", "Graph")
	builtIdentity, builtErr := bundleIdentity(bundle)
	installedIdentity, installedErr := bundleIdentity(dest)
	same := builtErr == nil && installedErr == nil && builtIdentity == installedIdentity
	switch {
	case installErr != nil:
		reason := strings.TrimSpace(installErr.Error())
		if reason == "" {
			reason = "安装失败且没有输出"
		}
		return RsiAppInstall{State: "failed", Note: reason + "; built " + built + " (" + builtIdentity + "), installed " + installed + " (" + installedErrText(installedErr, installedIdentity) + ")"}
	case !same:
		return RsiAppInstall{State: "failed", Note: "the installed app is not the build that was made; built " + built + " (" + builtIdentity + "), installed " + installed + " (" + installedErrText(installedErr, installedIdentity) + ")"}
	}
	note := message + " (" + installed + ", " + installedIdentity
	if signatureErr := verifyBundleSignature(dest); signatureErr != nil {
		note += ", signature NOT verified: " + signatureErr.Error()
	} else {
		note += ", signature verified"
	}
	return RsiAppInstall{State: "installed", Note: note + ")"}
}

func installedErrText(err error, identity string) string {
	if err != nil {
		return err.Error()
	}
	return identity
}

// bundleIdentity is what survives signing and copying: the bundle's identifier
// and version. Two installs of different builds of the same version still look
// alike, so the signature check travels with it.
func bundleIdentity(bundle string) (string, error) {
	info := filepath.Join(bundle, "Contents", "Info.plist")
	values := []string{}
	for _, key := range []string{"CFBundleIdentifier", "CFBundleShortVersionString"} {
		output, err := exec.Command("plutil", "-extract", key, "raw", info).Output()
		if err != nil {
			return "", err
		}
		values = append(values, strings.TrimSpace(string(output)))
	}
	return strings.Join(values, "@"), nil
}

func verifyBundleSignature(bundle string) error {
	codesign, err := exec.LookPath("codesign")
	if err != nil {
		return err
	}
	command := exec.Command(codesign, "--verify", "--strict", bundle)
	if output, runErr := command.CombinedOutput(); runErr != nil {
		return &bundleError{message: strings.TrimSpace(string(output))}
	}
	return nil
}

type bundleError struct{ message string }

func (err *bundleError) Error() string {
	if err.message == "" {
		return "codesign --verify failed"
	}
	return err.message
}
