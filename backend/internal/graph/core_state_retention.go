package graph

// graph:table-writes-exempt: a retention sweep is one fact about many tables

import (
	"fmt"

	"database/sql"
)

// RetentionOptions is the conservative reclaim window for one task database.
type RetentionOptions struct {
	Now                      int64
	KeepEventsPerTask        int
	KeepCapabilitiesPerNode  int
	KeepHandoffsPerOperation int
	MinAgeMs                 int64
}

// RetentionPlan is what apply would delete.
type RetentionPlan struct {
	Events       int
	Capabilities int
	Handoffs     int
	Bytes        int
}

// RetentionApplied is the row counts actually deleted.
type RetentionApplied struct {
	Events       int
	Capabilities int
	Handoffs     int
}

func retentionInteger(value int64, name string) int64 {
	if value < 0 {
		panic(fmt.Errorf("%s must be a non-negative integer", name))
	}
	return value
}

func eligibleTaskSQL(options RetentionOptions) string {
	cutoff := options.Now - retentionInteger(options.MinAgeMs, "minAgeMs")
	return fmt.Sprintf(`SELECT t.id FROM tasks t
      WHERE NOT EXISTS (SELECT 1 FROM operations o WHERE o.task_id = t.id AND o.state IN ('dispatched'))
        AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id)
        AND (SELECT MAX(e.timestamp) FROM events e WHERE e.task_id = t.id) <= %d`, cutoff)
}

func rankSQL(table, partition, order, idColumn, eligible string) string {
	return fmt.Sprintf(`SELECT %s AS id FROM (
      SELECT %s, row_number() OVER (PARTITION BY %s ORDER BY %s DESC) AS rank
      FROM %s WHERE task_id IN (%s)
    ) WHERE rank > `, idColumn, idColumn, partition, order, table, eligible)
}

type retentionDoomed struct {
	events       string
	capabilities string
	handoffs     string
}

func doomed(options RetentionOptions) retentionDoomed {
	eligible := eligibleTaskSQL(options)
	return retentionDoomed{
		events: fmt.Sprintf(`SELECT cursor AS id, length(data) AS size FROM (
        SELECT cursor, data, type, row_number() OVER (PARTITION BY task_id ORDER BY cursor DESC) AS rank
        FROM events WHERE task_id IN (%s)
      ) WHERE rank > %d
        AND type NOT IN ('task.created', 'requirement.changed')`, eligible, retentionInteger(int64(options.KeepEventsPerTask), "keepEventsPerTask")),
		capabilities: rankSQL("node_capabilities", "task_id, node_id", "seq", "seq", eligible) + fmt.Sprint(retentionInteger(int64(options.KeepCapabilitiesPerNode), "keepCapabilitiesPerNode")),
		handoffs:     rankSQL("context_handoffs", "operation_id", "version", "id", eligible) + fmt.Sprint(retentionInteger(int64(options.KeepHandoffsPerOperation), "keepHandoffsPerOperation")),
	}
}

// PlanRetention counts doomed rows without deleting them.
func PlanRetention(db *sql.DB, options RetentionOptions) RetentionPlan {
	sqlText := doomed(options)
	var events, bytes, capabilities, handoffs int
	if err := db.QueryRow(fmt.Sprintf("SELECT count(*) AS rows, COALESCE(sum(size),0) AS bytes FROM (%s)", sqlText.events)).Scan(&events, &bytes); err != nil {
		panic(err)
	}
	if err := db.QueryRow(fmt.Sprintf("SELECT count(*) AS rows FROM (%s)", sqlText.capabilities)).Scan(&capabilities); err != nil {
		panic(err)
	}
	if err := db.QueryRow(fmt.Sprintf("SELECT count(*) AS rows FROM (%s)", sqlText.handoffs)).Scan(&handoffs); err != nil {
		panic(err)
	}
	return RetentionPlan{Events: events, Capabilities: capabilities, Handoffs: handoffs, Bytes: bytes}
}

// ApplyRetention deletes the doomed rows inside BEGIN IMMEDIATE.
func ApplyRetention(db *sql.DB, options RetentionOptions) RetentionApplied {
	sqlText := doomed(options)
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	applied, err := applyRetentionLocked(db, sqlText)
	if err != nil {
		_, _ = db.Exec("ROLLBACK")
		panic(err)
	}
	if _, err := db.Exec("COMMIT"); err != nil {
		_, _ = db.Exec("ROLLBACK")
		panic(err)
	}
	return applied
}

// ApplyRetention deletes the doomed rows of one store.
//
// The deletes take the store's transaction lock, so they cannot interleave
// with another writer's transaction: the reclaim runs inside a daemon that
// keeps writing.
func (s *TaskStore) ApplyRetention(options RetentionOptions) RetentionApplied {
	s.txMu.Lock()
	defer s.txMu.Unlock()
	return ApplyRetention(s.DB, options)
}

func applyRetentionLocked(db *sql.DB, sqlText retentionDoomed) (RetentionApplied, error) {
	events, err := execChanges(db, fmt.Sprintf("DELETE FROM events WHERE cursor IN (SELECT id FROM (%s))", sqlText.events))
	if err != nil {
		return RetentionApplied{}, err
	}
	capabilities, err := execChanges(db, fmt.Sprintf("DELETE FROM node_capabilities WHERE seq IN (%s)", sqlText.capabilities))
	if err != nil {
		return RetentionApplied{}, err
	}
	handoffs, err := execChanges(db, fmt.Sprintf("DELETE FROM context_handoffs WHERE id IN (%s)", sqlText.handoffs))
	if err != nil {
		return RetentionApplied{}, err
	}
	return RetentionApplied{Events: events, Capabilities: capabilities, Handoffs: handoffs}, nil
}

func execChanges(db *sql.DB, query string) (int, error) {
	result, err := db.Exec(query)
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(count), nil
}
