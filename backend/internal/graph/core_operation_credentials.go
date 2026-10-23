package graph

import (
	"path/filepath"
	"strings"
)

// validateOperationArtifacts refuses evidence the harness cannot use.
func validateOperationArtifacts(artifacts []ArtifactInput) {
	seen := map[string]bool{}
	for _, artifact := range artifacts {
		seen[artifact.Id] = true
	}
	if len(seen) != len(artifacts) {
		Raise("invalid_evidence", "Artifacts require unique IDs, absolute paths and SHA-256 digests")
	}
	for _, artifact := range artifacts {
		if strings.TrimSpace(artifact.Id) == "" || !filepath.IsAbs(artifact.Path) || !operationDigestPattern.MatchString(artifact.Digest) {
			Raise("invalid_evidence", "Artifacts require unique IDs, absolute paths and SHA-256 digests")
		}
		if (artifact.ArtifactId == nil) != (artifact.Version == nil) {
			Raise("invalid_evidence", "Artifacts require unique IDs, absolute paths and SHA-256 digests")
		}
		if artifact.ArtifactId != nil {
			if strings.TrimSpace(*artifact.ArtifactId) == "" || artifact.Version == nil ||
				!jsSafeInteger(int64(*artifact.Version)) || *artifact.Version < 1 {
				Raise("invalid_evidence", "Artifacts require unique IDs, absolute paths and SHA-256 digests")
			}
		}
	}
}

// OperationSnapshots lists the operations of one task.
func OperationSnapshots(store *TaskStore, taskId string, query OperationQuery) []OperationSnapshot {
	filters := []string{"task_id=?"}
	params := []any{taskId}
	if query.NodeId != nil {
		filters = append(filters, "node_id=?")
		params = append(params, *query.NodeId)
	}
	if query.After != nil || query.Before != nil {
		before := query.Before != nil
		if before {
			filters = append(filters, "rowid<COALESCE((SELECT rowid FROM operations WHERE task_id=? AND id=?),0)")
			params = append(params, taskId, *query.Before)
		} else {
			filters = append(filters, "rowid>COALESCE((SELECT rowid FROM operations WHERE task_id=? AND id=?),0)")
			params = append(params, taskId, *query.After)
		}
	}
	descending := query.Before != nil || (query.Latest && query.After == nil)
	limit := ""
	if query.Limit != nil {
		limit = " LIMIT ?"
		params = append(params, *query.Limit)
	}
	rows := kernelRows(store.Db, "SELECT * FROM operations WHERE "+strings.Join(filters, " AND ")+
		" ORDER BY rowid "+map[bool]string{true: "DESC", false: "ASC"}[descending]+limit, params...)
	if descending {
		for left, right := 0, len(rows)-1; left < right; left, right = left+1, right-1 {
			rows[left], rows[right] = rows[right], rows[left]
		}
	}
	out := make([]OperationSnapshot, 0, len(rows))
	for _, row := range rows {
		snapshot := operationSnapshotOf(row)
		out = append(out, *snapshot)
	}
	return out
}

// NodeOperationRuns lists the operation runs of one node.
func NodeOperationRuns(store *TaskStore, taskId, nodeId string) []OperationRun {
	rows := kernelRows(store.Db, `SELECT id,state,reserved,worker_active,waiting_slot,result,usage,dispatched_at,settled_at,waiting_ms,activation_id
    FROM operations WHERE task_id=? AND node_id=? ORDER BY rowid`, taskId, nodeId)
	out := make([]OperationRun, 0, len(rows))
	for _, row := range rows {
		waitingMs := kernelInt(row["waiting_ms"])
		var runMs *int64
		if row["dispatched_at"] != nil && row["settled_at"] != nil {
			value := kernelInt(row["settled_at"]) - kernelInt(row["dispatched_at"])
			if kernelInt(row["waiting_slot"]) != 0 {
				value -= NowMillis() - kernelInt(row["dispatched_at"])
			} else {
				value -= waitingMs
			}
			if value < 0 {
				value = 0
			}
			runMs = &value
		}
		run := OperationRun{
			Id:           kernelString(row["id"]),
			State:        kernelString(row["state"]),
			WorkerActive: kernelInt(row["worker_active"]) != 0,
			WaitingSlot:  kernelInt(row["waiting_slot"]) != 0,
			Reserved:     kernelInt(row["reserved"]),
			WaitingMs:    waitingMs,
			RunMs:        runMs,
			Result:       nil,
			Usage:        nil,
		}
		if row["activation_id"] != nil {
			value := kernelString(row["activation_id"])
			run.ActivationId = &value
		}
		if row["dispatched_at"] != nil {
			value := kernelInt(row["dispatched_at"])
			run.DispatchedAt = &value
		}
		if row["settled_at"] != nil {
			value := kernelInt(row["settled_at"])
			run.SettledAt = &value
		}
		if text := kernelString(row["result"]); text != "" {
			run.Result = parseJSON(text)
		}
		if text := kernelString(row["usage"]); text != "" {
			run.Usage = parseJSON(text)
		}
		out = append(out, run)
	}
	return out
}

// MarkOperationCredentialWait records that an operation waits for a credential slot.
func MarkOperationCredentialWait(store *TaskStore, operationId string, now ...int64) {
	at := NowMillis()
	if len(now) > 0 {
		at = now[0]
	}
	kernelExec(store.Db, "UPDATE operations SET waiting_slot=1,waiting_since=COALESCE(waiting_since,?) WHERE id=?", at, operationId)
}

// FinishOperationCredentialWait records that the credential slot is free again.
func FinishOperationCredentialWait(store *TaskStore, operationId string, now ...int64) {
	at := NowMillis()
	if len(now) > 0 {
		at = now[0]
	}
	kernelExec(store.Db, `UPDATE operations
    SET waiting_slot=0,waiting_ms=waiting_ms + MAX(0,?-COALESCE(waiting_since,?)),waiting_since=NULL
    WHERE id=?`, at, at, operationId)
}

// ClearOperationCredentialWait drops the credential wait without accounting for it.
func ClearOperationCredentialWait(store *TaskStore, operationId string) {
	kernelExec(store.Db, "UPDATE operations SET waiting_slot=0 WHERE id=?", operationId)
}
