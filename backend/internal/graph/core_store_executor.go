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

// scoped is the store as a transaction sees it: same state, statements on that transaction's connection.
func (s *TaskStore) scoped(conn sqlh) *TaskStore {
	scoped := *s
	scoped.DB = conn
	scoped.Db = conn
	return &scoped
}

// transactionScoped is the handle whose bodies are inside a transaction; membership is per handle, not per store.
func (s *TaskStore) transactionScoped(conn sqlh) *TaskStore {
	scoped := s.scoped(conn)
	scoped.inTx = true
	return scoped
}

// transactionConn takes a connection only this transaction uses.
//
// The end function commits or rolls back on that handle.
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

func (s *TaskStore) runTransactionStatementOn(conn sqlh, statement string) error {
	if s.transactionExec != nil {
		return s.transactionExec(statement)
	}
	_, err := conn.Exec(statement)
	return err
}

// ReadSnapshot reads without waiting on a transaction's connection: it joins an open transaction, else reads on the read pool.
func (s *TaskStore) ReadSnapshot(body func(store *TaskStore)) {
	if s.inTx {
		body(s)
		return
	}
	if s.reads != nil {
		body(s.scoped(s.reads))
		return
	}
	s.txMu.Lock()
	defer s.txMu.Unlock()
	body(s)
}
