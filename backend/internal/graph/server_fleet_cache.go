package graph

import (
	"fmt"
	"strings"
	"sync"
)

type fleetSnapshot struct {
	signature string
	body      []byte
}

var fleetSnapshots = struct {
	sync.Mutex
	values map[string]fleetSnapshot
}{values: map[string]fleetSnapshot{}}

func fleetSignature(store *TaskStore, conversationId string) string {
	events := kernelInt(kernelRow(store.Db, "SELECT COALESCE(MAX(cursor),0) AS cursor FROM events")["cursor"])
	messages := kernelInt(kernelRow(store.Db, "SELECT COALESCE(MAX(seq),0) AS seq FROM messages")["seq"])
	invocations := kernelInt(kernelRow(store.Db, "SELECT COALESCE(MAX(rowid),0) AS rowid FROM invocations")["rowid"])
	tasks := kernelInt(kernelRow(store.Db, "SELECT COUNT(*) AS count FROM tasks")["count"])
	artifacts := int64(0)
	if graphTableExists(store.Db, "artifacts") {
		artifacts = kernelInt(kernelRow(store.Db, "SELECT COUNT(*) AS count FROM artifacts")["count"])
	}
	return fmt.Sprintf("%s:%d:%d:%d:%d:%d", conversationId, events, messages, invocations, tasks, artifacts)
}

func fleetSnapshotsForget(store *TaskStore) {
	if store == nil {
		return
	}
	prefix := fmt.Sprintf("%p|", store)
	fleetSnapshots.Lock()
	defer fleetSnapshots.Unlock()
	for key := range fleetSnapshots.values {
		if strings.HasPrefix(key, prefix) {
			delete(fleetSnapshots.values, key)
		}
	}
}

func fleetPayloadCached(store *TaskStore, conversationId string) []byte {	signature := fleetSignature(store, conversationId)
	key := fmt.Sprintf("%p|%s", store, conversationId)
	fleetSnapshots.Lock()
	if cached, ok := fleetSnapshots.values[key]; ok && cached.signature == signature {
		body := cached.body
		fleetSnapshots.Unlock()
		return body
	}
	fleetSnapshots.Unlock()
	body := fleetPayload(store, conversationId)
	fleetSnapshots.Lock()
	fleetSnapshots.values[key] = fleetSnapshot{signature: signature, body: body}
	fleetSnapshots.Unlock()
	return body
}
