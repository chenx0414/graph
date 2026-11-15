package graph

import (
	"encoding/json"
	"fmt"
)

func conversationTrajectorySignature(store *TaskStore, conversationId string) string {
	anchor := ""
	if row := kernelRow(store.Db, "SELECT anchor_task_id FROM conversations WHERE id=?", conversationId); row != nil {
		anchor = kernelString(row["anchor_task_id"])
	}
	latest := func(table string) int64 {
		return kernelInt(kernelRow(store.Db, "SELECT COALESCE(MAX(rowid),0) AS latest FROM "+table)["latest"])
	}
	return fmt.Sprintf("%s|%d|%d|%d|%d|%d|%d|%d|%d|%d",
		anchor, latest("messages"), latest("invocations"), latest("tool_calls"), latest("events"),
		latest("node_entries"), latest("nodes"), latest("instances"), latest("artifacts"), latest("agents"))
}

func StoreConversationTrajectory(store *TaskStore, conversationId string, trajectory *ConversationTrajectory) {
	if trajectory.TaskId == "" {
		return
	}
	payload, err := json.Marshal(trajectory)
	if err != nil {
		return
	}
	signature := conversationTrajectorySignature(store, conversationId)
	if _, err := store.DB.Exec(`INSERT INTO trajectories(conversation_id,task_id,updated_at,payload,signature) VALUES(?,?,?,?,?)
		ON CONFLICT(conversation_id) DO UPDATE SET task_id=excluded.task_id, updated_at=excluded.updated_at,
		payload=excluded.payload, signature=excluded.signature`,
		conversationId, trajectory.TaskId, NowMillis(), string(payload), signature); err != nil {
		panic(err)
	}
}

func LoadConversationTrajectory(store *TaskStore, conversationId string) ([]byte, bool) {
	row := kernelRow(store.Db, "SELECT payload,signature FROM trajectories WHERE conversation_id=?", conversationId)
	if row == nil {
		return nil, false
	}
	if kernelString(row["signature"]) == "" || kernelString(row["signature"]) != conversationTrajectorySignature(store, conversationId) {
		return nil, false
	}
	return []byte(kernelString(row["payload"])), true
}
