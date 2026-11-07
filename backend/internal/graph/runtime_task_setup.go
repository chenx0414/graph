package graph

import (
	"encoding/hex"
	"os"
	"strings"
	"sync"

	"crypto/sha256"
)

const TASK_SETUP_REUSE = "GRAPH_REUSE_TASK_SETUP"

func taskSetupReuseEnabled() bool {
	return strings.TrimSpace(os.Getenv(TASK_SETUP_REUSE)) == "1"
}

func taskSetupDigest(setup string) string {
	sum := sha256.Sum256([]byte(setup))
	return hex.EncodeToString(sum[:])
}

type TaskSetupLedger struct {
	mutex   sync.Mutex
	entries map[string]taskSetupEntry
}

type taskSetupEntry struct {
	sessionId string
	digest    string
}

func NewTaskSetupLedger() *TaskSetupLedger {
	return &TaskSetupLedger{entries: map[string]taskSetupEntry{}}
}

func (ledger *TaskSetupLedger) Sent(instanceId string, sessionId string, setup string) bool {
	if ledger == nil || instanceId == "" || sessionId == "" || setup == "" {
		return false
	}
	ledger.mutex.Lock()
	defer ledger.mutex.Unlock()
	entry, known := ledger.entries[instanceId]
	if !known || entry.sessionId != sessionId {
		return false
	}
	return entry.digest == taskSetupDigest(setup)
}

func (ledger *TaskSetupLedger) Record(instanceId string, sessionId string, setup string) {
	if ledger == nil || instanceId == "" || sessionId == "" || setup == "" {
		return
	}
	ledger.mutex.Lock()
	defer ledger.mutex.Unlock()
	ledger.entries[instanceId] = taskSetupEntry{sessionId: sessionId, digest: taskSetupDigest(setup)}
}

func (ledger *TaskSetupLedger) Forget(instanceId string) {
	if ledger == nil || instanceId == "" {
		return
	}
	ledger.mutex.Lock()
	defer ledger.mutex.Unlock()
	delete(ledger.entries, instanceId)
}

func taskSetupOmittedPrompt(briefing string, setupLength int) string {
	if setupLength <= 0 || setupLength > len(briefing) {
		return briefing
	}
	head := strings.TrimRight(briefing[:len(briefing)-setupLength], "\n")
	return head + "\n(The task setup is unchanged from the previous turn: bound capabilities, catalog and system context.)"
}
