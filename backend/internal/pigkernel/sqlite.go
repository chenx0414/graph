package pigkernel

import (
	"database/sql"
	"fmt"
	"sync"

	chordsqlite "github.com/MichaelKinsy/PiG/chord/sqlite"
)

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
func openSqliteDatabase(path string) (*sqliteDatabase, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if _, err := db.Exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;`); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &sqliteDatabase{db: db}, nil
}

func (database *sqliteDatabase) Exec(sql string) error {
	_, err := database.db.Exec(sql)
	return err
}

func (database *sqliteDatabase) Run(sql string, params ...chordsqlite.SqliteValue) error {
	_, err := database.db.Exec(sql, params...)
	return err
}

func (database *sqliteDatabase) Get(sql string, params ...chordsqlite.SqliteValue) (chordsqlite.SqliteRow, error) {
	rows, err := database.db.Query(sql, params...)
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

func (database *sqliteDatabase) All(sql string, params ...chordsqlite.SqliteValue) ([]chordsqlite.SqliteRow, error) {
	rows, err := database.db.Query(sql, params...)
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

// Transaction runs the callback in one immediate transaction. The callback must
// use the handle it is given: the database has a single connection, so a
// statement issued on the database itself would wait for the transaction that
// is waiting for it.
func (database *sqliteDatabase) Transaction(callback func(transaction chordsqlite.SqliteExecutor) error) error {
	database.transactions.Lock()
	defer database.transactions.Unlock()
	tx, err := database.db.Begin()
	if err != nil {
		return err
	}
	handle := &sqliteTransaction{tx: tx}
	if err := callback(handle); err != nil {
		if rollbackErr := tx.Rollback(); rollbackErr != nil {
			return fmt.Errorf("durable transaction failed: %w (rollback failed: %v)", err, rollbackErr)
		}
		return err
	}
	return tx.Commit()
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
