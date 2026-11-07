package graph

import (
	"database/sql"

	_ "modernc.org/sqlite"
)

func OpenSQLite(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if _, err := db.Exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;`); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func MustOpenSQLite(path string) *sql.DB {
	db, err := OpenSQLite(path)
	if err != nil {
		Raise("sqlite", err.Error())
	}
	return db
}
