package graph

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// ResolvePiExtensionSourceStatus reports whether a source has a newer version than the one on
// disk. The Pi SDK's own `checkForAvailableUpdates()` only inspects packages configured in its
// settings, and a capability source is resolved in temporary scope, so Graph asks npm itself.
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
		// Best effort on purpose: a diagnostic that throws would turn "we could not look" into "the
		// extension is broken".
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

// UpdatePiExtensionSource installs or upgrades a source the way `pi` itself does it: an explicit
// version reinstalls that spec, an open range or a bare name moves to the newest one.
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

// piExtensionRunNpm runs npm with the Graph environment.
func piExtensionRunNpm(name string, args ...string) (string, error) {
	return piExtensionRunCommand("npm", args, "", piExtensionInstallTimeout)
}

// piExtensionRunCommand runs one helper command and returns its stdout.
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
