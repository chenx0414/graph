package graph

// What the sediment review is allowed to look at.
//
// The settings say which parts of the conversation count, and the gate
// says whether this run should sediment at all.
import (
	"math"
	"regexp"
	"strings"
)

const (
	sedimentDescriptionLimit = 300
	sedimentBodyLimit        = 24000
	sedimentIDLimit          = 60
	sedimentExistingLimit    = 40
)

var (
	sedimentTrigger = regexp.MustCompile(`(?i)use when|use for|use before|use this when|use this skill when|when the user|when you|何时|当你|适用于`)
	sedimentID      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	sedimentFence   = regexp.MustCompile("```(?:markdown|md)?[ \t]*\r?\n[\\s\\S]*?```")
	sedimentBody    = regexp.MustCompile("```(?:markdown|md)?[ \t]*\r?\n([\\s\\S]*?)\r?\n?```")
	sedimentOwned   = regexp.MustCompile(`(?m)^---[\s\S]*?^created-by:\s*graph-agent\s*$`)
	sedimentDesc    = regexp.MustCompile(`(?m)^description:\s*(.*)$`)
)

// SedimentSettings is the skill-library sedimentation switch.

// SedimentSettings is the skill-library sedimentation switch.

type SedimentSettings struct {
	Enabled        bool    `json:"enabled"`
	AfterToolCalls int     `json:"afterToolCalls"`
	Model          *string `json:"model"`
	BudgetTokens   int     `json:"budgetTokens"`
}

// DEFAULT_SEDIMENT_SETTINGS keeps sedimentation off until a threshold is configured.
var DEFAULT_SEDIMENT_SETTINGS = SedimentSettings{Enabled: false, AfterToolCalls: 10, Model: nil, BudgetTokens: 40_000}

// SedimentSettingsFrom reads a tolerant settings block. A missing block means the feature is off.

func SedimentSettingsFrom(config any) SedimentSettings {
	block := sedimentBlock(config)
	preferred := ""
	if text, ok := block["model"].(string); ok {
		preferred = strings.TrimSpace(text)
	}
	settings := SedimentSettings{
		Enabled:        block["enabled"] == true,
		AfterToolCalls: sedimentPositive(block["afterToolCalls"], DEFAULT_SEDIMENT_SETTINGS.AfterToolCalls),
		BudgetTokens:   sedimentPositive(block["budgetTokens"], DEFAULT_SEDIMENT_SETTINGS.BudgetTokens),
	}
	if preferred != "" {
		settings.Model = &preferred
	}
	return settings
}

func sedimentBlock(config any) map[string]any {
	root, ok := config.(map[string]any)
	if !ok {
		return nil
	}
	skills, ok := root["skills"].(map[string]any)
	if !ok {
		return nil
	}
	block, _ := skills["sedimentation"].(map[string]any)
	return block
}

func sedimentPositive(value any, fallback int) int {
	number, ok := value.(float64)
	if !ok {
		if integer, isInt := value.(int); isInt {
			number = float64(integer)
			ok = true
		} else if integer, isInt := value.(int64); isInt {
			number = float64(integer)
			ok = true
		}
	}
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return fallback
	}
	return int(math.Round(number))
}

// SedimentGate decides whether one operation earned a review.

type SedimentGate struct {
	Enabled         bool
	Role            *string
	ToolCalls       int
	Threshold       int
	Paused          bool
	AlreadyReviewed bool
}

// SedimentProposal is the document a review asked to write.

func sedimentNothing() SedimentOutcome {
	return SedimentOutcome{Nothing: true, Written: []SedimentWritten{}, Refused: []string{}, Proposed: nil}
}

// ShouldSediment reports whether the master's own operation did enough work to review.
