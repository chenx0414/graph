package graph

import (
	"strings"
)

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

type AcceptanceLimitationEntry struct {
	AcceptanceId    string
	Reason          string
	Evidence        string
	Actor           string
	Commit          *string
	RevisionVersion int
	RequestId       *string
}

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

func (k *KernelStore) AcceptanceLimitations(taskID string) []AcceptanceLimitationRow {
	rows := g5Query(k.Db, `SELECT acceptance_id,reason,evidence,actor,commit_sha,revision_version,request_id,created_at
    FROM kernel_acceptance_limitations WHERE task_id=? ORDER BY seq`, taskID)
	out := make([]AcceptanceLimitationRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, acceptanceLimitationRowOf(row))
	}
	return out
}

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
