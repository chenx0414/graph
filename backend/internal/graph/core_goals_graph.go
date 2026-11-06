package graph

import (
	"errors"
	"strings"
)

// A goal is a graph, not a conversation loop.
//
// The goal used to run inside the chat: the model worked, an independent acceptance
// turn judged its claim, and both talked over the same transcript. That works, but the
// person reads two voices doing the same subject in one window, and the work itself is
// the one thing a graph already does well: plan, implement, review on two axes, rework
// on failure. So a goal now creates that graph and the conversation keeps only the
// objective, the criteria and the state.
//
// The shape is not invented here: AssembleMattTeam already compiles
// planner -> worker -> standards + spec reviewers with rework back to the worker, and
// its reviewers are independent by construction. A goal graph is that team, with the
// objective as its task and the person's acceptance criteria as its specification.

// GoalGraphError explains why a goal could not become a graph. The goal stays in the
// conversation when this happens: a goal that cannot run as a graph still runs, and the
// person is told what is missing instead of finding an empty graph.
type GoalGraphError struct {
	Reason string
}

func (failure GoalGraphError) Error() string { return failure.Reason }

// StartGoalGraph creates the graph that runs one goal, and records its id on the goal.
func (runtime *TaskRuntime) StartGoalGraph(conversationID string, goal ConversationGoal, projectID string) (ConversationGoal, error) {
	conversation := ConversationRowOf(runtime.store, conversationID)
	ownerTask, resolved, err := runtime.goalGraphOwner(conversation, projectID)
	if err != nil {
		return goal, err
	}
	if runtime.catalog == nil {
		return goal, GoalGraphError{Reason: "能力目录尚未就绪，目标暂时按会话执行"}
	}
	// The assembly raises (panics) when a bound skill is missing: that is a reason a
	// goal cannot run as a graph yet, not a reason the command fails. Same for the graph
	// create below - the goal falls back to the conversation and says why.
	var definition GraphDefinition
	var createErr error
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				createErr = GoalGraphError{Reason: goalGraphRaisedText(recovered)}
			}
		}()
		definition = AssembleMattTeam(mattTeamCatalogAdapter{catalog: runtime.catalog}, MattTeamOptions{
		Name:   goalGraphName(goal.Objective),
		Task:   goal.Objective,
		Spec:   goalAcceptance(goal),
		Ticket: runtime.goalGraphTicket(resolved),
		BaseRef: runtime.goalGraphBaseRef(resolved),
		})
	}()
	if createErr != nil {
		return goal, createErr
	}
	created := runtime.graphManagement(ownerTask).GraphCreate(map[string]any{
		"definition": definition,
		// One goal, one graph: a retried command must not build a second graph for the
		// same objective.
		"requestId": "goal-graph:" + conversationID + ":" + itoa(int(goal.CreatedAt)),
	})
	graphID := ""
	switch value := created.(type) {
	case GraphCreateResult:
		graphID = value.GraphId
	case GraphCreateBlocked:
		graphID = value.GraphId
	}
	if graphID == "" {
		return goal, GoalGraphError{Reason: "建图没有返回图 id"}
	}
	goal.GraphId = graphID
	goal.GraphOwnerTask = ownerTask
	goal.Status = GoalActive
	saved := runtime.store.PutGoalForced(goal, NowMillis())
	runtime.store.Event(ownerTask, "goal.graph_created", map[string]any{
		"conversationId": conversationID, "graphId": graphID, "projectId": resolved,
	})
	return saved, nil
}

// goalGraphOwner decides which task owns the goal's graph.
//
// A conversation that already has a project owns its own graph. The main Agent's
// conversation has none, so the graph is owned by the project supervisor of whichever
// project runs the goal: the one the goal named, or the only configured project. That
// is a decision, not a guess - a graph needs a project, and the conversation that asked
// for the work does not have one.
func (runtime *TaskRuntime) goalGraphOwner(conversation ConversationRow, projectID string) (string, string, error) {
	if conversation.ProjectId != nil && *conversation.ProjectId != "" {
		return conversation.AnchorTaskId, *conversation.ProjectId, nil
	}
	chosen := strings.TrimSpace(projectID)
	if chosen == "" {
		configured := runtime.configuredProjects()
		if len(configured) == 1 {
			chosen = configured[0].Id
		}
	}
	if chosen == "" {
		return "", "", GoalGraphError{Reason: "没有指定项目，也没有唯一的已配置项目可以承载这个目标"}
	}
	if !runtime.allowedProjects()[chosen] {
		return "", "", GoalGraphError{Reason: "项目 " + chosen + " 未配置或不可用"}
	}
	thread := runtime.ensureSupervisorThread(&chosen, "goal-graph:"+chosen)
	return thread.TaskID, chosen, nil
}

// goalGraphTicket numbers the goal graph inside its project. The reviewers and the
// worker read it as the ticket a plan belongs to; a goal has no issue tracker, so the
// number only has to be stable and unique per project.
func (runtime *TaskRuntime) goalGraphTicket(projectID string) int {
	row := kernelRow(runtime.store.Db, `SELECT COUNT(*) AS count FROM conversation_goals WHERE graph_id != '' AND conversation_id IN
        (SELECT id FROM conversations WHERE project_id=?)`, projectID)
	return int(kernelInt(row["count"])) + 1
}

// goalGraphBaseRef is the fixed base the reviewers compare the work against: the
// project's branch when it names one, otherwise the integration sha, otherwise HEAD.
func (runtime *TaskRuntime) goalGraphBaseRef(projectID string) string {
	if row := kernelRow(runtime.store.Db, `SELECT integration_sha AS sha, target_branch AS branch FROM tasks
        WHERE project_id=? ORDER BY created_seq DESC LIMIT 1`, projectID); row != nil {
		if sha := strings.TrimSpace(kernelString(row["sha"])); sha != "" {
			return sha
		}
		if branch := strings.TrimSpace(kernelString(row["branch"])); branch != "" {
			return branch
		}
	}
	return "HEAD"
}

// goalAcceptance is the specification the goal's reviewers check the work against. A
// goal without criteria still gets a graph: the objective itself is what "done" means
// when the person did not say more.
func goalAcceptance(goal ConversationGoal) string {
	if criteria := strings.TrimSpace(goal.Acceptance); criteria != "" {
		return criteria
	}
	return "目标完成，且目标里描述的每一项行为都已实现并可验证：" + goal.Objective
}

// goalGraphName is the graph's title: short enough to read in a tab, and still the
// goal rather than a generic "Goal".
func goalGraphName(objective string) string {
	name := strings.TrimSpace(objective)
	if len(name) > 60 {
		name = name[:60] + "…"
	}
	return "目标：" + name
}

// syncGoalFromGraph moves a goal's status with its graph, so the conversation row is
// never stale about work that already finished.
func syncGoalFromGraph(store *TaskStore, goal *ConversationGoal) {
	if goal == nil || strings.TrimSpace(goal.GraphId) == "" {
		return
	}
	row := kernelRow(store.Db, `SELECT phase AS phase, paused AS paused FROM tasks WHERE id=?`, goal.GraphId)
	if row == nil {
		return
	}
	if kernelInt(row["paused"]) != 0 && goal.Status == GoalActive {
		return
	}
	phase := kernelString(row["phase"])
	switch phase {
	case "completed":
		if goal.Status != GoalCompleted {
			goal.Status = GoalCompleted
			goal.CheckNote = "图的独立审查通过，目标收口"
			store.PutGoalForced(*goal, NowMillis())
		}
	case "blocked":
		// A blocked graph is not a failed goal: it waits for a decision. Saying it is
		// blocked keeps the person's next action obvious without pretending it stopped.
		if goal.CheckNote != "图被阻塞，等待裁决" {
			goal.CheckNote = "图被阻塞，等待裁决"
			store.PutGoalForced(*goal, NowMillis())
		}
	}
}

// goalGraphRequired is the error text a caller shows when a goal cannot become a graph.
func goalGraphRequired(err error) string {
	var missing GoalGraphError
	if errors.As(err, &missing) {
		return missing.Reason
	}
	return err.Error()
}

// mattTeamCatalogAdapter bridges the catalog's optional version argument to the one
// signature the team assembly declares.
type mattTeamCatalogAdapter struct {
	catalog *Catalog
}

func (adapter mattTeamCatalogAdapter) Capability(id string, version string) *CapabilityRecord {
	return adapter.catalog.Capability(id, version)
}

func (adapter mattTeamCatalogAdapter) SaveAgentCombination(combination AgentCombination) SavedAgentCombination {
	return adapter.catalog.SaveAgentCombination(combination)
}

// shortGraphId is the first eight characters of a graph id: enough to recognize the
// graph in a line of text, short enough to read.
func shortGraphId(graphId string) string {
	if len(graphId) <= 8 {
		return graphId
	}
	return graphId[:8]
}

// goalGraphRaisedText turns a raised value into the sentence the goal line carries.
func goalGraphRaisedText(recovered any) string {
	if _, _, message, _ := PublicError(recovered); strings.TrimSpace(message) != "" {
		return message
	}
	if text, ok := recovered.(error); ok {
		return text.Error()
	}
	return "建图失败"
}
