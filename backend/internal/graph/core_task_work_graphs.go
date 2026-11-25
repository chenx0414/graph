package graph

import "encoding/json"

type WorkGraph struct {
	WorkID          string         `json:"workId"`
	GraphKey        string         `json:"graphKey"`
	WorkRevision    int64          `json:"workRevision"`
	Version         int64          `json:"version"`
	DraftRevision   int64          `json:"draftRevision"`
	TargetBranch    *string        `json:"targetBranch"`
	GraphID         *string        `json:"graphId"`
	State           string         `json:"state"`
	Reason          *string        `json:"reason"`
	OwnerTaskID     string         `json:"ownerTaskId"`
	KernelRequestID string         `json:"kernelRequestId"`
	Proposal        map[string]any `json:"proposal"`
	ProposalDigest  string         `json:"proposalDigest"`
}

func (s *TaskStore) insertWorkGraph(item WorkGraph, now int64) {
	kernelExec(s.Db, `INSERT INTO work_graphs(work_id,graph_key,work_revision,draft_version,draft_revision,target_branch,proposal,proposal_digest,owner_task_id,kernel_request_id,state,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,'preparing',?,?)`, item.WorkID, item.GraphKey, item.WorkRevision, item.Version, item.DraftRevision, item.TargetBranch, CanonicalJSON(item.Proposal), item.ProposalDigest, item.OwnerTaskID, item.KernelRequestID, now, now)
}

func (s *TaskStore) settleWorkGraph(workID, key, graphID, state string, reason *string, now int64) {
	kernelExec(s.Db, "UPDATE work_graphs SET graph_id=?,state=?,reason=?,updated_at=? WHERE work_id=? AND graph_key=?", graphID, state, reason, now, workID, key)
}

func (s *TaskStore) workGraphInTransaction(workID, key string) *WorkGraph {
	row := kernelRow(s.Db, "SELECT * FROM work_graphs WHERE work_id=? AND graph_key=?", workID, key)
	if row == nil {
		return nil
	}
	var proposal map[string]any
	if err := json.Unmarshal([]byte(kernelString(row["proposal"])), &proposal); err != nil {
		panic(err)
	}
	return &WorkGraph{WorkID: workID, GraphKey: key, WorkRevision: kernelInt(row["work_revision"]), Version: kernelInt(row["draft_version"]), DraftRevision: kernelInt(row["draft_revision"]), TargetBranch: conversationNullableString(row["target_branch"]), GraphID: conversationNullableString(row["graph_id"]), State: kernelString(row["state"]), Reason: conversationNullableString(row["reason"]), OwnerTaskID: kernelString(row["owner_task_id"]), KernelRequestID: kernelString(row["kernel_request_id"]), Proposal: proposal, ProposalDigest: kernelString(row["proposal_digest"])}
}

func (s *TaskStore) WorkGraphs(workID string) []WorkGraph {
	var items []WorkGraph
	s.ReadSnapshot(func(store *TaskStore) {
		store.workInTransaction(workID)
		for _, row := range kernelRows(store.Db, "SELECT graph_key FROM work_graphs WHERE work_id=? ORDER BY created_at,graph_key", workID) {
			items = append(items, *store.workGraphInTransaction(workID, kernelString(row["graph_key"])))
		}
	})
	return items
}

func (s *TaskStore) PreparingWorkGraphs() []WorkGraph {
	var out []WorkGraph
	s.ReadSnapshot(func(store *TaskStore) {
		for _, row := range kernelRows(store.Db, `SELECT g.work_id,g.graph_key FROM work_graphs g JOIN work_requests w ON w.id=g.work_id
 WHERE g.state='preparing' AND w.execution_paused=0 ORDER BY g.created_at,g.work_id,g.graph_key`) {
			item := store.workGraphInTransaction(kernelString(row["work_id"]), kernelString(row["graph_key"]))
			if item != nil {
				out = append(out, *item)
			}
		}
	})
	return out
}
