// graph:table-writes-exempt: a test seeds the parent rows its subject requires
package graph

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// The ledger a node keeps between provider calls: what is held while a send is
// in flight, what has really been spent, and how settlement closes the hold.
// A regression here is invisible to a single send and shows up as a node that
// double-charges or forgets its usage, so the facts are asserted directly.
func newTestKernel(t *testing.T) (*KernelStore, func()) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tasks.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	store := NewTaskStore(db, path)
	// kernel_node_state carries a foreign key to the task it belongs to.
	if _, err := store.DB.Exec(`INSERT INTO projects(id,root,grants) VALUES('p',?,'[]')`, t.TempDir()); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq,graph_version)
		VALUES('task','p','',1,0,'chatting',0,1,1)`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	kernel := NewKernelStore(store)
	return kernel, func() { store.Close() }
}

func TestNodeReservationsAreHeldAndReleasedWithoutTouchingUsage(t *testing.T) {
	kernel, closeStore := newTestKernel(t)
	defer closeStore()

	kernel.ReserveNodeTokens("task", "node", TokenBudget{Unlimited: true}, 100, "")
	kernel.ReserveNodeTokens("task", "node", TokenBudget{Unlimited: true}, 40, "")
	if reserved := kernel.BudgetState("task", "node", TokenBudget{Unlimited: true}).Reserved; reserved != 140 {
		t.Fatalf("two sends in flight hold 140, got %v", reserved)
	}

	kernel.ReleaseNodeTokens("task", "node", 100, "")
	state := kernel.BudgetState("task", "node", TokenBudget{Unlimited: true})
	if state.Reserved != 40 {
		t.Fatalf("releasing one hold leaves the other, got %v", state.Reserved)
	}
	if state.Used != 0 {
		t.Fatalf("a hold is not a spend, used must stay 0, got %v", state.Used)
	}

	// A release larger than the hold cannot push the counter below zero.
	kernel.ReleaseNodeTokens("task", "node", 1_000, "")
	if reserved := kernel.BudgetState("task", "node", TokenBudget{Unlimited: true}).Reserved; reserved != 0 {
		t.Fatalf("reserved must clamp at zero, got %v", reserved)
	}
}

func TestCommittedUsageCountsOnceAndSettlementClearsTheHold(t *testing.T) {
	kernel, closeStore := newTestKernel(t)
	defer closeStore()

	kernel.ReserveNodeTokens("task", "node", TokenBudget{Unlimited: true}, 250, "")
	kernel.CommitNodeUsage("task", "node", 30)
	kernel.CommitNodeUsage("task", "node", 20)

	state := kernel.BudgetState("task", "node", TokenBudget{Unlimited: true})
	if state.Used != 50 {
		t.Fatalf("commits add up to 50, got %v", state.Used)
	}
	if state.Reserved != 250 {
		t.Fatalf("a commit does not release the hold, got %v", state.Reserved)
	}

	kernel.SettleNodeReservation("task", "node")
	state = kernel.BudgetState("task", "node", TokenBudget{Unlimited: true})
	if state.Reserved != 0 {
		t.Fatalf("settlement clears the hold, got %v", state.Reserved)
	}
	if state.Used != 50 {
		t.Fatalf("settlement keeps what was spent, got %v", state.Used)
	}
}
