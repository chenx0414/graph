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

// reportStorageError writes one storage failure to the daemon's error stream.
//
// The kernel and the daemon share one SQLite file. A write that loses the race
// against the daemon's own writer must be visible: a silent storage error
// reads like a lost turn.
func reportStorageError(operation string, err error) {
	if err == nil {
		return
	}
	_, _ = os.Stderr.WriteString("pig kernel: durable storage " + operation + " failed: " + err.Error() + "\n")
}

// The Graph daemon owns the formal SQLite database. The durable kernel needs
// its own connection to the same file: the daemon writes domain facts, the
// kernel writes the durable namespace, and neither may close the other's
// handle.
//
// PiG ships drivers for Node and Cloudflare only. The Graph daemon already
// speaks to SQLite through modernc.org/sqlite, so the kernel adapts that
// driver to PiG's portable database facade instead of pulling in a second one.

type sqliteDatabase struct {
	db *sql.DB
	// transactions serializes them. The facade requires that unrelated work
	// waits for the running transaction instead of interleaving with it.
	transactions sync.Mutex
}

var _ chordsqlite.SqliteDatabase = (*sqliteDatabase)(nil)

// openSqliteDatabase opens one connection to the Graph database the way the
// daemon opens it: a single connection, foreign keys on, WAL, and a bounded
// busy wait so a durable write never blocks the daemon's own writer forever.
//
// The kernel's transactions take the write lock when they start. A deferred
// transaction that starts as a reader and later writes cannot wait for the
// daemon's own writer: SQLite refuses the upgrade at once instead of running
// the busy handler, and the durable write fails with SQLITE_BUSY. An
// immediate transaction waits instead, so the two writers queue.
func openSqliteDatabase(path string) (*sqliteDatabase, error) {
	db, err := sql.Open("sqlite", kernelDatabaseDSN(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	return &sqliteDatabase{db: db}, nil
}

// kernelDatabaseDSN is the connection string of the kernel's own connection.
//
// The pragmas travel with the connection string, so every connection of the
// pool carries them: a busy timeout set on one connection only protects that
// connection.
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

// Transaction runs the callback in one immediate transaction. The callback must
// use the handle it is given: the database has a single connection, so a
// statement issued on the database itself would wait for the transaction that
// is waiting for it.
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

// Close releases the connection. It never touches a connection the daemon owns.
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

// scanRow reads one row into the portable shape: INTEGER, REAL, TEXT, BLOB and
// NULL keep their SQLite types.
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
