package graph

import (
	"regexp"
	"sync"
	"time"
)

type ResolvedPiExtensionSource struct {
	Entries []string `json:"entries"`
	ReadRoots []string `json:"readRoots"`
	Version *string `json:"version"`
}

type PiExtensionSourceInput struct {
	Source   string
	Cwd      string
	AgentDir string
}

type PiExtensionSourceStatus struct {
	Installed *string `json:"installed"`
	Latest *string `json:"latest"`
	Available bool `json:"available"`
	InstallGaps []string `json:"installGaps"`
}

type PiExtensionUpdate struct {
	PiExtensionSourceStatus
	Id      string  `json:"id"`
	Version string  `json:"version"`
	Source  string  `json:"source"`
	Error   *string `json:"error,omitempty"`
}

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

var piExtensionRuntimeConditions = map[string]bool{
	"node": true, "import": true, "require": true, "default": true, "module": true,
}

var piExtensionDeclarationPattern = regexp.MustCompile(`\.d\.(ts|mts|cts)$`)

var extensionInstalls = map[string]*sync.Mutex{}

var extensionInstallsMu sync.Mutex

type piExtensionStatusCacheEntry struct {
	at     int64
	status PiExtensionSourceStatus
}

var piExtensionStatusCache = map[string]piExtensionStatusCacheEntry{}

var piExtensionStatusCacheMu sync.Mutex
