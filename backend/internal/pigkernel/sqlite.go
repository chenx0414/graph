package pigkernel

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"

	chordsqlite "github.com/MichaelKinsy/PiG/chord/sqlite"
)

func reportStorageError(operation string, err error) {
	if err == nil {
		return
	}
	_, _ = os.Stderr.WriteString("pig kernel: durable storage " + operation + " failed: " + err.Error() + "\n")
}

type sqliteDatabase struct {
	db           *sql.DB
	transactions sync.Mutex
}

var _ chordsqlite.SqliteDatabase = (*sqliteDatabase)(nil)

func openSqliteDatabase(path string) (*sqliteDatabase, error) {
	db, err := sql.Open("sqlite", kernelDatabaseDSN(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	return &sqliteDatabase{db: db}, nil
}

func kernelDatabaseDSN(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		absolute = path
	}
	location := &url.URL{Scheme: "file", Path: absolute}
	query := location.Query()
	query.Add("_pragma", "busy_timeout(10000)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "synchronous(FULL)")
	query.Set("_txlock", "immediate")
	location.RawQuery = query.Encode()
	return location.String()
}

func (database *sqliteDatabase) Exec(sql string) error {
	_, err := database.db.Exec(sql)
	reportStorageError("exec", err)
	return err
}

func (database *sqliteDatabase) Run(sql string, params ...chordsqlite.SqliteValue) error {
	_, err := database.db.Exec(sql, params...)
	reportStorageError("run", err)
	return err
}

func (database *sqliteDatabase) RunCounted(sql string, params ...chordsqlite.SqliteValue) (int64, error) {
	result, err := database.db.Exec(sql, params...)
	reportStorageError("run_counted", err)
	if err != nil {
		return 0, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return changed, nil
}

func (database *sqliteDatabase) Get(sql string, params ...chordsqlite.SqliteValue) (chordsqlite.SqliteRow, error) {
	rows, err := database.db.Query(sql, params...)
	if err != nil {
		reportStorageError("get", err)
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	return scanRow(rows)
}

func (database *sqliteDatabase) All(sql string, params ...chordsqlite.SqliteValue) ([]chordsqlite.SqliteRow, error) {
	rows, err := database.db.Query(sql, params...)
	if err != nil {
		reportStorageError("get", err)
		return nil, err
	}
	defer rows.Close()
	collected := []chordsqlite.SqliteRow{}
	for rows.Next() {
		row, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		collected = append(collected, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return collected, nil
}

func (database *sqliteDatabase) Transaction(callback func(transaction chordsqlite.SqliteExecutor) error) error {
	database.transactions.Lock()
	defer database.transactions.Unlock()
	tx, err := database.db.Begin()
	if err != nil {
		reportStorageError("begin", err)
		return err
	}
	handle := &sqliteTransaction{tx: tx}
	if err := callback(handle); err != nil {
		reportStorageError("commit", err)
		if rollbackErr := tx.Rollback(); rollbackErr != nil {
			return fmt.Errorf("durable transaction failed: %w (rollback failed: %v)", err, rollbackErr)
		}
		return err
	}
	if err := tx.Commit(); err != nil {
		reportStorageError("commit", err)
		return err
	}
	return nil
}

func (database *sqliteDatabase) Close() error {
	return database.db.Close()
}

type sqliteTransaction struct {
	tx *sql.Tx
}

var _ chordsqlite.SqliteExecutor = (*sqliteTransaction)(nil)

func (transaction *sqliteTransaction) Exec(sql string) error {
	_, err := transaction.tx.Exec(sql)
	return err
}

func (transaction *sqliteTransaction) Run(sql string, params ...chordsqlite.SqliteValue) error {
	_, err := transaction.tx.Exec(sql, params...)
	return err
}

func (transaction *sqliteTransaction) RunCounted(sql string, params ...chordsqlite.SqliteValue) (int64, error) {
	result, err := transaction.tx.Exec(sql, params...)
	if err != nil {
		return 0, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return changed, nil
}

func (transaction *sqliteTransaction) Get(sql string, params ...chordsqlite.SqliteValue) (chordsqlite.SqliteRow, error) {
	rows, err := transaction.tx.Query(sql, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	return scanRow(rows)
}

func (transaction *sqliteTransaction) All(sql string, params ...chordsqlite.SqliteValue) ([]chordsqlite.SqliteRow, error) {
	rows, err := transaction.tx.Query(sql, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	collected := []chordsqlite.SqliteRow{}
	for rows.Next() {
		row, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		collected = append(collected, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return collected, nil
}

func scanRow(rows *sql.Rows) (chordsqlite.SqliteRow, error) {
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	values := make([]any, len(columns))
	pointers := make([]any, len(columns))
	for index := range values {
		pointers[index] = &values[index]
	}
	if err := rows.Scan(pointers...); err != nil {
		return nil, err
	}
	row := chordsqlite.SqliteRow{}
	for index, column := range columns {
		row[column] = values[index]
	}
	return row, nil
}
