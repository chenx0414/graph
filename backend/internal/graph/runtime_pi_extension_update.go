package graph

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"context"
)

func ResolvePiExtensionSourceStatus(input PiExtensionSourceInput) (PiExtensionSourceStatus, error) {
	piExtensionStatusCacheMu.Lock()
	cached, found := piExtensionStatusCache[input.Source]
	piExtensionStatusCacheMu.Unlock()
	if found && NowMillis()-cached.at < piExtensionStatusCacheMs {
		return cached.status, nil
	}
	resolved, err := ResolvePiExtensionSource(input)
	if err != nil {
		return PiExtensionSourceStatus{}, err
	}
	if len(resolved.Entries) == 0 {
		return PiExtensionSourceStatus{}, errors.New("Pi extension source resolved no extension entry")
	}
	name := NpmSourceName(input.Source)
	installed, err := piExtensionPackageVersionAt(resolved.Entries[0], name)
	if err != nil {
		return PiExtensionSourceStatus{}, err
	}
	var latest *string
	if name != nil {
		latest = piExtensionNpmLatest(strings.TrimSpace(strings.TrimPrefix(input.Source, "npm:")), input.Cwd)
	}
	installGaps := []string{}
	if root := piExtensionInstallRootFor(resolved.Entries[0]); root != "" {
		if gaps, gapErr := InstallRootGaps(root); gapErr == nil {
			installGaps = gaps
		}
	}
	status := PiExtensionSourceStatus{
		Installed:   installed,
		Latest:      latest,
		Available:   name != nil && installed != nil && latest != nil && *installed != *latest,
		InstallGaps: installGaps,
	}
	piExtensionStatusCacheMu.Lock()
	piExtensionStatusCache[input.Source] = piExtensionStatusCacheEntry{at: NowMillis(), status: status}
	piExtensionStatusCacheMu.Unlock()
	return status, nil
}

func UpdatePiExtensionSource(input PiExtensionSourceInput) (PiExtensionUpdateResult, error) {
	return withExtensionInstall(input.AgentDir, func() (PiExtensionUpdateResult, error) {
		resolved, err := resolvePiExtensionSourceOnce(input)
		if err != nil {
			return PiExtensionUpdateResult{}, err
		}
		if len(resolved.Entries) == 0 {
			return PiExtensionUpdateResult{}, errors.New("Pi extension source resolved no extension entry")
		}
		entry := resolved.Entries[0]
		root := piExtensionInstallRootOf(entry)
		if root == "" {
			Raise("capability_unavailable", "Pi extension source "+input.Source+" has no npm install root to update")
		}
		spec := strings.TrimSpace(strings.TrimPrefix(input.Source, "npm:"))
		name := NpmSourceName(input.Source)
		target := spec + "@latest"
		if name != nil && len(spec) > len(*name) {
			target = spec
		}
		if _, err := piExtensionRunNpm("install", target, "--cwd", root); err != nil {
			return PiExtensionUpdateResult{}, err
		}
		piExtensionStatusCacheMu.Lock()
		delete(piExtensionStatusCache, input.Source)
		piExtensionStatusCacheMu.Unlock()
		version, err := piExtensionPackageVersionAt(entry, name)
		if err != nil {
			return PiExtensionUpdateResult{}, err
		}
		return PiExtensionUpdateResult{Updated: true, Version: version}, nil
	})
}

func piExtensionRunNpm(name string, args ...string) (string, error) {
	return piExtensionRunCommand("npm", args, "", piExtensionInstallTimeout)
}

func piExtensionRunCommand(name string, args []string, cwd string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = cwd
	command.Env = os.Environ()
	stdout, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("%s %s failed: %w", name, strings.Join(args, " "), err)
	}
	return string(stdout), nil
}
