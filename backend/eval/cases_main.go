package eval

type fleetAgent struct {
	ID             string `json:"id"`
	ParentID       string `json:"parentId"`
	Kind           string `json:"kind"`
	ConversationID string `json:"conversationId"`
	TaskID         string `json:"taskId"`
	Name           string `json:"name"`
}

type fleetView struct {
	Agents []fleetAgent `json:"agents"`
}

func mainCases(repository string) []Case {
	return []Case{
		{
			Name:     "main-spawns-a-child-agent-through-the-tool-surface",
			Group:    "main",
			Layer:    LayerE2E,
			Contract: "spawn_agent on the main conversation creates a durable child agent with its own conversation and task, and the parent is told the receipt",
			Run: func(t *T) {
				fixture := StartFixture(t, FixtureOptions{
					Repository: repository,
					Mode:       "execute",
					Files:      map[string]string{"README.md": "eval\n"},
					Steps: []scriptStep{
						{Tool: "spawn_agent", Arguments: map[string]any{
							"objective": "research the ring topology",
							"name":      "researcher",
							"requestId": "eval-spawn-1",
						}},
					},
				})
				defer fixture.Close()

				var main supervisorThread
				fixture.Post(t, "main-thread", "/api/projects/p/thread", map[string]any{"requestId": "eval-main-thread"}, &main)
				t.NotEmpty("main.conversationId", []string{main.ConversationID})
				t.NotEmpty("main.taskId", []string{main.TaskID})
				fixture.Post(t, "main-thread-message", "/api/conversations/"+main.ConversationID+"/messages", map[string]any{
					"text": "spawn a researcher", "model": "local", "requestId": "eval-main-1",
				}, nil)

				child, settled := awaitChildAgent(t, fixture, main.ConversationID)
				t.True("main.agent-registered", settled)
				if !settled {
					t.Record("main.agent-registered.detail", "an agent appears in /api/fleet", render(fleetSnapshot(fixture, main.ConversationID)))
					return
				}
				t.NotEmpty("child.id", []string{child.ID})
				t.Equal("child.kind", "child", child.Kind)
				t.Equal("child.name", "researcher", child.Name)
				t.False("child.has-own-conversation", child.ConversationID == main.ConversationID)
				t.False("child.has-own-task", child.TaskID == main.TaskID)
				t.NotEmpty("child.taskId", []string{child.TaskID})
				t.True("provider.was-called", fixture.provider != nil && fixture.provider.Requests() > 0)

				var task map[string]any
				fixture.Get(t, "child-task", "/api/tasks/"+child.TaskID, &task)
				t.NotEmpty("child-task.id", []string{renderString(task["id"])})
			},
		},
		{
			Name:     "main-result-is-delivered-back-to-the-parent-conversation",
			Group:    "main",
			Layer:    LayerE2E,
			Contract: "a settled child result is appended to the parent conversation as a message and wakes the parent task",
			Run: func(t *T) {
				fixture := StartFixture(t, FixtureOptions{
					Repository: repository,
					Mode:       "execute",
					Files:      map[string]string{"README.md": "eval\n"},
					Steps: []scriptStep{
						{Tool: "spawn_agent", Arguments: map[string]any{
							"objective": "one child objective",
							"name":      "worker-child",
							"requestId": "eval-spawn-delivery",
						}},
					},
				})
				defer fixture.Close()

				var main supervisorThread
				fixture.Post(t, "main-thread", "/api/projects/p/thread", map[string]any{"requestId": "eval-main-thread"}, &main)
				fixture.Post(t, "main-thread-message", "/api/conversations/"+main.ConversationID+"/messages", map[string]any{
					"text": "spawn a child and report its result", "model": "local", "requestId": "eval-main-thread-message",
				}, nil)

				child, settled := awaitChildAgent(t, fixture, main.ConversationID)
				t.True("child.appears", settled)
				if !settled {
					t.Record("child.appears.detail", "a child agent under the main thread", render(fleetSnapshot(fixture, main.ConversationID)))
					return
				}
				t.Equal("child.kind", "child", child.Kind)
				t.Equal("child.name", "worker-child", child.Name)

				delivered, ok := awaitSettled("parent-wakes", settleTimeout, func() (bool, string) {
					var history struct {
						Messages []map[string]any `json:"messages"`
					}
					fixture.Get(t, "parent-history", "/api/conversations/"+main.ConversationID+"/history", &history)
					for _, message := range history.Messages {
						if renderString(message["kind"]) == "agent_result" || renderString(message["kind"]) == "agent_failure" {
							return true, renderString(message["kind"])
						}
					}
					return false, "the parent has no child result message yet"
				})
				t.True("parent.receives-child-result", ok)
				if !ok {
					t.Record("parent.receives-child-result.detail", "an agent_result or agent_failure message", delivered)
					return
				}
				t.True("parent.receives-a-settled-kind", delivered == "agent_result" || delivered == "agent_failure")
			},
		},
	}
}

func findChildAgent(agents []fleetAgent) (fleetAgent, bool) {
	for _, agent := range agents {
		if agent.Kind == "child" {
			return agent, true
		}
	}
	return fleetAgent{}, false
}

func fleetSnapshot(fixture *Fixture, conversationID string) fleetView {
	var fleet fleetView
	response, err := fixture.Console.Request("GET", "/api/fleet?conversationId="+conversationID, nil)
	if err != nil {
		return fleet
	}
	decode(&T{}, "fleet-snapshot", response.Body, &fleet)
	return fleet
}

func awaitChildAgent(t *T, fixture *Fixture, conversationID string) (fleetAgent, bool) {
	var child fleetAgent
	_, settled := awaitSettled("child-appears", settleTimeout, func() (bool, string) {
		var fleet fleetView
		fixture.Get(t, "fleet", "/api/fleet?conversationId="+conversationID, &fleet)
		found, ok := findChildAgent(fleet.Agents)
		if !ok {
			return false, "no child agent yet"
		}
		child = found
		return true, ""
	})
	return child, settled
}
