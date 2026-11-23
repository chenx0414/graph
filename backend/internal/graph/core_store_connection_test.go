// graph:table-writes-exempt: the test only inspects how the pool is configured
package graph

import (
	"path/filepath"
	"testing"
)

// BEGIN, COMMIT and ROLLBACK are per connection in SQLite. A pool that hands out more than one
// connection can therefore run BEGIN on one connection and COMMIT on another, where there is no
// transaction - which is how a transaction reported "cannot commit - no transaction is active",
// and how two writers on the same file ended in SQLITE_BUSY. Production opens the store with a
// single connection; the helper the tests use did not, so every test ran against a pool the
// product never has.
func TestEveryStoreRunsOnASingleConnection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.sqlite")

	store := openTaskStore(t, path)
	if limit := store.DB.Stats().MaxOpenConnections; limit != 1 {
		t.Fatalf("the store the tests use allows %d connections; transaction control needs exactly one", limit)
	}

	opened, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = opened.Close() }()
	if limit := opened.Stats().MaxOpenConnections; limit != 1 {
		t.Fatalf("OpenSQLite allows %d connections; transaction control needs exactly one", limit)
	}
}
