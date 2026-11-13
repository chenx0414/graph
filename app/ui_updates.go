package main

import (
	"sync"

	"github.com/egoist/mygo"
)

type uiUpdates struct {
	mu      sync.Mutex
	pending []func()
}

func (updates *uiUpdates) post(window *mygo.Window, apply func()) {
	updates.mu.Lock()
	updates.pending = append(updates.pending, apply)
	updates.mu.Unlock()
	if window != nil {
		window.Update(updates.drain)
	}
}

func (updates *uiUpdates) drain() {
	updates.mu.Lock()
	pending := updates.pending
	updates.pending = nil
	updates.mu.Unlock()
	for _, apply := range pending {
		apply()
	}
}

func onUI(window *mygo.Window, apply func()) {
	if window == nil {
		apply()
		return
	}
	mygo.RunOnMain(apply)
}
