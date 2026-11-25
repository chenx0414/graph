package graph

import (
	"context"
	"database/sql"
)

type connHandle struct{ conn *sql.Conn }

func (h connHandle) Exec(query string, args ...any) (sql.Result, error) {
	return h.conn.ExecContext(context.Background(), query, args...)
}

func (h connHandle) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return h.conn.ExecContext(ctx, query, args...)
}

func (h connHandle) Query(query string, args ...any) (*sql.Rows, error) {
	return h.conn.QueryContext(context.Background(), query, args...)
}

func (h connHandle) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return h.conn.QueryContext(ctx, query, args...)
}

func (h connHandle) QueryRow(query string, args ...any) *sql.Row {
	return h.conn.QueryRowContext(context.Background(), query, args...)
}

type sqlh interface {
	Exec(query string, args ...any) (sql.Result, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// scoped returns the store as seen from inside a transaction: the same state and listeners, with
// every statement addressed to the connection the transaction owns instead of the pool.
func (s *TaskStore) scoped(conn sqlh) *TaskStore {
	scoped := *s
	scoped.DB = conn
	scoped.Db = conn
	return &scoped
}

// transactionScoped is the store a transaction body writes through. It is the only handle that may
// join a nested transaction: membership belongs to the connection, not to a store-wide depth
// counter, or a second goroutine seeing the counter would run its own body on someone else's
// connection and have its work rolled back with theirs.
func (s *TaskStore) transactionScoped(conn sqlh) *TaskStore {
	scoped := s.scoped(conn)
	scoped.inTx = true
	return scoped
}

// transactionConn takes a connection for the transaction to own. The pool hands it out exclusively,
// so a statement from another goroutine waits for the transaction to end instead of running inside
// it - which is what happened when BEGIN was issued as a plain statement on a shared connection.
//
// It returns the handle the body must write through, and an end function that commits or rolls
// back on that same handle and then gives the connection back.
func (s *TaskStore) transactionConn() (sqlh, func(committed bool) error) {
	if s.pool == nil {
		panic("the store has no pool to open a transaction on")
	}
	conn, err := s.pool.Conn(context.Background())
	if err != nil {
		panic(err)
	}
	handle := connHandle{conn: conn}
	if err := s.runTransactionStatementOn(handle, "BEGIN IMMEDIATE"); err != nil {
		_ = conn.Close()
		panic(err)
	}
	return handle, func(committed bool) error {
		defer func() { _ = conn.Close() }()
		if committed {
			return s.runTransactionStatementOn(handle, "COMMIT")
		}
		return s.runTransactionStatementOn(handle, "ROLLBACK")
	}
}

// runTransactionStatementOn issues the transaction's own control statement. A test that drives the
// commit and rollback paths intercepts it through transactionExec so those paths stay reachable
// without a database that can fail on demand.
func (s *TaskStore) runTransactionStatementOn(conn sqlh, statement string) error {
	if s.transactionExec != nil {
		return s.transactionExec(statement)
	}
	_, err := conn.Exec(statement)
	return err
}
