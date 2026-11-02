package graph

import (
	"encoding/json"
	"sync"
)

// Only the report is bounded: it is what gets persisted in the conversation and
// shown in the UI. File contents are not capped - the change set already travels
// through a single model tool call, and a large file is a legitimate change.
const RSI_MAX_REPORT_DIFF = 40_000

const RSI_CHECK_TIMEOUT_MS = 15 * 60 * 1000

// RSI_ASYNC_FULL_TIMEOUT_MS bounds the slow confirmation that runs after a
// reload. It is generous because the point of running it in the background is
// that nobody is waiting on it.
const RSI_ASYNC_FULL_TIMEOUT_MS = 60 * 60 * 1000

const RSI_BUILD_TIMEOUT_MS = 20 * 60 * 1000

// RsiCommand is one check command. The runtime only runs node.
type RsiCommand struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

// RsiFileEdit is one replacement inside a file.
type RsiFileEdit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

// RsiFileChange is one file the change set touches.
type RsiFileChange struct {
	Path    string        `json:"path"`
	Action  string        `json:"action"`
	Content *string       `json:"content,omitempty"`
	Edits   []RsiFileEdit `json:"edits,omitempty"`
	From    *string       `json:"from,omitempty"`
	// FromPath takes the new content from a file already in the checkout, so a
	// file the Agent wrote and ran itself is committed byte for byte instead of
	// being retyped into the call.
	FromPath *string `json:"fromPath,omitempty"`
}

// RsiChangeInput is one self-improvement request.
type RsiChangeInput struct {
	Title     string          `json:"title"`
	Problem   string          `json:"problem"`
	Evidence  *string         `json:"evidence,omitempty"`
	Diagnosis *string         `json:"diagnosis,omitempty"`
	Impact    *string         `json:"impact,omitempty"`
	Risk      *string         `json:"risk,omitempty"`
	Changes   []RsiFileChange `json:"changes"`
	Checks    []RsiCommand    `json:"checks,omitempty"`
	Activate  *bool           `json:"activate,omitempty"`
	// Force reloads even while other operations are still running; it may interrupt them.
	Force bool `json:"force,omitempty"`
}

// RsiValidationResult is the verdict of one check.
type RsiValidationResult struct {
	Command string `json:"command"`
	Status  string `json:"status"`
	Output  string `json:"output"`
	// Environment marks a failure the environment explains - a dropped download,
	// a proxy the machine cannot reach, a socket that never opened - rather than
	// a broken change. The verdict still fails, because a gate that passed
	// nowhere is not evidence; the flag is what lets the caller tell the user
	// which of the two happened, and keeps a later automatic follow-up from
	// chasing an outage as if it were a regression.
	Environment bool `json:"environment,omitempty"`
}

// RsiReceiptActivation is the activation state a receipt carries.
type RsiReceiptActivation struct {
	State       string `json:"state"`
	ConfirmedAt *int64 `json:"confirmedAt,omitempty"`
	Generation  *int64 `json:"generation,omitempty"`
}

// RsiReceipt is what one applied change reports.
type RsiReceipt struct {
	Id              string                `json:"id"`
	Status          string                `json:"status"`
	Title           string                `json:"title"`
	Root            *string               `json:"root"`
	Branch          *string               `json:"branch"`
	Commit          *string               `json:"commit"`
	Files           []string              `json:"files"`
	Validation      []RsiValidationResult `json:"validation"`
	RestartRequired bool                  `json:"restartRequired"`
	Activation      *RsiReceiptActivation `json:"activation,omitempty"`
	Force           bool                  `json:"force,omitempty"`
	// PendingFiles are files left uncommitted by this or an earlier failed attempt, still fixable.
	PendingFiles []string `json:"pendingFiles,omitempty"`
	Error        *string  `json:"error,omitempty"`
	Diff         *string  `json:"diff,omitempty"`
	// Adopted are paths this change writes that were already uncommitted in the
	// checkout before it ran (the Agent's own draft, verified and then committed).
	Adopted []string `json:"adopted,omitempty"`
	Report       string   `json:"report"`
	// OutputPath is the full check output for this attempt, written outside the receipt the
	// conversation stores.
	OutputPath *string `json:"outputPath,omitempty"`
}

// RsiActivation is what a turn that changed the harness itself did, in the reviewer's terms.
//
// An activation turn has no assistant reply: `apply_rsi_change(activate:true)` ends the turn and the
// model is never asked again. So the change is the material - its title, the report that says why it
// was needed, the files it moved and what the gate said - never the reload receipt, which only names a
// request id. The receipt crosses the tool boundary as JSON, so every field is read defensively.
type RsiActivation struct {
	State string `json:"state"`
	// Note is one honest sentence for the report, so a reader need not go to the filesystem.
	Note string `json:"note"`
}

// RsiActivationInput is what describeActivation reads.
type RsiActivationInput struct {
	Commit *string
	// CommittedNow reports whether THIS call created the commit. A pre-existing HEAD is not a delivery.
	CommittedNow bool
	Activate     bool
	// Live reports whether the daemon already runs commit.
	Live bool
}

// RsiPendingRestart is a reload the host has not confirmed yet.
type RsiPendingRestart struct {
	Id          string  `json:"id"`
	Root        string  `json:"root"`
	Branch      *string `json:"branch"`
	Commit      *string `json:"commit"`
	RequestedAt int64   `json:"requestedAt"`
	Generation  *int64  `json:"generation,omitempty"`
	Force       bool    `json:"force,omitempty"`
}

// RsiSyncEntry is one branch and the copy it was published to.
type RsiSyncEntry struct {
	Branch   string `json:"branch"`
	Upstream string `json:"upstream"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
}

// RsiSyncState is where the checkout stands against the branches it has already published.
type RsiSyncState struct {
	// Unpublished are branches that are ahead of the copy they were published to.
	Unpublished []RsiSyncEntry `json:"unpublished"`
	// Expected are self-improvement work branches, which have no publisher by design.
	Expected  []RsiSyncEntry `json:"expected"`
	LocalOnly int            `json:"localOnly"`
	// Deploy is how the checkout the app runs from compares to the development checkout.
	Deploy *DeployDriftReport `json:"deploy,omitempty"`
	// Note is one line a reader can act on without reading the list.
	Note string `json:"note"`
	// deployCompared records that the caller asked for the checkout comparison. TypeScript
	// emitted `deploy: null` when the comparison ran and found nothing, so the key has to
	// survive a nil value.
	deployCompared bool
}

// MarshalJSON keeps the TypeScript key order and the `deploy: null` case.
func (state RsiSyncState) MarshalJSON() ([]byte, error) {
	type syncWire struct {
		Unpublished []RsiSyncEntry  `json:"unpublished"`
		Expected    []RsiSyncEntry  `json:"expected"`
		LocalOnly   int             `json:"localOnly"`
		Deploy      json.RawMessage `json:"deploy,omitempty"`
		Note        string          `json:"note"`
	}
	wire := syncWire{Unpublished: state.Unpublished, Expected: state.Expected, LocalOnly: state.LocalOnly, Note: state.Note}
	if state.deployCompared {
		if state.Deploy == nil {
			wire.Deploy = json.RawMessage("null")
		} else {
			raw, err := json.Marshal(state.Deploy)
			if err != nil {
				return nil, err
			}
			wire.Deploy = raw
		}
	}
	return json.Marshal(wire)
}

// RsiOperation is one in-flight operation that keeps a normal reload waiting.
type RsiOperation struct {
	Id             string  `json:"id"`
	TaskId         string  `json:"taskId"`
	NodeId         string  `json:"nodeId"`
	State          string  `json:"state"`
	Request        string  `json:"request"`
	ConversationId *string `json:"conversationId"`
	Archived       bool    `json:"archived"`
}

// RsiLastActivation is the last confirmed reload.
type RsiLastActivation struct {
	Id          string  `json:"id"`
	Commit      *string `json:"commit"`
	ConfirmedAt int64   `json:"confirmedAt"`
	Generation  int     `json:"generation"`
}

// RsiStatus is the whole self-improvement surface as one read.
//
// The field order is the TypeScript object literal order, because the desktop app and the
// e2e suite compare the serialized body.
type RsiStatus struct {
	Available bool    `json:"available"`
	Root      *string `json:"root"`
	Branch    *string `json:"branch"`
	// Reason says why RSI is unavailable, when it is.
	Reason *string `json:"reason,omitempty"`
	// Sync is where the checkout stands against the branches it has published.
	Sync           *RsiSyncState      `json:"sync"`
	PendingRestart *RsiPendingRestart `json:"pendingRestart"`
	// LastActivation is the last confirmed reload.
	LastActivation   *RsiLastActivation `json:"lastActivation"`
	ActiveOperations int                `json:"activeOperations"`
	Operations       []RsiOperation     `json:"operations"`
	// OperationsKnown is false when the operation ledger could not be read, so a reload must wait.
	OperationsKnown bool `json:"operationsKnown"`
	CanRestart      bool `json:"canRestart"`
}

// RsiValidateInput is what a validation hook receives.
type RsiValidateInput struct {
	Root       string
	Checks     []RsiCommand
	Activate   bool
	NeedsBuild bool
}

// RsiValidateFunc runs the gate for one change set.
type RsiValidateFunc func(input RsiValidateInput) []RsiValidationResult

// RsiServiceOptions configures one self-improvement service.
type RsiServiceOptions struct {
	// Root is the Graph source checkout. Absent means the service is unavailable.
	Root *string
	// StateDir holds the restart marker, the working list and the check reports.
	StateDir string
	// Validate replaces the default gate. Absent means the project's own gate runs.
	Validate RsiValidateFunc
}

// RsiApplyContext is the identity one applied change is recorded against.
type RsiApplyContext struct {
	OperationId    *string
	Store          *TaskStore
	TaskId         string
	ConversationId *string
}

// RsiAckRestart is the answer to a reload confirmation.
type RsiAckRestart struct {
	Cleared        bool               `json:"cleared"`
	PendingRestart *RsiPendingRestart `json:"pendingRestart"`
}

// ValidationCommandPlan is the executable, arguments and environment one check runs with.
type ValidationCommandPlan struct {
	Executable string
	Args       []string
	Env        map[string]string
}

// RsiService is the recursive self-improvement service for one checkout.
type RsiService struct {
	// Root is the source checkout, when one was configured.
	Root *string
	// Available is true when the root is a usable Graph Git checkout right now.
	Available bool

	stateDir      string
	validate      RsiValidateFunc
	runningCommit *string
	mu            sync.Mutex
	changing      bool
	// asyncFull remembers which activations already started their background
	// confirmation, so a repeated acknowledgement does not run the suite twice.
	asyncFull sync.Map
}
