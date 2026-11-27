package appinstall

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func asExitError(err error, target **ExitError) bool {
	return errors.As(err, target)
}

func preflightInstall(options InstallOptions) error {
	active, err := unsettledOperations(options.StateDir)
	if err != nil {
		return &ExitError{Code: ExitDeferred, Message: fmt.Sprintf("cannot read %s: %v", options.StateDir, err)}
	}
	if active == 0 {
		return nil
	}
	return &ExitError{Code: ExitDeferred, Message: fmt.Sprintf(
		"%d operation(s) have not settled, so replacing %s would end them; run this again once they finish",
		active, options.Dest)}
}

func unsettledOperations(stateDir string) (int, error) {
	if stateDir == "" {
		return 0, nil
	}
	path := filepath.Join(stateDir, "tasks.sqlite")
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	db, err := sql.Open("sqlite", path+"?mode=ro")
	if err != nil {
		return 0, err
	}
	defer db.Close()
	var active int
	err = db.QueryRow(`SELECT COUNT(*) FROM operations
        WHERE settled_at IS NULL AND state IN ('intent','prepared','dispatched','running','failed')`).Scan(&active)
	if err != nil {
		return 0, err
	}
	return active, nil
}
