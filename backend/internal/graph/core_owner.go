package graph

import (
	"strings"

	"database/sql"
)

// AcquireOwner holds an OS lock for the owner's entire lifetime.
// No heartbeat timeout can steal a live daemon; process death releases the lock.
// OpenSQLite is wrong here: this file uses DELETE journal mode, not WAL.
func AcquireOwner(path string) func() {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		panic(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if _, err := db.Exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;`); err != nil {
		_ = db.Close()
		if ownerBusy(err) {
			Raise("owner_busy", "Another daemon owns this state directory")
		}
		panic(err)
	}
	released := false
	return func() {
		if released {
			return
		}
		released = true
		_, _ = db.Exec("ROLLBACK")
		_ = db.Close()
	}
}

func ownerBusy(err error) bool {
	if err == nil {
		return false
	}
	text := err.Error()
	return strings.Contains(text, "SQLITE_BUSY") || strings.Contains(text, "database is locked") || strings.Contains(text, "(5)")
}
