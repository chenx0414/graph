package graph

import (
	"regexp"
	"sort"
)

type CapabilityKind = string

const (
	CapabilityKindSkill       CapabilityKind = "skill"
	CapabilityKindMCP         CapabilityKind = "mcp"
	CapabilityKindPiExtension CapabilityKind = "pi-extension"
	CapabilityKindPrompt      CapabilityKind = "prompt"
)

type CapabilityOrigin string

const (
	CapabilityOriginLibrary CapabilityOrigin = "library"
	CapabilityOriginAgent   CapabilityOrigin = "agent"
	CapabilityOriginGlobal  CapabilityOrigin = "global"
	CapabilityOriginProject CapabilityOrigin = "project"
)

var capabilityOriginOrder = map[CapabilityOrigin]int{
	CapabilityOriginLibrary: 0,
	CapabilityOriginAgent:   1,
	CapabilityOriginGlobal:  2,
	CapabilityOriginProject: 3,
}

type CapabilityDuplicate struct {
	Id      string `json:"id"`
	Version string `json:"version"`
	Source  string `json:"source"`
}

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

type CapabilitySearchInput struct {
	Query  string         `json:"query,omitempty"`
	Kind   CapabilityKind `json:"kind,omitempty"`
	Role   string         `json:"role,omitempty"`
	Limit  int            `json:"limit,omitempty"`
	Offset int            `json:"offset,omitempty"`
}

type CapabilitySearchResult struct {
	Total   int                `json:"total"`
	Offset  int                `json:"offset"`
	Limit   int                `json:"limit"`
	HasMore bool               `json:"hasMore"`
	Items   []CapabilityRecord `json:"items"`
}

type CapabilityBundleInput struct {
	Manifest  Json              `json:"manifest"`
	Files     map[string]string `json:"files,omitempty"`
	Overwrite bool              `json:"overwrite,omitempty"`
}

type AgentCombinationSearchInput struct {
	Query string     `json:"query,omitempty"`
	Limit int        `json:"limit,omitempty"`
}

type AgentCombinationSearchResult struct {
	Total int                    `json:"total"`
	Items []AgentCombinationView `json:"items"`
}

type CapabilityLibraryOptions struct {
	CapabilityRoot string
	RecipesPath    string
	Projects func() []ProjectConfig
}

type CapabilityLibrarySnapshot struct {
	Capabilities      []CapabilityRecord     `json:"capabilities"`
	AgentCombinations []AgentCombinationView `json:"agentCombinations"`
}

type CapabilityBundleResult struct {
	Capability CapabilityRecord `json:"capability"`
	Directory  string           `json:"directory"`
}

type DeletedAgentCombination struct {
	Id      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

var capabilityBundleDirectories = map[CapabilityKind]string{
	CapabilityKindSkill:       "skills",
	CapabilityKindMCP:         "mcp",
	CapabilityKindPiExtension: "pi-extensions",
	CapabilityKindPrompt:      "agent-md",
}

var (
	capabilityBundlePrefix    = regexp.MustCompile(`^\./+`)
	capabilityBundleHeaderRef = regexp.MustCompile(`^\$\{[A-Za-z_][A-Za-z0-9_]*\}$`)
)

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
