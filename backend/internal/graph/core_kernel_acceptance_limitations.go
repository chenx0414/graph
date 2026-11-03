package graph

import (
	"strings"
)

// AcceptanceLimitationRow is one recorded limitation: why one acceptance item
// was allowed to stay unmet, on whose word, and for which version.
//
// The table is append-only. A recorded limitation is history: it is what the
// closure rested on at the commit it names, so nothing rewrites or deletes a
// row. A later version needs a later decision, and the commit on the row is
// what keeps the two apart.
type AcceptanceLimitationRow struct {
	AcceptanceId    string  `json:"acceptanceId"`
	Reason          string  `json:"reason"`
	Evidence        string  `json:"evidence"`
	Actor           string  `json:"actor"`
	Commit          *string `json:"commit"`
	RevisionVersion int     `json:"revisionVersion"`
	RequestId       *string `json:"requestId"`
	CreatedAt       int64   `json:"createdAt"`
}

// AcceptanceLimitationEntry is one limitation to append.
type AcceptanceLimitationEntry struct {
	AcceptanceId    string
	Reason          string
	Evidence        string
	Actor           string
	Commit          *string
	RevisionVersion int
	RequestId       *string
}

// acceptanceLimitationRowOf reads one row of the limitation ledger.
func acceptanceLimitationRowOf(row map[string]any) AcceptanceLimitationRow {
	record := AcceptanceLimitationRow{
		AcceptanceId: kernelString(row["acceptance_id"]), Reason: kernelString(row["reason"]),
		Evidence: kernelString(row["evidence"]), Actor: kernelString(row["actor"]),
		RevisionVersion: int(kernelInt(row["revision_version"])), CreatedAt: kernelInt(row["created_at"]),
	}
	if row["commit_sha"] != nil {
		commit := kernelString(row["commit_sha"])
		record.Commit = &commit
	}
	if row["request_id"] != nil {
		request := kernelString(row["request_id"])
		record.RequestId = &request
	}
	return record
}

// RecordAcceptanceLimitations appends the limitations one decision rests on.
//
// It is the only writer of kernel_acceptance_limitations, and it only ever
// inserts: the row records a decision somebody already made, so a replay of the
// same request must not add a second copy of it.
func (k *KernelStore) RecordAcceptanceLimitations(taskID string, entries []AcceptanceLimitationEntry) []AcceptanceLimitationRow {
	k.tx(func() any {
		created := NowMillis()
		for _, entry := range entries {
			var request any
			if entry.RequestId != nil && strings.TrimSpace(*entry.RequestId) != "" {
				request = *entry.RequestId
			}
			var commit any
			if entry.Commit != nil {
				commit = *entry.Commit
			}
			g5Exec(k.Db, `INSERT OR IGNORE INTO kernel_acceptance_limitations(
        task_id,acceptance_id,reason,evidence,actor,commit_sha,revision_version,request_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
				taskID, entry.AcceptanceId, entry.Reason, entry.Evidence, entry.Actor, commit, entry.RevisionVersion, request, created)
		}
		return nil
	})
	return k.AcceptanceLimitations(taskID)
}

// AcceptanceLimitations reads every limitation recorded for one graph, oldest first.
func (k *KernelStore) AcceptanceLimitations(taskID string) []AcceptanceLimitationRow {
	rows := g5Query(k.Db, `SELECT acceptance_id,reason,evidence,actor,commit_sha,revision_version,request_id,created_at
    FROM kernel_acceptance_limitations WHERE task_id=? ORDER BY seq`, taskID)
	out := make([]AcceptanceLimitationRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, acceptanceLimitationRowOf(row))
	}
	return out
}

// AcceptanceLimitationsOfRequest reads what one request already recorded. It is
// how a replayed request recognises itself instead of recording again.
func (k *KernelStore) AcceptanceLimitationsOfRequest(taskID, requestID string) []AcceptanceLimitationRow {
	if strings.TrimSpace(requestID) == "" {
		return []AcceptanceLimitationRow{}
	}
	rows := g5Query(k.Db, `SELECT acceptance_id,reason,evidence,actor,commit_sha,revision_version,request_id,created_at
    FROM kernel_acceptance_limitations WHERE task_id=? AND request_id=? ORDER BY seq`, taskID, requestID)
	out := make([]AcceptanceLimitationRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, acceptanceLimitationRowOf(row))
	}
	return out
}
