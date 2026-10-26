package graph

import (
	"encoding/hex"
	"sync"

	"crypto/sha256"
)

// SlotRequest is one credential's concurrency ask.
type SlotRequest struct {
	CredentialId  string
	ApiKey        string
	Limit         *int
	SharedGroupId string
	GroupLimit    *int
	Refresh       func() SlotRequest
}

// ModelSchedulerSnapshot is the waiting-state display.
type ModelSchedulerSnapshot struct {
	Active map[string]int
	Queued map[string]int
}

// ModelScheduler is the host-wide in-flight gate for model requests.
type ModelScheduler struct {
	mu                 sync.Mutex
	waiters            []*modelWaiter
	activeByCredential map[string]int
	activeByGroup      map[string]int
	canonicalByKey     map[string]string
}

type modelWaiter struct {
	request   SlotRequest
	done      bool
	releaseCh chan func()
	errCh     chan error
}

// ModelSlotAbortError is the AbortError raised when a slot wait is cancelled.
type ModelSlotAbortError struct{}

func (ModelSlotAbortError) Error() string { return "Model slot wait aborted" }

func modelSchedulerAborted() error { return ModelSlotAbortError{} }

// CreateModelScheduler returns an empty host-wide scheduler.
func CreateModelScheduler() *ModelScheduler {
	return &ModelScheduler{
		activeByCredential: map[string]int{},
		activeByGroup:      map[string]int{},
		canonicalByKey:     map[string]string{},
	}
}

func (s *ModelScheduler) identityOf(request SlotRequest) string {
	if request.ApiKey == "" {
		return request.CredentialId
	}
	sum := sha256.Sum256([]byte(request.ApiKey))
	fingerprint := hex.EncodeToString(sum[:])
	if existing, ok := s.canonicalByKey[fingerprint]; ok {
		return existing
	}
	s.canonicalByKey[fingerprint] = request.CredentialId
	return request.CredentialId
}

func (s *ModelScheduler) current(waiter *modelWaiter) SlotRequest {
	if waiter.request.Refresh != nil {
		return waiter.request.Refresh()
	}
	return waiter.request
}

func limitAllows(limit *int, active int) bool {
	if limit == nil {
		return true
	}
	return active < *limit
}

func (s *ModelScheduler) runnable(waiter *modelWaiter) bool {
	request := s.current(waiter)
	if !limitAllows(request.Limit, s.activeByCredential[s.identityOf(request)]) {
		return false
	}
	if request.SharedGroupId == "" {
		return true
	}
	return limitAllows(request.GroupLimit, s.activeByGroup[request.SharedGroupId])
}

func (s *ModelScheduler) grant(waiter *modelWaiter) {
	request := s.current(waiter)
	credentialId := s.identityOf(request)
	group := request.SharedGroupId
	s.activeByCredential[credentialId]++
	if group != "" {
		s.activeByGroup[group]++
	}
	released := false
	release := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if released {
			return
		}
		released = true
		remaining := s.activeByCredential[credentialId] - 1
		if remaining > 0 {
			s.activeByCredential[credentialId] = remaining
		} else {
			delete(s.activeByCredential, credentialId)
		}
		if group != "" {
			groupRemaining := s.activeByGroup[group] - 1
			if groupRemaining > 0 {
				s.activeByGroup[group] = groupRemaining
			} else {
				delete(s.activeByGroup, group)
			}
		}
		s.drainLocked()
	}
	waiter.releaseCh <- release
}

func (s *ModelScheduler) drainLocked() {
	pending := append([]*modelWaiter{}, s.waiters...)
	for _, waiter := range pending {
		if waiter.done || !s.runnable(waiter) {
			continue
		}
		for index, item := range s.waiters {
			if item == waiter {
				s.waiters = append(s.waiters[:index], s.waiters[index+1:]...)
				break
			}
		}
		waiter.done = true
		s.grant(waiter)
	}
}

// Acquire waits for a slot and returns its release function.
func (s *ModelScheduler) Acquire(request SlotRequest, signal *AbortSignal) (func(), error) {
	if signal != nil && signal.Aborted() {
		return nil, modelSchedulerAborted()
	}
	waiter := &modelWaiter{request: request, releaseCh: make(chan func(), 1), errCh: make(chan error, 1)}
	s.mu.Lock()
	s.waiters = append(s.waiters, waiter)
	s.drainLocked()
	granted := waiter.done
	s.mu.Unlock()
	if granted {
		return <-waiter.releaseCh, nil
	}
	var listener *abortListener
	if signal != nil {
		listener = signal.AddEventListener("abort", func() {
			s.mu.Lock()
			if waiter.done {
				s.mu.Unlock()
				return
			}
			waiter.done = true
			for index, item := range s.waiters {
				if item == waiter {
					s.waiters = append(s.waiters[:index], s.waiters[index+1:]...)
					break
				}
			}
			s.mu.Unlock()
			waiter.errCh <- modelSchedulerAborted()
		}, true)
	}
	select {
	case release := <-waiter.releaseCh:
		if listener != nil {
			signal.RemoveEventListener(listener)
		}
		return release, nil
	case err := <-waiter.errCh:
		return nil, err
	}
}

// Wake re-evaluates queued waiters after configuration changed.
func (s *ModelScheduler) Wake() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.drainLocked()
}

// Active is the in-flight count for one credential, or the total when id is empty.
func (s *ModelScheduler) Active(credentialId string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if credentialId != "" {
		return s.activeByCredential[credentialId]
	}
	total := 0
	for _, count := range s.activeByCredential {
		total += count
	}
	return total
}

// Queued is the number of waiters that have not been granted.
func (s *ModelScheduler) Queued() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, waiter := range s.waiters {
		if !waiter.done {
			count++
		}
	}
	return count
}

// Snapshot is busy and waiting per credential identity.
func (s *ModelScheduler) Snapshot() ModelSchedulerSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	active := map[string]int{}
	for id, count := range s.activeByCredential {
		active[id] = count
	}
	queued := map[string]int{}
	for _, waiter := range s.waiters {
		if waiter.done {
			continue
		}
		identity := s.identityOf(s.current(waiter))
		queued[identity]++
	}
	return ModelSchedulerSnapshot{Active: active, Queued: queued}
}
