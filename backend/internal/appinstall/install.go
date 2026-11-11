package appinstall

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	ExitUsage      = 2
	ExitStale      = 3
	ExitSignFailed = 4
)

type ExitError struct {
	Code    int
	Message string
}

func (err *ExitError) Error() string {
	return err.Message
}

func ExitCode(err error) int {
	var exit *ExitError
	if errors.As(err, &exit) {
		return exit.Code
	}
	return 1
}

type InstallOptions struct {
	Root   string
	Bundle string
	Dest   string
	DryRun bool
}

func DefaultBundle(root string) string {
	return filepath.Join(root, "dist", "app", "mac-arm64", "Graph.app")
}

func DefaultDest() string {
	return "/Applications/Graph.app"
}

func NewestSource(directory string) (string, int64) {
	newestName := ""
	var newest int64
	entries, err := os.ReadDir(directory)
	if err != nil {
		return "", 0
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		if info.ModTime().UnixNano() > newest {
			newest = info.ModTime().UnixNano()
			newestName = entry.Name()
		}
	}
	return newestName, newest
}

func StalePackage(root, bundle string) (string, bool) {
	source := filepath.Join(root, "app")
	binary := filepath.Join(bundle, "Contents", "MacOS", "Graph")
	name, newest := NewestSource(source)
	if name == "" {
		return "", false
	}
	info, err := os.Stat(binary)
	if err != nil {
		return "", false
	}
	if newest > info.ModTime().UnixNano() {
		return name, true
	}
	return "", false
}

func IdentifierMismatch(root, bundle string) (string, string, bool) {
	payload, err := os.ReadFile(filepath.Join(root, "app", "mygo.json"))
	if err != nil {
		return "", "", false
	}
	var config struct {
		Identifier string `json:"identifier"`
	}
	if jsonErr := json.Unmarshal(payload, &config); jsonErr != nil || config.Identifier == "" {
		return "", "", false
	}
	info := filepath.Join(bundle, "Contents", "Info.plist")
	if _, statErr := os.Stat(info); statErr != nil {
		return "", "", false
	}
	output, runErr := exec.Command("plutil", "-extract", "CFBundleIdentifier", "raw", info).Output()
	if runErr != nil {
		return "", "", false
	}
	actual := strings.TrimSpace(string(output))
	if actual == config.Identifier {
		return "", "", false
	}
	return config.Identifier, actual, true
}

func Install(options InstallOptions) (string, error) {
	root := options.Root
	bundle := options.Bundle
	if bundle == "" {
		bundle = DefaultBundle(root)
	}
	dest := options.Dest
	if dest == "" {
		dest = DefaultDest()
	}
	if _, err := os.Stat(bundle); err != nil {
		return "", &ExitError{Code: ExitStale, Message: fmt.Sprintf("no packaged app at %s; run: go -C backend run ./cmd/graphbuild app", bundle)}
	}
	if expected, actual, mismatched := IdentifierMismatch(root, bundle); mismatched {
		return "", &ExitError{Code: ExitStale, Message: fmt.Sprintf("%s is %s and app/mygo.json says %s; installing it would key permissions to another app; run: go -C backend run ./cmd/graphbuild app", bundle, actual, expected)}
	}
	if name, stale := StalePackage(root, bundle); stale {
		return "", &ExitError{Code: ExitStale, Message: fmt.Sprintf("%s does not match %s/app (%s: is newer than the packaged binary). Installing it would run code the commit does not contain; run: go -C backend run ./cmd/graphbuild app", bundle, root, name)}
	}
	if _, err := os.Stat(filepath.Join(bundle, "Contents", "Info.plist")); err != nil {
		return "", &ExitError{Code: ExitSignFailed, Message: fmt.Sprintf("%s is not an application bundle (no Contents/Info.plist); refusing to install it", bundle)}
	}
	if options.DryRun {
		return fmt.Sprintf("would install %s -> %s", bundle, dest), nil
	}
	previous := dest + ".previous"
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	hadPrevious := false
	if _, err := os.Stat(dest); err == nil {
		hadPrevious = true
		_ = os.RemoveAll(previous)
		if renameErr := os.Rename(dest, previous); renameErr != nil {
			return "", renameErr
		}
	}
	installErr := copyTree(bundle, dest)
	if installErr == nil {
		installErr = signInstalled(dest)
	}
	if installErr != nil {
		_ = os.RemoveAll(dest)
		if hadPrevious {
			_ = os.Rename(previous, dest)
		}
		return "", &ExitError{Code: ExitSignFailed, Message: fmt.Sprintf("could not install %s: %v", bundle, installErr)}
	}
	message := fmt.Sprintf("installed %s from %s", dest, bundle)
	if hadPrevious {
		message += fmt.Sprintf("; the replaced copy is at %s", previous)
	}
	return message, nil
}

func signInstalled(dest string) error {
	binary, err := bundleExecutable(dest)
	if err != nil {
		return err
	}
	requirement, err := InstallBundleSigning(dest, binary)
	if err != nil {
		fallback := exec.Command("codesign", "--force", "--sign", "-", dest)
		if output, fallbackErr := fallback.CombinedOutput(); fallbackErr != nil {
			return fmt.Errorf("%v; the ad-hoc fallback failed too: %s", err, strings.TrimSpace(string(output)))
		}
		return nil
	}
	fmt.Printf("signed with %s: %s\n", SigningIdentity, requirement)
	return nil
}

func bundleExecutable(bundle string) (string, error) {
	entries, err := os.ReadDir(filepath.Join(bundle, "Contents", "MacOS"))
	if err != nil {
		return "", err
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	if len(names) != 1 {
		return "", fmt.Errorf("%s carries %d files in Contents/MacOS, so the shell binary is ambiguous", bundle, len(names))
	}
	return filepath.Join(bundle, "Contents", "MacOS", names[0]), nil
}

func copyTree(source, dest string) error {
	if _, err := exec.LookPath("ditto"); err == nil {
		if output, runErr := exec.Command("ditto", source, dest).CombinedOutput(); runErr != nil {
			return fmt.Errorf("ditto: %v: %s", runErr, strings.TrimSpace(string(output)))
		}
		return nil
	}
	return copyTreeWalk(source, dest)
}

func copyTreeWalk(source, dest string) error {
	return filepath.Walk(source, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, relErr := filepath.Rel(source, path)
		if relErr != nil {
			return relErr
		}
		target := filepath.Join(dest, relative)
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			link, linkErr := os.Readlink(path)
			if linkErr != nil {
				return linkErr
			}
			return os.Symlink(link, target)
		case info.IsDir():
			return os.MkdirAll(target, info.Mode().Perm())
		default:
			payload, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			return os.WriteFile(target, payload, info.Mode().Perm())
		}
	})
}
