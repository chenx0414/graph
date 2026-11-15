package graph

type GraphPhase string

const (
	PhaseDiscussing GraphPhase = "discussing"
	PhaseChatting   GraphPhase = "chatting"
	PhaseQueued     GraphPhase = "queued"
	PhaseRunning    GraphPhase = "running"
	PhaseIdle       GraphPhase = "idle"
	PhasePaused     GraphPhase = "paused"
	PhaseBlocked    GraphPhase = "blocked"
	PhaseCompleting GraphPhase = "completing"
	PhaseCompleted  GraphPhase = "completed"
	PhaseStopping   GraphPhase = "stopping"
	PhaseStopped    GraphPhase = "stopped"
	PhaseAbandoned  GraphPhase = "abandoned"
)

var graphPhaseVocabulary = map[GraphPhase]bool{
	PhaseDiscussing: true,
	PhaseChatting:   true,
	PhaseQueued:     true,
	PhaseRunning:    true,
	PhaseIdle:       true,
	PhasePaused:     true,
	PhaseBlocked:    true,
	PhaseCompleting: true,
	PhaseCompleted:  true,
	PhaseStopping:   true,
	PhaseStopped:    true,
	PhaseAbandoned:  true,
}

func (phase GraphPhase) Known() bool {
	return graphPhaseVocabulary[phase]
}

func (phase GraphPhase) Closed() bool {
	return taskPhaseHalting(phase)
}

func (phase GraphPhase) Cancelling() bool {
	return phase == PhaseStopping || phase == PhaseStopped
}

func (phase GraphPhase) CompletionClosed() bool {
	return phase == PhaseCompleting || phase == PhaseCompleted
}

func (phase GraphPhase) LaneEligible() bool {
	switch phase {
	case PhaseRunning, PhaseIdle, PhaseBlocked, PhaseCompleting, PhaseStopping:
		return true
	}
	return false
}

func displayPhase(phase string, paused bool) GraphPhase {
	resolved := GraphPhase(phase)
	if paused && !resolved.Closed() {
		return PhasePaused
	}
	return resolved
}
