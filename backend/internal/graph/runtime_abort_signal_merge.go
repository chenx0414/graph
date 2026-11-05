package graph

import "sync"

// MergeAbortSignals returns one signal that aborts when any of the sources
// does, plus a release that forgets the merged listeners.
//
// One command can have more than one reason to stop: the operation is
// interrupted, and the caller imposed a deadline of its own. The command has to
// honour both, so the runner is given a signal that carries either. The single
// reason case - every tool call in the daemon today - returns the source
// itself, so nothing is allocated for it.
func MergeAbortSignals(sources ...*AbortSignal) (*AbortSignal, func()) {
	live := make([]*AbortSignal, 0, len(sources))
	for _, source := range sources {
		if source == nil {
			continue
		}
		if source.Aborted() {
			return source, func() {}
		}
		live = append(live, source)
	}
	switch len(live) {
	case 0:
		return nil, func() {}
	case 1:
		return live[0], func() {}
	}
	merged := NewAbortSignal()
	type attachment struct {
		source   *AbortSignal
		listener *abortListener
	}
	var mutex sync.Mutex
	attached := make([]attachment, 0, len(live))
	released := false
	release := func() {
		mutex.Lock()
		if released {
			mutex.Unlock()
			return
		}
		released = true
		held := attached
		attached = nil
		mutex.Unlock()
		for _, item := range held {
			item.source.RemoveEventListener(item.listener)
		}
	}
	for _, source := range live {
		listener := source.AddEventListener("abort", func() {
			merged.Abort()
			release()
		}, true)
		mutex.Lock()
		attached = append(attached, attachment{source: source, listener: listener})
		mutex.Unlock()
		// A source that aborted while its listener was being registered never
		// fires it: the abort has to be carried over here instead of lost.
		if source.Aborted() {
			merged.Abort()
			release()
			break
		}
	}
	return merged, release
}
