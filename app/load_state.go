package main

type loadPhase string

const (
	loadIdle    loadPhase = ""
	loadBusy    loadPhase = "loading"
	loadReadyP  loadPhase = "ready"
	loadFailedP loadPhase = "failed"
)

type loadState[T any] struct {
	phase      loadPhase
	generation int
	data       *T
	failed     string
}

func (state *loadState[T]) loading() bool { return state.phase == loadBusy }

func (state *loadState[T]) ready() bool { return state.phase == loadReadyP }

func (state *loadState[T]) begin() (int, bool) {
	if state.phase == loadBusy || state.phase == loadReadyP {
		return state.generation, false
	}
	state.generation++
	state.phase = loadBusy
	state.failed = ""
	return state.generation, true
}

func (state *loadState[T]) reset() {
	state.generation++
	state.phase = loadIdle
	state.data = nil
	state.failed = ""
}

func (state *loadState[T]) settle(generation int, data *T, failure string) bool {
	if generation != state.generation {
		return false
	}
	if failure != "" {
		state.phase = loadFailedP
		state.failed = failure
		return true
	}
	state.data = data
	state.failed = ""
	state.phase = loadReadyP
	return true
}
