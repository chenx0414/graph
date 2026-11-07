package graph

import "sync"

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
		if source.Aborted() {
			merged.Abort()
			release()
			break
		}
	}
	return merged, release
}
