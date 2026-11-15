package graph

import "strings"

func requireTaskPhase(phase string) GraphPhase {
	resolved := GraphPhase(phase)
	if !resolved.Known() || resolved == PhasePaused {
		Raise("invalid_input", "Unknown task phase "+phase)
	}
	return resolved
}

func taskPhaseConversational(phase GraphPhase) bool {
	return phase == PhaseDiscussing || phase == PhaseChatting
}

func taskPhaseWorking(phase GraphPhase) bool {
	switch phase {
	case PhaseQueued, PhaseRunning, PhaseIdle, PhaseBlocked, PhaseCompleting:
		return true
	}
	return false
}

func taskPhaseFinished(phase GraphPhase) bool {
	switch phase {
	case PhaseCompleted, PhaseStopped, PhaseAbandoned:
		return true
	}
	return false
}

func taskPhaseHalting(phase GraphPhase) bool {
	return phase == PhaseStopping || taskPhaseFinished(phase)
}

func taskPhasePausedOnArchive(phase GraphPhase) bool {
	return taskPhaseWorking(phase) || phase == PhaseDiscussing
}

func taskPhaseArchivable(phase GraphPhase) bool {
	return taskPhaseConversational(phase) || (taskPhaseWorking(phase) && phase != PhaseBlocked)
}

func taskPhaseFinishedList() []GraphPhase {
	return []GraphPhase{PhaseCompleted, PhaseStopped, PhaseAbandoned}
}

func taskPhaseHaltingList() []GraphPhase {
	return []GraphPhase{PhaseStopping, PhaseCompleted, PhaseStopped, PhaseAbandoned}
}

func taskPhaseArchivableList() []GraphPhase {
	return []GraphPhase{PhaseDiscussing, PhaseChatting, PhaseQueued, PhaseRunning, PhaseIdle, PhaseCompleting}
}

func taskPhasePausedOnArchiveList() []GraphPhase {
	return []GraphPhase{PhaseDiscussing, PhaseQueued, PhaseRunning, PhaseIdle, PhaseBlocked, PhaseCompleting}
}

func taskPhaseParkableList() []GraphPhase {
	return []GraphPhase{PhaseRunning, PhaseIdle}
}

func terminalWorkcopyPhases() []GraphPhase {
	return taskPhaseFinishedList()
}

func taskPhaseSQLLiteral(phases ...GraphPhase) string {
	quoted := make([]string, 0, len(phases))
	for _, phase := range phases {
		if !phase.Known() || phase == PhasePaused {
			continue
		}
		quoted = append(quoted, "'"+string(phase)+"'")
	}
	return strings.Join(quoted, ",")
}

func taskPhaseIn(column string, phases ...GraphPhase) string {
	list := taskPhaseSQLLiteral(phases...)
	if list == "" {
		return "0"
	}
	return column + " IN (" + list + ")"
}

func taskPhaseNotIn(column string, phases ...GraphPhase) string {
	list := taskPhaseSQLLiteral(phases...)
	if list == "" {
		return "1"
	}
	return column + " NOT IN (" + list + ")"
}
