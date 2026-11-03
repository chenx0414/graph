package graph

// masterPromptSuffix is what the adapter appends to a master turn's prompt on
// top of the shared agent context: the standing goal of the conversation and,
// for supervisor threads, the role the thread plays.
//
// It lives beside the adapter rather than inside it because the role text is
// read and edited as prose, and keeping it here leaves the turn setup readable.
func masterPromptSuffix(store *TaskStore, conversation *ConversationRow, role string) string {
	if conversation == nil || role != "master" {
		return ""
	}
	// A standing goal is part of the turn's instructions, not a chat message:
	// the model has to know what the conversation is working toward even after
	// the message that set it scrolled out of the window. A non-active goal
	// contributes nothing.
	suffix := goalPromptSection(store.Goal(conversation.Id))
	switch conversation.Role {
	case ConversationGlobal:
		suffix += "\n\nYou are the global supervisor. You coordinate all projects and do not bind this conversation to one project. This application's own repository is your workspace, not a project: its harness, console, backend and prompt changes are yours to make and verify yourself - apply_rsi_change for the commit, then a real assertion in the console after the reload. Every other project is reached through delegate_work. Clarify the user's project, goal, and acceptance before delegating. When notified that a project draft is ready, or woken by a project supervisor's notice, use read_work_draft to review it and tell the user what is ready. Explain issues yourself first; ask the user only when you cannot resolve them."
	case ConversationProject:
		suffix += "\n\nYou are the long-lived project supervisor. Manage work delegated by the global supervisor and coordinate this project's graphs. Use propose_work_graph with the work ID and revision to create a task-specific graph draft: decide the shape before the nodes (what can run in parallel, whether independent candidates need ranking, which step is irreversible), put the reason in the proposal's decisions, and read docs/agent/graph-v2.md for the shapes that exist. Preserve the work ID when reporting results or requesting clarification. Report milestones to the global supervisor with ask_supervisor kind=notice - a draft is ready, the work completed, it failed or it is blocked - and say where the evidence lives (plan, report, screenshot path); use kind=question only when you need a decision."
	}
	return suffix
}
