package graph

import (
	"sync"
)

const DefaultAgentExecutions = 1024

const DefaultProgramExecutions = 4

type ExecutionLimiter struct {
	mu      sync.Mutex
	limit   int
	used    int
	waiters []*executionLimiterWaiter
}

type executionLimiterWaiter struct {
	ready  chan struct{}
	queued bool
}

func NewExecutionLimiter(limit int) *ExecutionLimiter {
	if limit < 1 {
		Raise("invalid_config", "An execution limit must be a positive integer, got "+itoa(limit))
	}
	return &ExecutionLimiter{limit: limit}
}

func (limiter *ExecutionLimiter) Limit() int {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	return limiter.limit
}

func (limiter *ExecutionLimiter) Used() int {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	return limiter.used
}

func (limiter *ExecutionLimiter) Waiting() int {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	return len(limiter.waiters)
}

func (limiter *ExecutionLimiter) FreeSlots() int {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	free := limiter.limit - limiter.used
	if free < 0 {
		return 0
	}
	return free
}

func (limiter *ExecutionLimiter) SetLimit(limit int) {
	if limit < 1 {
		Raise("invalid_config", "An execution limit must be a positive integer, got "+itoa(limit))
	}
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	limiter.limit = limit
	for len(limiter.waiters) > 0 && limiter.used < limiter.limit {
		limiter.used++
		limiter.grantLocked()
	}
}

func (limiter *ExecutionLimiter) Acquire(signal *AbortSignal) (func(), error) {
	if signal.Aborted() {
		return nil, executionSlotsAborted()
	}
	limiter.mu.Lock()
	if limiter.used < limiter.limit && len(limiter.waiters) == 0 {
		limiter.used++
		limiter.mu.Unlock()
		return limiter.releaseHandle(), nil
	}
	waiter := &executionLimiterWaiter{ready: make(chan struct{}), queued: true}
	limiter.waiters = append(limiter.waiters, waiter)
	limiter.mu.Unlock()
	select {
	case <-waiter.ready:
		return limiter.releaseHandle(), nil
	case <-signal.Done():
	}
	limiter.mu.Lock()
	if waiter.queued {
		limiter.removeWaiterLocked(waiter)
		limiter.mu.Unlock()
		return nil, executionSlotsAborted()
	}
	limiter.mu.Unlock()
	limiter.Release()
	return nil, executionSlotsAborted()
}

func (limiter *ExecutionLimiter) Release() {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	if len(limiter.waiters) > 0 {
		limiter.grantLocked()
		return
	}
	if limiter.used > 0 {
		limiter.used--
	}
}

func (limiter *ExecutionLimiter) holdExisting() {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	limiter.used++
}

func (limiter *ExecutionLimiter) releaseHandle() func() {
	return sync.OnceFunc(limiter.Release)
}

func (limiter *ExecutionLimiter) grantLocked() {
	waiter := limiter.waiters[0]
	limiter.waiters = limiter.waiters[1:]
	waiter.queued = false
	close(waiter.ready)
}

func (limiter *ExecutionLimiter) removeWaiterLocked(target *executionLimiterWaiter) {
	for index, waiter := range limiter.waiters {
		if waiter != target {
			continue
		}
		limiter.waiters = append(limiter.waiters[:index], limiter.waiters[index+1:]...)
		return
	}
}
