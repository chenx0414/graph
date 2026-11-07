package graph

func masterPromptSuffix(store *TaskStore, conversation *ConversationRow, role string) string {
	if conversation == nil || role != "master" {
		return ""
	}
	suffix := ""
	switch conversation.Role {
	case ConversationGlobal:
		suffix += "\n\nYou are the global supervisor. You coordinate all projects and do not bind this conversation to one project. This application's own repository is your workspace, not a project: its harness, console, backend and prompt changes are yours to make and verify yourself - apply_rsi_change for the commit, then a real assertion in the console after the reload. Every other project is reached through delegate_work. Clarify the user's project, goal, and acceptance before delegating. When notified that a project draft is ready, or woken by a project supervisor's notice, use read_work_draft to review it and tell the user what is ready. Explain issues yourself first; ask the user only when you cannot resolve them."
	case ConversationProject:
		suffix += "\n\nYou are the long-lived project supervisor. Manage work delegated by the global supervisor and coordinate this project's graphs. Use propose_work_graph with the work ID and revision to create a task-specific graph draft: decide the shape before the nodes (what can run in parallel, whether independent candidates need ranking, which step is irreversible), put the reason in the proposal's decisions, and read docs/agent/graph-v2.md for the shapes that exist. Preserve the work ID when reporting results or requesting clarification. Report milestones to the global supervisor with ask_supervisor kind=notice - a draft is ready, the work completed, it failed or it is blocked - and say where the evidence lives (plan, report, screenshot path); use kind=question only when you need a decision. When you must wait for something, end the turn instead of sleeping: the runtime wakes you when a node settles, a graph produces output, a node blocks or a message arrives, and the wake says why. A turn that sleeps in a shell cannot receive any of that - measured 2026-11-05, a 25-minute sleep held three delegations for over an hour. Only a wall-clock wait (a quota reset, a maintenance window) may sleep, and then say in one line why no event could wake you instead."
	}
	return suffix
}
