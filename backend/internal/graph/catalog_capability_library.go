package graph

import (
	"regexp"
	"sort"
)

// CapabilityKind is the kind of a capability entry: skill, mcp, extension,
// pi-extension or prompt. It stays an alias of string because the manifest
// parser hands plain strings around.
type CapabilityKind = string

const (
	CapabilityKindSkill       CapabilityKind = "skill"
	CapabilityKindMCP         CapabilityKind = "mcp"
	CapabilityKindExtension   CapabilityKind = "extension"
	CapabilityKindPiExtension CapabilityKind = "pi-extension"
	CapabilityKindPrompt      CapabilityKind = "prompt"
)

// CapabilityOrigin is where a skill entry came from. The order matters: it decides
// which of several entries that share a name the library shows.
//
// A library entry comes first because it is the only one that can be bound, and binding
// mirrors it into the Agent's own folder, which is where the native loader looks first - so
// the bound copy is the one that actually reaches the model. A hand-placed entry in the
// Agent's folder comes next (it wins while nothing is bound), then the global folders and
// finally the project's own folders.
type CapabilityOrigin string

const (
	CapabilityOriginLibrary CapabilityOrigin = "library"
	CapabilityOriginAgent   CapabilityOrigin = "agent"
	CapabilityOriginGlobal  CapabilityOrigin = "global"
	CapabilityOriginProject CapabilityOrigin = "project"
)

// capabilityOriginOrder ranks the origins. The library entry wins, then a hand-placed
// Agent entry, then the global folders, then the project's own folders.
var capabilityOriginOrder = map[CapabilityOrigin]int{
	CapabilityOriginLibrary: 0,
	CapabilityOriginAgent:   1,
	CapabilityOriginGlobal:  2,
	CapabilityOriginProject: 3,
}

// CapabilityDuplicate is a same-name entry the library folded into another one.
type CapabilityDuplicate struct {
	Id      string `json:"id"`
	Version string `json:"version"`
	Source  string `json:"source"`
}

// CapabilityRecord is one entry of the capability library.
type CapabilityRecord struct {
	Id            string                `json:"id"`
	Kind          CapabilityKind        `json:"kind"`
	Source        string                `json:"source"`
	Version       string                `json:"version"`
	Snapshot      Json                  `json:"snapshot"`
	Status        string                `json:"status"`
	Name          string                `json:"name,omitempty"`
	Description   string                `json:"description,omitempty"`
	Role          string                `json:"role,omitempty"`
	Error         string                `json:"error,omitempty"`
	Owner         string                `json:"owner,omitempty"`
	Note          string                `json:"note,omitempty"`
	Origin        CapabilityOrigin      `json:"origin,omitempty"`
	PackageSource *string               `json:"packageSource,omitempty"`
	Base          bool                  `json:"base,omitempty"`
	Duplicates    []CapabilityDuplicate `json:"duplicates,omitempty"`
}

// CapabilitySearchInput filters the capability list.
type CapabilitySearchInput struct {
	Query  string         `json:"query,omitempty"`
	Kind   CapabilityKind `json:"kind,omitempty"`
	Role   string         `json:"role,omitempty"`
	Limit  int            `json:"limit,omitempty"`
	Offset int            `json:"offset,omitempty"`
}

// CapabilitySearchResult is one page of the capability list.
type CapabilitySearchResult struct {
	Total   int                `json:"total"`
	Offset  int                `json:"offset"`
	Limit   int                `json:"limit"`
	HasMore bool               `json:"hasMore"`
	Items   []CapabilityRecord `json:"items"`
}

// CapabilityBundleInput is one capability bundle to install into the capability root.
type CapabilityBundleInput struct {
	Manifest  Json              `json:"manifest"`
	Files     map[string]string `json:"files,omitempty"`
	Overwrite bool              `json:"overwrite,omitempty"`
}

// AgentCombinationSearchInput filters the recipe list.
type AgentCombinationSearchInput struct {
	Query string     `json:"query,omitempty"`
	Limit int        `json:"limit,omitempty"`
}

// AgentCombinationSearchResult is one page of the recipe list.
type AgentCombinationSearchResult struct {
	Total int                    `json:"total"`
	Items []AgentCombinationView `json:"items"`
}

// CapabilityLibraryOptions are the filesystem locations the library reads.
type CapabilityLibraryOptions struct {
	CapabilityRoot string
	RecipesPath    string
	// Projects are the configured projects, read at refresh time, so their own skill
	// folders are listed.
	Projects func() []ProjectConfig
}

// CapabilityLibrarySnapshot is the library view after a refresh.
type CapabilityLibrarySnapshot struct {
	Capabilities      []CapabilityRecord     `json:"capabilities"`
	AgentCombinations []AgentCombinationView `json:"agentCombinations"`
}

// CapabilityBundleResult is an installed capability bundle.
type CapabilityBundleResult struct {
	Capability CapabilityRecord `json:"capability"`
	Directory  string           `json:"directory"`
}

// DeletedAgentCombination reports a removed recipe.
type DeletedAgentCombination struct {
	Id      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

// capabilityBundleDirectories is where each kind of bundle is installed.
var capabilityBundleDirectories = map[CapabilityKind]string{
	CapabilityKindSkill:       "skills",
	CapabilityKindMCP:         "mcp",
	CapabilityKindExtension:   "graph-extensions",
	CapabilityKindPiExtension: "pi-extensions",
	CapabilityKindPrompt:      "agent-md",
}

var (
	capabilityBundlePrefix    = regexp.MustCompile(`^\./+`)
	capabilityBundleHeaderRef = regexp.MustCompile(`^\$\{[A-Za-z_][A-Za-z0-9_]*\}$`)
)

// CapabilitySourceLabel is what the library view calls one entry's source.
func CapabilitySourceLabel(record CapabilityRecord) string {
	if record.Owner != "" {
		return record.Owner
	}
	if record.Origin == "" || record.Origin == CapabilityOriginLibrary {
		return "能力库"
	}
	return string(record.Origin)
}

func capabilityOriginRank(record CapabilityRecord) int {
	if record.Origin == "" {
		return capabilityOriginOrder[CapabilityOriginLibrary]
	}
	return capabilityOriginOrder[record.Origin]
}

// GroupCapabilitiesByName folds same-name skill entries into one row.
//
// One row per skill name: several entries that share a name resolve to a single skill for
// the native loader, so the library shows the one that decides the outcome and lists the
// rest. The origin order picks the entry; within one origin the shortest id wins, then the
// alphabet, so the result never depends on scan order.
func GroupCapabilitiesByName(records []CapabilityRecord) []CapabilityRecord {
	groups := map[string][]CapabilityRecord{}
	order := []string{}
	grouped := []CapabilityRecord{}
	for _, record := range records {
		if record.Kind != CapabilityKindSkill {
			grouped = append(grouped, record)
			continue
		}
		key := record.Name
		if key == "" {
			key = record.Id
		}
		if _, seen := groups[key]; !seen {
			order = append(order, key)
		}
		groups[key] = append(groups[key], record)
	}
	for _, key := range order {
		bucket := groups[key]
		sort.SliceStable(bucket, func(i, j int) bool {
			left, right := bucket[i], bucket[j]
			leftRank, rightRank := capabilityOriginRank(left), capabilityOriginRank(right)
			if leftRank != rightRank {
				return leftRank < rightRank
			}
			if len(left.Id) != len(right.Id) {
				return len(left.Id) < len(right.Id)
			}
			return lessByByteOrder(left.Id, right.Id)
		})
		winner := bucket[0]
		if len(bucket) == 1 {
			grouped = append(grouped, winner)
			continue
		}
		duplicates := make([]CapabilityDuplicate, 0, len(bucket)-1)
		for _, record := range bucket[1:] {
			duplicates = append(duplicates, CapabilityDuplicate{
				Id: record.Id, Version: record.Version, Source: CapabilitySourceLabel(record),
			})
		}
		winner.Duplicates = duplicates
		grouped = append(grouped, winner)
	}
	return grouped
}
