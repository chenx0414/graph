package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"sync"
)

// TASK_SETUP_REUSE is the switch that lets a session keep the task setup it
// already read instead of reading it again.
//
// The setup is the description of the environment the task runs in: the bound
// capabilities, the catalog and the system context. It is the same text in
// every operation of a task. The session reads it once, but the operation
// prompt carries it every time, and the prompt is part of the transcript that
// the session reads again with every request. A task of sixty operations
// therefore carried sixty copies of the same text, and every request of every
// operation paid for all sixty.
//
// It is off unless the environment names it, because how often the model needs
// to be reminded of its environment is a question only a comparison can answer.
const TASK_SETUP_REUSE = "GRAPH_REUSE_TASK_SETUP"

// taskSetupReuseEnabled reports whether the experiment is on.
func taskSetupReuseEnabled() bool {
	return strings.TrimSpace(os.Getenv(TASK_SETUP_REUSE)) == "1"
}

// taskSetupDigest is the identity of one setup text.
func taskSetupDigest(setup string) string {
	sum := sha256.Sum256([]byte(setup))
	return hex.EncodeToString(sum[:])
}

// TaskSetupLedger remembers which task setup a session already read.
//
// The ledger lives in the daemon's memory. A daemon that restarts forgets, and
// the setup is sent again: the session behind a restarted daemon may have kept
// its context, and a setup that is read twice costs a little more than a setup
// that is read once and not at all.
type TaskSetupLedger struct {
	mutex   sync.Mutex
	entries map[string]taskSetupEntry
}

// taskSetupEntry is what one session's context carries.
type taskSetupEntry struct {
	sessionId string
	digest    string
}

// NewTaskSetupLedger is an empty ledger.
func NewTaskSetupLedger() *TaskSetupLedger {
	return &TaskSetupLedger{entries: map[string]taskSetupEntry{}}
}

// Sent reports whether the session still carries this setup.
//
// The session is named by its session id: a fresh session has read nothing, so
// its setup is not there. The digest says which text the session read.
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

// Record notes that the session carries this setup.
func (ledger *TaskSetupLedger) Record(instanceId string, sessionId string, setup string) {
	if ledger == nil || instanceId == "" || sessionId == "" || setup == "" {
		return
	}
	ledger.mutex.Lock()
	defer ledger.mutex.Unlock()
	ledger.entries[instanceId] = taskSetupEntry{sessionId: sessionId, digest: taskSetupDigest(setup)}
}

// Forget notes that the session's context no longer carries the setup.
//
// A compaction replaces the context that held it. The setup is sent again
// after that, and the session has it again once that send succeeds.
func (ledger *TaskSetupLedger) Forget(instanceId string) {
	if ledger == nil || instanceId == "" {
		return
	}
	ledger.mutex.Lock()
	defer ledger.mutex.Unlock()
	delete(ledger.entries, instanceId)
}

// taskSetupOmittedPrompt is the briefing without the setup the session read already.
func taskSetupOmittedPrompt(briefing string, setupLength int) string {
	if setupLength <= 0 || setupLength > len(briefing) {
		return briefing
	}
	head := strings.TrimRight(briefing[:len(briefing)-setupLength], "\n")
	return head + "\n(The task setup is unchanged from the previous turn: bound capabilities, catalog and system context.)"
}
