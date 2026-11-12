package graph

import (
	"strings"
	"testing"
)

func TestGraphConfigDefaultsExecutionLimitsTo1024And4(t *testing.T) {
	config := ParseGraphConfig(map[string]any{"version": float64(1)}, "graph.config.json")
	if config.Limits.AgentExecutions != DefaultAgentExecutions {
		t.Fatalf("agentExecutions defaults to %d, got %d", DefaultAgentExecutions, config.Limits.AgentExecutions)
	}
	if config.Limits.ProgramExecutions != DefaultProgramExecutions {
		t.Fatalf("programExecutions defaults to %d, got %d", DefaultProgramExecutions, config.Limits.ProgramExecutions)
	}
	if config.Limits.AgentExecutions != 1024 {
		t.Fatalf("the documented agent default is 1024, got %d", config.Limits.AgentExecutions)
	}
	if config.Limits.ProgramExecutions != 4 {
		t.Fatalf("the documented program default is 4, got %d", config.Limits.ProgramExecutions)
	}
	empty := EmptyGraphConfig()
	if empty.Limits.AgentExecutions != 1024 {
		t.Fatalf("an empty config carries the agent default, got %d", empty.Limits.AgentExecutions)
	}
	if empty.Limits.ProgramExecutions != 4 {
		t.Fatalf("an empty config carries the program default, got %d", empty.Limits.ProgramExecutions)
	}
}

func TestGraphConfigReadsExplicitExecutionLimits(t *testing.T) {
	config := ParseGraphConfig(map[string]any{
		"version": float64(1),
		"limits":  map[string]any{"agentExecutions": float64(2048), "programExecutions": float64(8)},
	}, "graph.config.json")
	if config.Limits.AgentExecutions != 2048 {
		t.Fatalf("agentExecutions reads 2048, got %d", config.Limits.AgentExecutions)
	}
	if config.Limits.ProgramExecutions != 8 {
		t.Fatalf("programExecutions reads 8, got %d", config.Limits.ProgramExecutions)
	}
}

func TestGraphConfigKeepsCredentialLimitsAlongsideExecutionLimits(t *testing.T) {
	config := ParseGraphConfig(map[string]any{
		"version":     float64(1),
		"credentials": map[string]any{"opencode-go": map[string]any{"secretRef": "OPENCODE_GO_API_KEY"}},
		"limits": map[string]any{
			"credentials":       map[string]any{"opencode-go": float64(2)},
			"agentExecutions":   float64(300),
			"programExecutions": float64(5),
		},
	}, "graph.config.json")
	if config.Limits.Credentials["opencode-go"] != 2 {
		t.Fatalf("credential limits keep working, got %d", config.Limits.Credentials["opencode-go"])
	}
	if config.Limits.AgentExecutions != 300 || config.Limits.ProgramExecutions != 5 {
		t.Fatalf("execution limits read 300/5, got %d/%d", config.Limits.AgentExecutions, config.Limits.ProgramExecutions)
	}
}

func TestGraphConfigRejectsInvalidExecutionLimits(t *testing.T) {
	cases := []struct {
		key   string
		value any
		text  string
	}{
		{"agentExecutions", float64(0), "0"},
		{"agentExecutions", float64(-1), "-1"},
		{"agentExecutions", float64(2.5), "2.5"},
		{"programExecutions", "4", `"4"`},
		{"programExecutions", true, "true"},
	}
	for _, testCase := range cases {
		func() {
			defer func() {
				recovered := recover()
				failure, ok := recovered.(*RuntimeError)
				if !ok {
					t.Fatalf("limits.%s=%v must fail startup with invalid_config, recovered %v", testCase.key, testCase.value, recovered)
				}
				if failure.Code != "invalid_config" {
					t.Fatalf("limits.%s=%v reports invalid_config, got %q", testCase.key, testCase.value, failure.Code)
				}
				if !strings.Contains(failure.Message, "limits."+testCase.key) {
					t.Fatalf("the failure names the configured key, got %q", failure.Message)
				}
				if !strings.Contains(failure.Message, testCase.text) {
					t.Fatalf("the failure names the configured value %s, got %q", testCase.text, failure.Message)
				}
			}()
			ParseGraphConfig(map[string]any{
				"version": float64(1),
				"limits":  map[string]any{testCase.key: testCase.value},
			}, "graph.config.json")
		}()
	}
}

func TestGraphConfigReadsSpawnLimits(t *testing.T) {
	config := ParseGraphConfig(map[string]any{
		"version": float64(1),
		"limits":  map[string]any{"maxAgents": float64(32), "spawnDepth": float64(3), "childrenPerAgent": float64(4)},
	}, "graph.config.json")
	if config.Limits.MaxAgents != 32 || config.Limits.SpawnDepth != 3 || config.Limits.ChildrenPerAgent != 4 {
		t.Fatalf("spawn limits = %+v", config.Limits)
	}
	empty := EmptyGraphConfig()
	if empty.Limits.MaxAgents != 1024 || empty.Limits.SpawnDepth != 4 || empty.Limits.ChildrenPerAgent != 16 {
		t.Fatalf("spawn defaults = %+v", empty.Limits)
	}
}

func TestGraphConfigRejectsInvalidSpawnLimits(t *testing.T) {
	for _, key := range []string{"maxAgents", "spawnDepth", "childrenPerAgent"} {
		func() {
			defer func() {
				recovered := recover()
				failure, ok := recovered.(*RuntimeError)
				if !ok || failure.Code != "invalid_config" || !strings.Contains(failure.Message, "limits."+key) {
					t.Fatalf("limits.%s must report invalid_config with its key, recovered %v", key, recovered)
				}
			}()
			ParseGraphConfig(map[string]any{"version": float64(1), "limits": map[string]any{key: float64(0)}}, "graph.config.json")
		}()
	}
}
