package graph

import (
	"regexp"
	"sync"
	"time"
)

// Pi extension sources.
//
// A Pi extension capability is an npm package, a git checkout or a local
// directory. The Pi SDK's own package manager is not linked here, so the two
// things it did for Graph are done directly: the package is installed with npm
// into the SDK's temporary install root (<agentDir>/tmp/extensions), and the
// package's own `pi.extensions` list names the entry files. The install root,
// the npm arguments and the manifest field are the SDK's own, so a package
// resolved here is the package the SDK would have resolved.

// ResolvedPiExtensionSource is one resolved extension capability source.
type ResolvedPiExtensionSource struct {
	// Extension entry files the SDK resolved, in its own order.
	Entries []string `json:"entries"`
	// Directories the loaded extension needs to read (install root plus each entry's folder).
	ReadRoots []string `json:"readRoots"`
	// The version the resolved package currently has on disk.
	Version *string `json:"version"`
}

// PiExtensionSourceInput is one source-bearing capability.
type PiExtensionSourceInput struct {
	Source   string
	Cwd      string
	AgentDir string
}

// PiExtensionSourceStatus is what a source's registry says about it.
type PiExtensionSourceStatus struct {
	// The version the resolved package currently has on disk.
	Installed *string `json:"installed"`
	// The newest version the declared source resolves to, or null when the source is not npm.
	Latest *string `json:"latest"`
	// Available is true when a newer npm version exists.
	Available bool `json:"available"`
	// InstallGaps are declared entry points missing from this source's install root. A diagnostic
	// only: a published package may declare an entry it never ships, and the root is shared by
	// every temporary npm source. Nothing is ever deleted or rebuilt because of this.
	InstallGaps []string `json:"installGaps"`
}

// PiExtensionUpdate is one source-bearing capability plus what its registry says about it.
type PiExtensionUpdate struct {
	PiExtensionSourceStatus
	Id      string  `json:"id"`
	Version string  `json:"version"`
	Source  string  `json:"source"`
	Error   *string `json:"error,omitempty"`
}

// PiExtensionUpdateResult is the outcome of an install or upgrade.
type PiExtensionUpdateResult struct {
	Updated bool    `json:"updated"`
	Version *string `json:"version"`
}

const (
	piExtensionInstallTimeout = 300 * time.Second
	piExtensionQueryTimeout   = 30 * time.Second
	piExtensionStatusCacheMs  = 60_000
	piExtensionInstallName    = "pi-extensions"
)

// RUNTIME_CONDITIONS are export conditions that name a runtime entry point; anything else is a
// publisher's own dialect.
var piExtensionRuntimeConditions = map[string]bool{
	"node": true, "import": true, "require": true, "default": true, "module": true,
}

var piExtensionDeclarationPattern = regexp.MustCompile(`\.d\.(ts|mts|cts)$`)

// extensionInstalls serializes the daemon's npm mutations by agent directory, not by package
// name, including background refresh.
var extensionInstalls = map[string]*sync.Mutex{}
var extensionInstallsMu sync.Mutex

// piExtensionStatusCache remembers one source's status for a minute.
type piExtensionStatusCacheEntry struct {
	at     int64
	status PiExtensionSourceStatus
}

var piExtensionStatusCache = map[string]piExtensionStatusCacheEntry{}
var piExtensionStatusCacheMu sync.Mutex
