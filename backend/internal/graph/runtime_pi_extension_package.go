package graph

import (
	"errors"
	"os"
	"path/filepath"
)

func resolvePiExtensionSourceOnce(input PiExtensionSourceInput) (ResolvedPiExtensionSource, error) {
	parsed := parsePiExtensionSource(input.Source)
	baseDir, err := piExtensionInstallPackage(parsed, input)
	if err != nil {
		return ResolvedPiExtensionSource{}, err
	}
	entries, err := piExtensionManifestEntries(baseDir)
	if err != nil {
		return ResolvedPiExtensionSource{}, err
	}
	if len(entries) == 0 {
		Raise("capability_unavailable", "Pi extension source "+input.Source+" resolved no extension entry")
	}
	if err := EnsureRequiredPeers(entries[0]); err != nil {
		return ResolvedPiExtensionSource{}, err
	}
	readRoots := []string{baseDir}
	for _, entry := range entries {
		readRoots = append(readRoots, filepath.Dir(entry))
	}
	if root := piExtensionInstallRootFor(entries[0]); root != "" {
		readRoots = append(readRoots, root)
	}
	version, err := piExtensionPackageVersionAt(entries[0], NpmSourceName(input.Source))
	if err != nil {
		return ResolvedPiExtensionSource{}, err
	}
	return ResolvedPiExtensionSource{
		Entries:   entries,
		ReadRoots: piExtensionUnique(readRoots),
		Version:   version,
	}, nil
}

func piExtensionInstallPackage(parsed piExtensionSource, input PiExtensionSourceInput) (string, error) {
	switch parsed.kind {
	case "npm":
		root := piExtensionNpmInstallRoot(input.AgentDir)
		if err := piExtensionEnsureNpmProject(root); err != nil {
			return "", err
		}
		installed := filepath.Join(root, "node_modules", parsed.name)
		if _, err := os.Stat(installed); err != nil {
			if _, err := piExtensionRunNpm("install", parsed.spec, "--prefix", root, "--legacy-peer-deps"); err != nil {
				return "", err
			}
		}
		return installed, nil
	case "git":
		target := piExtensionGitInstallPath(parsed, input.AgentDir)
		if _, err := os.Stat(target); err != nil {
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return "", err
			}
			if _, err := piExtensionRunCommand("git", []string{"clone", parsed.repo, target}, "", piExtensionInstallTimeout); err != nil {
				return "", err
			}
			if parsed.ref != "" {
				if _, err := piExtensionRunCommand("git", []string{"checkout", parsed.ref}, target, piExtensionInstallTimeout); err != nil {
					return "", err
				}
			}
		}
		return target, nil
	default:
		resolved := piExtensionRealpath(parsed.path)
		if _, err := os.Stat(resolved); err != nil {
			return "", errors.New("Path does not exist: " + parsed.path)
		}
		info, err := os.Stat(resolved)
		if err != nil {
			return "", err
		}
		if !info.IsDir() {
			return filepath.Dir(resolved), nil
		}
		return resolved, nil
	}
}
