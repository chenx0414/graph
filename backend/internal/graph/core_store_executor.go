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

func (s *TaskStore) scoped(conn sqlh) *TaskStore {
	scoped := *s
	scoped.DB = conn
	scoped.Db = conn
	return &scoped
}

func (s *TaskStore) transactionConn() (sqlh, func(err *error, settle func())) {
	if s.pool == nil {
		panic("the store has no pool to open a transaction on")
	}
	conn, err := s.pool.Conn(context.Background())
	if err != nil {
		panic(err)
	}
	if err := s.runTransactionStatementOn(connHandle{conn: conn}, "BEGIN IMMEDIATE"); err != nil {
		_ = conn.Close()
		panic(err)
	}
	handle := connHandle{conn: conn}
	return handle, func(commitErr *error, settle func()) {
		defer func() { _ = conn.Close() }()
		if commitErr != nil {
			settle()
			if err := s.runTransactionStatementOn(handle, "ROLLBACK"); err != nil {
				panic(err)
			}
			panic(*commitErr)
		}
		if err := s.runTransactionStatementOn(handle, "COMMIT"); err != nil {
			*commitErr = err
			settle()
			panic(err)
		}
		settle()
	}
}

func (s *TaskStore) runTransactionStatementOn(conn sqlh, statement string) error {
	if s.transactionExec != nil {
		return s.transactionExec(statement)
	}
	_, err := conn.Exec(statement)
	return err
}
