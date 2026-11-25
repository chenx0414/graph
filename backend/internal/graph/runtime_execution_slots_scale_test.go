// graph:table-writes-exempt: a test seeds the graph rows its subject drives
package graph

import (
	"fmt"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

type simulatedNodeHost struct {
	kernel *KernelStore
	graph  string
	node   string
	signal *AbortSignal
	start  chan<- string
	finish <-chan struct{}
}

func (host *simulatedNodeHost) Start() HostProcess {
	return HostProcess{ProcessId: 1}
}

func (host *simulatedNodeHost) Alive() bool {
	return true
}

func (host *simulatedNodeHost) Turn(string) TurnReport {
	execution := host.kernel.RunningExecution(host.graph, host.node)
	if execution == nil {
		panic("simulated turn started without a running execution")
	}
	WaitForKernelExecutionSlot(host.kernel, execution.Id, host.signal)
	host.start <- execution.Id
	<-host.finish
	return TurnReport{Done: true}
}

func nodeID(index int) string {
	return fmt.Sprintf("node-%04d", index)
}

func newSimulatedGraph(t testing.TB, nodes int) *KernelStore {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tasks.sqlite")
	db, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	store := NewTaskStore(db, path)
	t.Cleanup(store.Close)
	if _, err := store.DB.Exec(`INSERT INTO projects(id,root,grants) VALUES('p',?,'[]')`, t.TempDir()); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq,graph_version)
		VALUES('task','p','',1,0,'running',0,1,1)`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	kernel := NewKernelStore(store)
	definition := GraphDefinition{Nodes: map[string]NodeDefinition{}}
	for index := 0; index < nodes; index++ {
		definition.Nodes[nodeID(index)] = NodeDefinition{}
	}
	if revision := kernel.InsertRevision("task", definition, "scale"); revision == nil {
		t.Fatal("the simulated graph needs a revision")
	}
	createdAt := NowMillis()
	for index := 0; index < nodes; index++ {
		id := nodeID(index)
		kernelExec(kernel.Db, `INSERT INTO kernel_nodes(task_id,revision_version,node_id,instance_id,kind,spec,status)
			VALUES('task',1,?,'','agent','{}','idle')`, id)
		kernelExec(kernel.Db, `INSERT INTO kernel_queue(task_id,node_id,kind,payload,created_at)
			VALUES('task',?,'chat','null',?)`, id, createdAt)
	}
	return kernel
}

func newSimulatedRunner(kernel *KernelStore, start chan<- string, finish <-chan struct{}) *GraphRunner {
	return NewGraphRunner(GraphRunnerOptions{
		Kernel:  kernel,
		GraphId: "task",
		Signal:  NewAbortSignal(),
		HostFor: func(node string, revisionVersion int) ExecutorHost {
			return &simulatedNodeHost{kernel: kernel, graph: "task", node: node, signal: NewAbortSignal(), start: start, finish: finish}
		},
	})
}

func awaitSimulatedStart(t *testing.T, started <-chan string, want, got int) string {
	t.Helper()
	select {
	case id := <-started:
		return id
	case <-time.After(2 * time.Minute):
		t.Fatalf("only %d of %d simulated nodes reached the execution slot", got, want)
		return ""
	}
}

func awaitSimulatedDrain(t *testing.T, result <-chan RunResult) RunResult {
	t.Helper()
	select {
	case drained := <-result:
		return drained
	case <-time.After(2 * time.Minute):
		t.Fatal("the simulated graph did not drain")
		return RunResult{}
	}
}

func countKernelRows(t *testing.T, kernel *KernelStore, query string) int64 {
	t.Helper()
	row := kernelRow(kernel.Db, query)
	if row == nil {
		t.Fatalf("count query failed: %s", query)
	}
	return kernelInt(row["n"])
}

func TestGraphRunnerHoldsOneThousandSimultaneousExecutionSlots(t *testing.T) {
	if testing.Short() {
		t.Skip("1000 simultaneous execution slots: slow layer only")
	}
	const nodes = 1000
	kernel := newSimulatedGraph(t, nodes)
	store := kernel.Store
	store.SetExecutionLimits(nodes, 4)
	started := make(chan string, nodes)
	finish := make(chan struct{})
	runner := newSimulatedRunner(kernel, started, finish)
	result := make(chan RunResult, 1)
	go func() { result <- runner.Drain() }()

	seen := map[string]bool{}
	for index := 0; index < nodes; index++ {
		seen[awaitSimulatedStart(t, started, nodes, len(seen))] = true
	}
	if len(seen) != nodes {
		t.Fatalf("every simulated node must reach its execution slot, saw %d", len(seen))
	}
	if used := store.ExecutionSlotsUsed("agent"); used != nodes {
		t.Fatalf("%d execution slots must be held at once, held %d", nodes, used)
	}
	if free := store.FreeExecutionSlots("agent"); free != 0 {
		t.Fatalf("the configured limit is fully occupied, got %d free", free)
	}
	if waiting := store.ExecutionSlotsWaiting("agent"); waiting != 0 {
		t.Fatalf("nobody queues once every node holds a slot, waiting %d", waiting)
	}
	goroutines := runtime.NumGoroutine()
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	t.Logf("concurrent=1000 goroutines=%d heapAllocMiB=%.1f", goroutines, float64(stats.HeapAlloc)/(1024*1024))

	close(finish)
	drained := awaitSimulatedDrain(t, result)
	if drained.Executions != nodes {
		t.Fatalf("the runner records one execution per simulated node, got %d", drained.Executions)
	}
	if !drained.Drained {
		t.Fatalf("the simulated graph must drain, blocked nodes: %v", drained.BlockedNodes)
	}
	if completed := countKernelRows(t, kernel, "SELECT COUNT(*) AS n FROM kernel_executions WHERE state='completed'"); completed != nodes {
		t.Fatalf("every simulated node completes its execution, got %d", completed)
	}
	if succeeded := countKernelRows(t, kernel, "SELECT COUNT(*) AS n FROM kernel_nodes WHERE status='succeeded'"); succeeded != nodes {
		t.Fatalf("every simulated node succeeds, got %d", succeeded)
	}
	if used := store.ExecutionSlotsUsed("agent"); used != 0 {
		t.Fatalf("the drained graph returns every execution slot, held %d", used)
	}
}

func TestGraphRunnerBlocksBeyondTheConfiguredExecutionLimit(t *testing.T) {
	const nodes = 64
	const limit = 10
	kernel := newSimulatedGraph(t, nodes)
	store := kernel.Store
	store.SetExecutionLimits(limit, 4)
	started := make(chan string, nodes)
	finish := make(chan struct{})
	runner := newSimulatedRunner(kernel, started, finish)
	result := make(chan RunResult, 1)
	go func() { result <- runner.Drain() }()

	for index := 0; index < limit; index++ {
		awaitSimulatedStart(t, started, limit, index)
	}
	awaitSlotState(t, func() bool { return store.ExecutionSlotsUsed("agent") == limit }, "the configured limit to be fully held")
	select {
	case <-started:
		t.Fatal("an extra simulated node acquired a slot while the limit was fully held")
	default:
	}
	close(finish)
	drained := awaitSimulatedDrain(t, result)
	if drained.Executions != nodes {
		t.Fatalf("every simulated node runs once the slots turn over, got %d", drained.Executions)
	}
	if !drained.Drained {
		t.Fatalf("the simulated graph must drain, blocked nodes: %v", drained.BlockedNodes)
	}
	if failed := countKernelRows(t, kernel, "SELECT COUNT(*) AS n FROM kernel_executions WHERE state='completed'"); failed != nodes {
		t.Fatalf("no simulated node was rejected by the limiter, completed %d", failed)
	}
	if used := store.ExecutionSlotsUsed("agent"); used != 0 {
		t.Fatalf("the drained graph returns every execution slot, held %d", used)
	}
}

type dbWriteSnapshot struct {
	events     int64
	executions int64
	bytes      int64
}

func readDBWriteSnapshot(t testing.TB, db sqlh) dbWriteSnapshot {
	t.Helper()
	snapshot := dbWriteSnapshot{}
	snapshot.events = countTableRows(t, db, "events")
	snapshot.executions = countTableRows(t, db, "kernel_executions")
	var pages, pageSize int64
	if err := db.QueryRow("PRAGMA page_count").Scan(&pages); err != nil {
		t.Fatalf("page count: %v", err)
	}
	if err := db.QueryRow("PRAGMA page_size").Scan(&pageSize); err != nil {
		t.Fatalf("page size: %v", err)
	}
	snapshot.bytes = pages * pageSize
	return snapshot
}

func countTableRows(t testing.TB, db sqlh, table string) int64 {
	t.Helper()
	row := kernelRow(db, "SELECT COUNT(*) AS n FROM "+table)
	if row == nil {
		t.Fatalf("count %s failed", table)
	}
	return kernelInt(row["n"])
}

func BenchmarkExecutionLimiterContendedHold(b *testing.B) {
	limiter := NewExecutionLimiter(1000)
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		signal := NewAbortSignal()
		for pb.Next() {
			release, err := limiter.Acquire(signal)
			if err != nil {
				b.Fatalf("acquire: %v", err)
			}
			release()
		}
	})
	if used := limiter.Used(); used != 0 {
		b.Fatalf("leases leaked: %d", used)
	}
}

func BenchmarkGraphRunnerSimulatedThousandNodes(b *testing.B) {
	const nodes = 1000
	b.ReportAllocs()
	var elapsedTotal time.Duration
	var eventTotal, executionTotal, byteTotal int64
	var goroutinePeak, heapPeak int
	for iteration := 0; iteration < b.N; iteration++ {
		b.StopTimer()
		kernel := newSimulatedGraph(b, nodes)
		store := kernel.Store
		store.SetExecutionLimits(nodes, 4)
		started := make(chan string, nodes)
		finish := make(chan struct{})
		runner := newSimulatedRunner(kernel, started, finish)
		before := readDBWriteSnapshot(b, store.DB)
		b.StartTimer()

		began := time.Now()
		result := make(chan RunResult, 1)
		go func() { result <- runner.Drain() }()
		for startedCount := 0; startedCount < nodes; startedCount++ {
			<-started
		}
		if goroutines := runtime.NumGoroutine(); goroutines > goroutinePeak {
			goroutinePeak = goroutines
		}
		var heap runtime.MemStats
		runtime.ReadMemStats(&heap)
		if int(heap.HeapAlloc) > heapPeak {
			heapPeak = int(heap.HeapAlloc)
		}
		close(finish)
		drained := <-result
		elapsedTotal += time.Since(began)

		b.StopTimer()
		if !drained.Drained || drained.Executions != nodes {
			b.Fatalf("drained=%v executions=%d", drained.Drained, drained.Executions)
		}
		after := readDBWriteSnapshot(b, store.DB)
		eventTotal += after.events - before.events
		executionTotal += after.executions - before.executions
		byteTotal += after.bytes - before.bytes
	}
	b.ReportMetric(float64(nodes*b.N)/elapsedTotal.Seconds(), "nodes/sec")
	b.ReportMetric(float64(eventTotal)/float64(b.N), "db-events/op")
	b.ReportMetric(float64(executionTotal)/float64(b.N), "db-executions/op")
	b.ReportMetric(float64(byteTotal)/float64(b.N)/1024/1024, "db-growthMiB/op")
	b.ReportMetric(float64(goroutinePeak), "goroutine-peak")
	b.ReportMetric(float64(heapPeak)/(1024*1024), "heap-peakMiB")
}

func TestGraphRunnerScaleReport(t *testing.T) {
	if testing.Short() {
		t.Skip("1000-node scale report: slow layer only")
	}
	const nodes = 1000
	kernel := newSimulatedGraph(t, nodes)
	store := kernel.Store
	store.SetExecutionLimits(nodes, 4)
	started := make(chan string, nodes)
	finish := make(chan struct{})
	runner := newSimulatedRunner(kernel, started, finish)
	before := readDBWriteSnapshot(t, store.DB)
	began := time.Now()
	result := make(chan RunResult, 1)
	go func() { result <- runner.Drain() }()
	seen := map[string]bool{}
	for index := 0; index < nodes; index++ {
		seen[awaitSimulatedStart(t, started, nodes, len(seen))] = true
	}
	held := store.ExecutionSlotsUsed("agent")
	goroutines := runtime.NumGoroutine()
	var peak runtime.MemStats
	runtime.ReadMemStats(&peak)
	close(finish)
	drained := awaitSimulatedDrain(t, result)
	elapsed := time.Since(began)
	after := readDBWriteSnapshot(t, store.DB)
	runtime.GC()
	var end runtime.MemStats
	runtime.ReadMemStats(&end)
	if !drained.Drained || drained.Executions != nodes || held != nodes {
		t.Fatalf("drained=%v executions=%d held=%d", drained.Drained, drained.Executions, held)
	}
	t.Logf("scale nodes=%d concurrent=%d goroutines=%d elapsedMs=%d nodesPerSec=%.0f dbEvents+%d dbExecutions+%d dbGrowthMiB=%.2f heapPeakMiB=%.1f heapEndMiB=%.1f",
		nodes, held, goroutines, elapsed.Milliseconds(), float64(nodes)/elapsed.Seconds(),
		after.events-before.events, after.executions-before.executions,
		float64(after.bytes-before.bytes)/(1024*1024),
		float64(peak.HeapAlloc)/(1024*1024), float64(end.HeapAlloc)/(1024*1024))
}
