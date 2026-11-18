package eval

type supervisorThread struct {
	ConversationID string  `json:"conversationId"`
	TaskID         string  `json:"taskId"`
	Role           string  `json:"role"`
	ProjectID      *string `json:"projectId"`
}

type conversationRow struct {
	ID           string  `json:"id"`
	Role         string  `json:"role"`
	Title        string  `json:"title"`
	AnchorTaskID string  `json:"anchorTaskId"`
	ProjectID    *string `json:"projectId"`
	TaskCount    int     `json:"taskCount"`
}

func threadCases(repository string) []Case {
	return []Case{
		{
			Name:     "thread-global-and-project-are-separate",
			Group:    "thread",
			Layer:    LayerE2E,
			Contract: "POST /api/orchestration/global and /api/projects/{id}/thread open one durable thread each on the same state dir, and the global thread is not reused for the project",
			Run: func(t *T) {
				fixture := StartFixture(t, FixtureOptions{Repository: repository, Files: map[string]string{"README.md": "eval\n"}})
				defer fixture.Close()

				var global supervisorThread
				fixture.Post(t, "global-thread", "/api/orchestration/global", map[string]any{"requestId": "eval-global"}, &global)
				var again supervisorThread
				fixture.Post(t, "global-thread-again", "/api/orchestration/global", map[string]any{"requestId": "eval-global-2"}, &again)
				t.Equal("thread-global.conversationId", global.ConversationID, again.ConversationID)
				t.Equal("thread-global.taskId", global.TaskID, again.TaskID)
				t.Equal("thread-global.role", "global", global.Role)

				var project supervisorThread
				fixture.Post(t, "project-thread", "/api/projects/p/thread", map[string]any{"requestId": "eval-project"}, &project)
				t.Equal("thread-project.role", "project", project.Role)
				if project.ProjectID == nil || *project.ProjectID != "p" {
					t.Fatal("thread-project.projectId", errorText("the project thread must be scoped to p, got "+render(project.ProjectID)))
				}
				t.False("thread-project.distinct-conversation", project.ConversationID == global.ConversationID)
				t.False("thread-project.distinct-task", project.TaskID == global.TaskID)

				var projectAgain supervisorThread
				fixture.Post(t, "project-thread-again", "/api/projects/p/thread", map[string]any{"requestId": "eval-project-2"}, &projectAgain)
				t.Equal("thread-project.idempotent-conversation", project.ConversationID, projectAgain.ConversationID)
				t.Equal("thread-project.idempotent-task", project.TaskID, projectAgain.TaskID)

				var conversations []conversationRow
				fixture.Get(t, "conversation-list", "/api/conversations", &conversations)
				roles := map[string]string{}
				for _, item := range conversations {
					roles[item.ID] = item.Role
				}
				t.Equal("conversation-list.global-role", "global", roles[global.ConversationID])
				t.Equal("conversation-list.project-role", "project", roles[project.ConversationID])
			},
		},
		{
			Name:     "thread-tasks-stay-inside-their-conversation",
			Group:    "thread",
			Layer:    LayerE2E,
			Contract: "POST /api/conversations opens a conversation per request; its task is visible through GET /api/tasks/{id} and stays out of the other conversation's history",
			Run: func(t *T) {
				fixture := StartFixture(t, FixtureOptions{Repository: repository, Files: map[string]string{"README.md": "eval\n"}})
				defer fixture.Close()

				create := func(requestID, title, text string) createdConversation {
					var created createdConversation
					fixture.Post(t, "conversation-create-"+requestID, "/api/conversations", map[string]any{
						"projectId": "p", "title": title, "text": text, "requestId": requestID,
					}, &created)
					return created
				}
				first := create("eval-conv-1", "first", "first conversation message")
				second := create("eval-conv-2", "second", "second conversation message")
				t.NotEmpty("conversation-1.id", []string{first.ConversationID})
				t.NotEmpty("conversation-2.id", []string{second.ConversationID})
				t.False("conversation.distinct-ids", first.ConversationID == second.ConversationID)

				var firstTask map[string]any
				fixture.Get(t, "task-1", "/api/tasks/"+first.TaskID, &firstTask)
				t.NotEmpty("task-1.id", []string{renderString(firstTask["id"])})

				type historyView struct {
					Messages []map[string]any `json:"messages"`
				}
				var firstHistory, secondHistory historyView
				fixture.Get(t, "history-1", "/api/conversations/"+first.ConversationID+"/history", &firstHistory)
				fixture.Get(t, "history-2", "/api/conversations/"+second.ConversationID+"/history", &secondHistory)
				t.Equal("history-1.first-message", "first conversation message", firstMessageText(firstHistory.Messages))
				t.Equal("history-2.first-message", "second conversation message", firstMessageText(secondHistory.Messages))
				for _, message := range firstHistory.Messages {
					t.False("history-1.carries-no-second-message", renderString(message["text"]) == "second conversation message")
				}
				for _, message := range secondHistory.Messages {
					t.False("history-2.carries-no-first-message", renderString(message["text"]) == "first conversation message")
				}
			},
		},
		{
			Name:     "thread-project-thread-needs-a-known-project",
			Group:    "thread",
			Layer:    LayerE2E,
			Contract: "POST /api/projects/{id}/thread refuses an unknown project instead of opening an unscoped thread",
			Run: func(t *T) {
				fixture := StartFixture(t, FixtureOptions{Repository: repository, Files: map[string]string{"README.md": "eval\n"}})
				defer fixture.Close()
				response, err := fixture.Console.Request("POST", "/api/projects/ghost/thread", map[string]any{"requestId": "eval-ghost"})
				if err != nil {
					t.Fatal("project-thread-ghost:request", err)
				}
				t.Equal("project-thread-ghost.status", 400, response.Status)
				t.True("project-thread-ghost.names-the-project", containsText(render(response.Body), "project"))
			},
		},
	}
}
