// graph:table-writes-exempt: a test seeds the invocation rows it then reads
package graph

import (
	"path/filepath"
	"testing"
)

func TestThroughputMeasuresDecodeAndNotTheContextPrefill(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-throughput-fixture','[]')")
	seedMasterCompletion(t, store, "conv", "op-turn",
		`{"input":200,"output":500,"cacheRead":320000,"cacheWrite":0,"durationMs":250}`, 120000)

	output, latency, rate := masterThroughput(store, "conv")
	if output == nil || *output != 500 {
		t.Fatalf("the view lost the output token count: %v", output)
	}
	if rate == nil {
		t.Fatalf("the view reported no throughput")
	}
	if got := *rate; got != 2000 {
		t.Fatalf("throughput must divide by the decode time the provider measured, not the whole request: got %v tok/s", got)
	}
	if latency == nil || *latency != 1000 {
		t.Fatalf("latency must stay the wall clock of the request: got %v", latency)
	}
}

func TestThroughputWithoutADecodeMeasurementFallsBackToTheWallClock(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-throughput-fixture','[]')")
	seedMasterCompletion(t, store, "conv", "op-turn", `{"input":200,"output":500,"cacheRead":0,"cacheWrite":0}`, 120000)

	_, latency, rate := masterThroughput(store, "conv")
	if latency == nil || *latency != 1000 {
		t.Fatalf("latency must stay the wall clock of the request: got %v", latency)
	}
	if rate == nil || *rate != 500 {
		t.Fatalf("without a decode measurement the rate falls back to the wall clock: got %v", rate)
	}
}
