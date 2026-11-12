package graph

import (
	"runtime"
	"sync"
	"testing"
	"time"
)

type limiterGrant struct {
	release func()
	err     error
}

func awaitLimiterEvent(t *testing.T, events <-chan limiterGrant, what string) limiterGrant {
	t.Helper()
	select {
	case granted := <-events:
		return granted
	case <-time.After(30 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		return limiterGrant{}
	}
}

func awaitLimiterState(t *testing.T, settled func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !settled() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		runtime.Gosched()
	}
}

func acquireLimiterLease(t *testing.T, limiter *ExecutionLimiter) func() {
	t.Helper()
	release, err := limiter.Acquire(NewAbortSignal())
	if err != nil {
		t.Fatalf("the slot must be granted, got %v", err)
	}
	return release
}

func TestExecutionLimiterGrantsOneThousandConcurrentLeases(t *testing.T) {
	limiter := NewExecutionLimiter(1000)
	events := make(chan limiterGrant, 1000)
	for i := 0; i < 1000; i++ {
		go func() {
			release, err := limiter.Acquire(NewAbortSignal())
			events <- limiterGrant{release: release, err: err}
		}()
	}
	releases := make([]func(), 0, 1000)
	for i := 0; i < 1000; i++ {
		granted := awaitLimiterEvent(t, events, "one thousand concurrent leases")
		if granted.err != nil {
			t.Fatalf("lease %d was refused with %v", i, granted.err)
		}
		releases = append(releases, granted.release)
	}
	if limiter.Used() != 1000 {
		t.Fatalf("all one thousand leases must be held at once, held %d", limiter.Used())
	}
	if limiter.FreeSlots() != 0 {
		t.Fatalf("a full pool has no free slots, got %d", limiter.FreeSlots())
	}
	if limiter.Waiting() != 0 {
		t.Fatalf("nobody may still be queued, waiting %d", limiter.Waiting())
	}
	for _, release := range releases {
		release()
	}
	if limiter.Used() != 0 {
		t.Fatalf("releasing every lease empties the pool, held %d", limiter.Used())
	}
}

func TestExecutionLimiterBlocksTheEleventhLeaseInsteadOfRejectingIt(t *testing.T) {
	limiter := NewExecutionLimiter(10)
	releases := make([]func(), 0, 10)
	for i := 0; i < 10; i++ {
		releases = append(releases, acquireLimiterLease(t, limiter))
	}
	events := make(chan limiterGrant, 1)
	go func() {
		release, err := limiter.Acquire(NewAbortSignal())
		events <- limiterGrant{release: release, err: err}
	}()
	awaitLimiterState(t, func() bool { return limiter.Waiting() == 1 }, "the eleventh lease to queue")
	select {
	case granted := <-events:
		t.Fatalf("the eleventh lease must block while the pool is full, it returned with %v", granted.err)
	default:
	}
	releases[0]()
	granted := awaitLimiterEvent(t, events, "the eleventh lease to wake on release")
	if granted.err != nil {
		t.Fatalf("the eleventh lease must be blocked until a release, it was rejected with %v", granted.err)
	}
	if limiter.Used() != 10 {
		t.Fatalf("transferring a lease keeps the pool full, held %d", limiter.Used())
	}
	granted.release()
	for _, release := range releases[1:] {
		release()
	}
	if limiter.Used() != 0 {
		t.Fatalf("the pool must empty once every lease is released, held %d", limiter.Used())
	}
}

func TestExecutionLimiterLimitOfOneSerializesLeases(t *testing.T) {
	limiter := NewExecutionLimiter(1)
	first := acquireLimiterLease(t, limiter)
	events := make(chan limiterGrant, 1)
	var inFlight, peak int
	var mu sync.Mutex
	go func() {
		release, err := limiter.Acquire(NewAbortSignal())
		if err == nil {
			mu.Lock()
			inFlight++
			if inFlight > peak {
				peak = inFlight
			}
			mu.Unlock()
			defer func() {
				mu.Lock()
				inFlight--
				mu.Unlock()
				release()
			}()
		}
		events <- limiterGrant{release: func() {}, err: err}
	}()
	awaitLimiterState(t, func() bool { return limiter.Waiting() == 1 }, "the second lease to queue")
	first()
	granted := awaitLimiterEvent(t, events, "the second lease")
	if granted.err != nil {
		t.Fatalf("the second lease must wait for the first, got %v", granted.err)
	}
	mu.Lock()
	observed := peak
	mu.Unlock()
	if observed != 1 {
		t.Fatalf("a limit of one holds exactly one lease, saw %d", observed)
	}
}

func TestExecutionLimiterGrantsQueuedWaitersInArrivalOrder(t *testing.T) {
	limiter := NewExecutionLimiter(1)
	holder := acquireLimiterLease(t, limiter)
	start := make([]chan struct{}, 5)
	events := make(chan limiterGrant, 5)
	grantedOrder := make(chan int, 5)
	for i := 0; i < 5; i++ {
		start[i] = make(chan struct{})
		go func(index int, gate <-chan struct{}) {
			<-gate
			release, err := limiter.Acquire(NewAbortSignal())
			grantedOrder <- index
			events <- limiterGrant{release: release, err: err}
		}(i, start[i])
	}
	for i := 0; i < 5; i++ {
		start[i] <- struct{}{}
		awaitLimiterState(t, func() bool { return limiter.Waiting() == i+1 }, "queued waiters")
	}
	holder()
	for i := 0; i < 5; i++ {
		granted := awaitLimiterEvent(t, events, "the next lease in arrival order")
		if granted.err != nil {
			t.Fatalf("queued lease %d failed with %v", i, granted.err)
		}
		if order := <-grantedOrder; order != i {
			t.Fatalf("waiters must be granted in arrival order: got %d, want %d", order, i)
		}
		granted.release()
	}
}

func TestExecutionLimiterCancellationLeavesNoLeaseBehind(t *testing.T) {
	limiter := NewExecutionLimiter(1)
	held := acquireLimiterLease(t, limiter)
	signal := NewAbortSignal()
	events := make(chan limiterGrant, 1)
	go func() {
		release, err := limiter.Acquire(signal)
		events <- limiterGrant{release: release, err: err}
	}()
	awaitLimiterState(t, func() bool { return limiter.Waiting() == 1 }, "the cancelled lease to queue")
	signal.Abort()
	cancelled := awaitLimiterEvent(t, events, "the cancelled lease")
	if _, ok := cancelled.err.(*AbortError); !ok {
		t.Fatalf("a cancelled wait reports the abort error, got %v", cancelled.err)
	}
	if limiter.Waiting() != 0 {
		t.Fatalf("a cancelled waiter must leave the queue, waiting %d", limiter.Waiting())
	}
	if limiter.Used() != 1 {
		t.Fatalf("cancellation must not touch the held lease, held %d", limiter.Used())
	}
	held()
	next := acquireLimiterLease(t, limiter)
	if limiter.Used() != 1 {
		t.Fatalf("the released lease is reusable, held %d", limiter.Used())
	}
	next()
	if limiter.Used() != 0 {
		t.Fatalf("the pool must be empty, held %d", limiter.Used())
	}
}

func TestExecutionLimiterCancelledWaiterLeavesTheSlotForTheNextOne(t *testing.T) {
	limiter := NewExecutionLimiter(1)
	held := acquireLimiterLease(t, limiter)
	cancelledSignal := NewAbortSignal()
	cancelled := make(chan limiterGrant, 1)
	go func() {
		release, err := limiter.Acquire(cancelledSignal)
		cancelled <- limiterGrant{release: release, err: err}
	}()
	awaitLimiterState(t, func() bool { return limiter.Waiting() == 1 }, "the cancelled waiter")
	next := make(chan limiterGrant, 1)
	go func() {
		release, err := limiter.Acquire(NewAbortSignal())
		next <- limiterGrant{release: release, err: err}
	}()
	awaitLimiterState(t, func() bool { return limiter.Waiting() == 2 }, "the replacement waiter")
	cancelledSignal.Abort()
	awaitLimiterState(t, func() bool { return limiter.Waiting() == 1 }, "the cancelled waiter to leave the queue")
	held()
	granted := awaitLimiterEvent(t, next, "the replacement lease")
	if granted.err != nil {
		t.Fatalf("the replacement waiter must get the freed lease, got %v", granted.err)
	}
	if limiter.Used() != 1 {
		t.Fatalf("the freed lease is held by the replacement waiter, held %d", limiter.Used())
	}
	cancelledGrant := awaitLimiterEvent(t, cancelled, "the cancelled lease result")
	if _, ok := cancelledGrant.err.(*AbortError); !ok {
		t.Fatalf("the cancelled waiter reports the abort error, got %v", cancelledGrant.err)
	}
	granted.release()
	if limiter.Used() != 0 {
		t.Fatalf("the pool must be empty, held %d", limiter.Used())
	}
}

func TestExecutionLimiterReleaseWakesExactlyOneWaiter(t *testing.T) {
	limiter := NewExecutionLimiter(2)
	first := acquireLimiterLease(t, limiter)
	second := acquireLimiterLease(t, limiter)
	events := make(chan limiterGrant, 2)
	for i := 0; i < 2; i++ {
		go func() {
			release, err := limiter.Acquire(NewAbortSignal())
			events <- limiterGrant{release: release, err: err}
		}()
	}
	awaitLimiterState(t, func() bool { return limiter.Waiting() == 2 }, "both waiters to queue")
	first()
	granted := awaitLimiterEvent(t, events, "the first woken waiter")
	if granted.err != nil {
		t.Fatalf("the first woken waiter failed with %v", granted.err)
	}
	awaitLimiterState(t, func() bool { return limiter.Waiting() == 1 }, "exactly one waiter to remain")
	if limiter.Used() != 2 {
		t.Fatalf("one release wakes one waiter and keeps the pool full, held %d", limiter.Used())
	}
	second()
	woken := awaitLimiterEvent(t, events, "the second woken waiter")
	if woken.err != nil {
		t.Fatalf("the second woken waiter failed with %v", woken.err)
	}
	granted.release()
	woken.release()
	if limiter.Used() != 0 {
		t.Fatalf("the pool must be empty, held %d", limiter.Used())
	}
}

func TestExecutionLimiterRaisedLimitAdmitsQueuedWaiters(t *testing.T) {
	limiter := NewExecutionLimiter(1)
	held := acquireLimiterLease(t, limiter)
	events := make(chan limiterGrant, 2)
	for i := 0; i < 2; i++ {
		go func() {
			release, err := limiter.Acquire(NewAbortSignal())
			events <- limiterGrant{release: release, err: err}
		}()
	}
	awaitLimiterState(t, func() bool { return limiter.Waiting() == 2 }, "both waiters to queue")
	limiter.SetLimit(3)
	first := awaitLimiterEvent(t, events, "the first waiter after raising the limit")
	second := awaitLimiterEvent(t, events, "the second waiter after raising the limit")
	if first.err != nil || second.err != nil {
		t.Fatalf("raising the limit admits queued waiters: %v %v", first.err, second.err)
	}
	if limiter.Limit() != 3 {
		t.Fatalf("the limiter reports its configured limit, got %d", limiter.Limit())
	}
	if limiter.Used() != 3 {
		t.Fatalf("three leases are held, held %d", limiter.Used())
	}
	held()
	first.release()
	second.release()
	if limiter.Used() != 0 {
		t.Fatalf("the pool must be empty, held %d", limiter.Used())
	}
}
