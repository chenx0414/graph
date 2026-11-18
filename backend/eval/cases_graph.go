package eval

import (
	"fmt"
)

const graphDefinition = `{
  "schemaVersion": 2,
  "name": "eval-ring",
  "protocols": {"data": {"type": "object"}},
  "nodes": {
    "planner": {
      "recipe": "matt-team-planner@1",
      "task": "plan the ring",
      "inputs": {"job": {"protocol": "data"}},
      "outputs": {"result": {"protocol": "data"}},
      "submission": {"required": ["result"]}
    },
    "worker": {
      "recipe": "matt-team-worker@1",
      "task": "build the ring",
      "inputs": {"job": {"protocol": "data"}},
      "outputs": {"result": {"protocol": "data"}},
      "submission": {"required": ["result"]}
    }
  },
  "modules": {
    "decision": {
      "type": "router",
      "trigger": "each",
      "inputs": {"job": {"protocol": "data"}},
      "outputs": {"rework": {"protocol": "data"}, "approved": {"protocol": "data"}},
      "rules": [
        {"when": "job.retry == true", "emit": {"rework": {"job": "$job"}}},
        {"when": "job.retry == false", "emit": {"approved": {"job": "$job"}}}
      ]
    }
  },
  "edges": {
    "planned": {"from": "planner.result", "to": "worker.job", "enabled": true},
    "reviewed": {"from": "worker.result", "to": "decision.job", "enabled": true},
    "rework": {"from": "decision.rework", "to": "worker.job", "enabled": true}
  },
  "inputs": {"job": {"to": "planner.job", "protocol": "data"}},
  "outputs": {"result": {"from": "decision.approved", "protocol": "data"}}
}`

const graphDefinitionInvalid = `{
  "schemaVersion": 1,
  "name": "eval-invalid",
  "nodes": {}
}`

type createdGraph struct {
	GraphID    string `json:"graphId"`
	Revision   int    `json:"revision"`
	RequestID  string `json:"requestId"`
	Replayed   bool   `json:"replayed"`
	Definition struct {
		Name  string                    `json:"name"`
		Nodes map[string]map[string]any `json:"nodes"`
		Edges map[string]map[string]any `json:"edges"`
	} `json:"definition"`
}

type graphNodeView struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Status string `json:"status"`
}

type graphTopologyView struct {
	TaskID string `json:"taskId"`
	Nodes  []struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	} `json:"nodes"`
	Edges []struct {
		ID   string `json:"id"`
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"edges"`
}

func graphCases(repository string) []Case {
	return []Case{
		{
			Name:     "graph-create-validate-inspect",
			Group:    "graph",
			Layer:    LayerE2E,
			Contract: "POST /api/graphs admits a schemaVersion 2 definition and GET graph/topology reports every node and enabled edge",
			Run: func(t *T) {
				fixture := StartFixture(t, FixtureOptions{Repository: repository, Files: map[string]string{"README.md": "eval\n"}})
				defer fixture.Close()

				var thread struct {
					ConversationID string `json:"conversationId"`
					TaskID         string `json:"taskId"`
				}
				fixture.Post(t, "global-thread", "/api/orchestration/global", map[string]any{"requestId": "eval-global"}, &thread)
				t.NotEmpty("global-thread.conversationId", []string{thread.ConversationID})
				t.NotEmpty("global-thread.taskId", []string{thread.TaskID})

				var created createdGraph
				fixture.Post(t, "graph-create", "/api/graphs", map[string]any{
					"conversationId": thread.ConversationID,
					"definition":     definitionOf(t, graphDefinition),
					"requestId":      "eval-create",
				}, &created)
				t.NotEmpty("graph-create.graphId", []string{created.GraphID})
				t.Equal("graph-create.revision", 1, created.Revision)
				t.Equal("graph-create.definition.name", "eval-ring", created.Definition.Name)
				t.Equal("graph-create.definition.nodes", []string{"planner", "worker"}, sortedKeys(created.Definition.Nodes))
				t.False("graph-create.replayed", created.Replayed)

				var replay createdGraph
				fixture.Post(t, "graph-create-replay", "/api/graphs", map[string]any{
					"conversationId": thread.ConversationID,
					"definition":     definitionOf(t, graphDefinition),
					"requestId":      "eval-create",
				}, &replay)
				t.Equal("graph-create-replay.graphId", created.GraphID, replay.GraphID)
				t.True("graph-create-replay.replayed", replay.Replayed)

				var view struct {
					Nodes      []graphNodeView  `json:"nodes"`
					Modules    []map[string]any `json:"modules"`
					Interfaces []map[string]any `json:"interfaces"`
				}
				fixture.Get(t, "graph-view", "/api/tasks/"+created.GraphID+"/graph", &view)
				t.Equal("graph-view.nodes", []string{"decision", "planner", "worker"}, sortedIDs(view.Nodes))

				var topology graphTopologyView
				fixture.Get(t, "graph-topology", "/api/tasks/"+created.GraphID+"/graph/topology", &topology)
				t.Equal("graph-topology.taskId", created.GraphID, topology.TaskID)
				t.Equal("graph-topology.nodes", []string{"decision", "planner", "worker"}, sortedTopologyNodes(topology))
				t.Equal("graph-topology.edges", []string{"planned", "reviewed", "rework"}, sortedTopologyEdges(topology))
				for _, edge := range topology.Edges {
					switch edge.ID {
					case "planned":
						t.Equal("graph-topology.planned.from", "planner", edge.From)
						t.Equal("graph-topology.planned.to", "worker", edge.To)
					case "rework":
						t.Equal("graph-topology.rework.from", "decision", edge.From)
						t.Equal("graph-topology.rework.to", "worker", edge.To)
					}
				}
			},
		},
		{
			Name:     "graph-rejects-an-unknown-schema-version",
			Group:    "graph",
			Layer:    LayerE2E,
			Contract: "POST /api/graphs refuses a definition whose schemaVersion is not 2 and names the reason",
			Run: func(t *T) {
				fixture := StartFixture(t, FixtureOptions{Repository: repository, Files: map[string]string{"README.md": "eval\n"}})
				defer fixture.Close()
				var thread struct {
					ConversationID string `json:"conversationId"`
				}
				fixture.Post(t, "global-thread", "/api/orchestration/global", map[string]any{"requestId": "eval-global"}, &thread)
				response, err := fixture.Console.Request("POST", "/api/graphs", map[string]any{
					"conversationId": thread.ConversationID,
					"definition":     definitionOf(t, graphDefinitionInvalid),
					"requestId":      "eval-invalid",
				})
				if err != nil {
					t.Fatal("invalid-create:request", err)
				}
				t.Equal("invalid-create.status", 400, response.Status)
				text := fmt.Sprint(response.Body)
				t.True("invalid-create.names-schema-version", containsText(text, "schemaVersion"))
			},
		},
		{
			Name:     "graph-control-pauses-and-resumes",
			Group:    "graph",
			Layer:    LayerE2E,
			Contract: "POST /api/tasks/{id}/graph/control pause/resume flips the persisted graph phase without touching the definition",
			Run: func(t *T) {
				fixture := StartFixture(t, FixtureOptions{Repository: repository, Files: map[string]string{"README.md": "eval\n"}})
				defer fixture.Close()
				var thread struct {
					ConversationID string `json:"conversationId"`
				}
				fixture.Post(t, "global-thread", "/api/orchestration/global", map[string]any{"requestId": "eval-global"}, &thread)
				var created createdGraph
				fixture.Post(t, "graph-create", "/api/graphs", map[string]any{
					"conversationId": thread.ConversationID,
					"definition":     definitionOf(t, graphDefinition),
					"requestId":      "eval-control",
				}, &created)

				stateAfter := func(action, requestID string) string {
					var control map[string]any
					fixture.Post(t, "graph-control-"+action, "/api/tasks/"+created.GraphID+"/graph/control", map[string]any{
						"action": action, "requestId": requestID,
					}, &control)
					return graphPhaseOf(control)
				}
				baseline := stateAfter("resume", "eval-baseline")
				t.Equal("graph-control.paused", "paused", stateAfter("pause", "eval-pause"))
				t.Equal("graph-control.round-trips", baseline, stateAfter("resume", "eval-resume"))

				var view struct {
					Nodes []graphNodeView `json:"nodes"`
				}
				fixture.Get(t, "graph-view-after-control", "/api/tasks/"+created.GraphID+"/graph", &view)
				t.Equal("graph-control.keeps-nodes", []string{"decision", "planner", "worker"}, sortedIDs(view.Nodes))
			},
		},
	}
}
