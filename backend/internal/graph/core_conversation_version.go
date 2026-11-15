package graph

import "fmt"

func conversationVersion(store *TaskStore, conversationId string) string {
	conversation := kernelRow(store.Db, `SELECT COALESCE(title,'') AS title,
       COALESCE(archived_at,0) AS archivedAt, COALESCE(binding_since_seq,0) AS bindingSince
    FROM conversations WHERE id=?`, conversationId)
	title, archivedAt, bindingSince := "", int64(0), int64(0)
	if conversation != nil {
		title = kernelString(conversation["title"])
		archivedAt = kernelInt(conversation["archivedAt"])
		bindingSince = kernelInt(conversation["bindingSince"])
	}
	latest := func(query string) int64 {
		return kernelInt(kernelRow(store.Db, query)["latest"])
	}
	countForConversation := func(query string) int64 {
		return kernelInt(kernelRow(store.Db, query, conversationId)["latest"])
	}
	events := latest("SELECT COALESCE(MAX(cursor),0) AS latest FROM events")
	messages := countForConversation("SELECT COALESCE(MAX(seq),0) AS latest FROM messages WHERE conversation_id=?")
	messagesUpdated := countForConversation("SELECT COALESCE(MAX(updated_at),0) AS latest FROM messages WHERE conversation_id=?")
	streams := countForConversation("SELECT COALESCE(MAX(updated_at),0) AS latest FROM conversation_streams WHERE conversation_id=?")
	invocations := latest("SELECT COALESCE(MAX(rowid),0) AS latest FROM invocations")
	artifacts := latest("SELECT COALESCE(MAX(rowid),0) AS latest FROM artifacts")
	tasks := latest("SELECT COUNT(*) AS latest FROM tasks")
	questions := countForConversation(`SELECT COUNT(*) AS latest FROM questions
        WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id=?)`)
	return fmt.Sprintf("v2|%s|%s|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d", conversationId, title, archivedAt, bindingSince,
		events, messages, messagesUpdated, streams, invocations, artifacts, tasks, questions)
}
