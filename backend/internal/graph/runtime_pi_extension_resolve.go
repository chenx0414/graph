package graph

import (
	"strings"
)

// ResolvePiExtensionSource resolves one Pi extension capability source exactly the way the Pi SDK
// does it: `npm:<spec>`, a git URL, or a local path. The package is installed (temporary scope,
// under `<agentDir>/tmp/extensions`) and the package's own `pi.extensions` list is read, so Graph
// neither vendors a copy nor hand-writes the entry file.
func ResolvePiExtensionSource(input PiExtensionSourceInput) (ResolvedPiExtensionSource, error) {
	return withExtensionInstall(input.AgentDir, func() (ResolvedPiExtensionSource, error) {
		return resolvePiExtensionSourceOnce(input)
	})
}

// piExtensionSource is a parsed source string.
type piExtensionSource struct {
	kind    string // "npm", "git" or "local"
	spec    string
	name    string
	version string
	repo    string
	ref     string
	host    string
	path    string
}

// parsePiExtensionSource mirrors the SDK's parseSource.
func parsePiExtensionSource(source string) piExtensionSource {
	trimmed := strings.TrimSpace(source)
	if strings.HasPrefix(trimmed, "npm:") {
		spec := strings.TrimSpace(strings.TrimPrefix(trimmed, "npm:"))
		name, version := parseNpmSpec(spec)
		return piExtensionSource{kind: "npm", spec: spec, name: name, version: version}
	}
	if git, ok := parseGitSource(trimmed); ok {
		return git
	}
	return piExtensionSource{kind: "local", path: trimmed}
}

// parseNpmSpec mirrors the SDK's parseNpmSpec: `name` or `name@version`.
func parseNpmSpec(spec string) (string, string) {
	at := strings.LastIndex(spec, "@")
	if at <= 0 {
		return spec, ""
	}
	return spec[:at], spec[at+1:]
}

// parseGitSource recognises the git URL shapes the SDK recognises.
func parseGitSource(source string) (piExtensionSource, bool) {
	if source == "" {
		return piExtensionSource{}, false
	}
	if strings.HasPrefix(source, "git+") {
		source = strings.TrimPrefix(source, "git+")
	}
	if strings.HasPrefix(source, "git@") {
		host := "github.com"
		rest := strings.TrimPrefix(source, "git@")
		if index := strings.Index(rest, ":"); index > 0 {
			host = rest[:index]
			rest = rest[index+1:]
		}
		return piExtensionSource{kind: "git", repo: "https://" + host + "/" + rest, host: host, path: rest}, true
	}
	for _, prefix := range []string{"https://", "http://", "ssh://", "git://"} {
		if !strings.HasPrefix(source, prefix) {
			continue
		}
		rest := strings.TrimPrefix(source, prefix)
		host := ""
		repo := rest
		if index := strings.Index(rest, "/"); index > 0 {
			host = rest[:index]
			repo = rest[index+1:]
		}
		if !strings.HasSuffix(repo, ".git") {
			continue
		}
		ref := ""
		if index := strings.Index(repo, "#"); index >= 0 {
			ref = repo[index+1:]
			repo = repo[:index]
		}
		return piExtensionSource{kind: "git", repo: source, host: host, path: repo, ref: ref}, true
	}
	return piExtensionSource{}, false
}
