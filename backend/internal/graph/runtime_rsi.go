package graph

import (
	"encoding/json"
	"sync"
)

const RSI_MAX_REPORT_DIFF = 40_000

const RSI_CHECK_TIMEOUT_MS = 15 * 60 * 1000

const RSI_ASYNC_FULL_TIMEOUT_MS = 60 * 60 * 1000

const RSI_BUILD_TIMEOUT_MS = 20 * 60 * 1000

type RsiCommand struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Nice    int      `json:"nice,omitempty"`
}

type RsiFileEdit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

type RsiFileChange struct {
	Path     string        `json:"path"`
	Action   string        `json:"action"`
	Content  *string       `json:"content,omitempty"`
	Edits    []RsiFileEdit `json:"edits,omitempty"`
	From     *string       `json:"from,omitempty"`
	FromPath *string       `json:"fromPath,omitempty"`
}

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
	DryRun    bool            `json:"dryRun,omitempty"`
	Force     bool            `json:"force,omitempty"`
}

type RsiValidationResult struct {
	Command     string `json:"command"`
	Status      string `json:"status"`
	Output      string `json:"output"`
	Environment bool   `json:"environment,omitempty"`
}

type RsiReceiptActivation struct {
	State       string `json:"state"`
	ConfirmedAt *int64 `json:"confirmedAt,omitempty"`
	Generation  *int64 `json:"generation,omitempty"`
}

type RsiAppInstall struct {
	State string `json:"state"`
	Note  string `json:"note"`
}

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
	AppInstall      *RsiAppInstall        `json:"appInstall,omitempty"`
	Activation      *RsiReceiptActivation `json:"activation,omitempty"`
	Force           bool                  `json:"force,omitempty"`
	PendingFiles    []string              `json:"pendingFiles,omitempty"`
	Error           *string               `json:"error,omitempty"`
	Diff            *string               `json:"diff,omitempty"`
	Adopted         []string              `json:"adopted,omitempty"`
	Report          string                `json:"report"`
	OutputPath      *string               `json:"outputPath,omitempty"`
	ElapsedMs       *int64                `json:"elapsedMs,omitempty"`
}

type RsiActivation struct {
	State string `json:"state"`
	Note  string `json:"note"`
}

type RsiActivationInput struct {
	Commit       *string
	CommittedNow bool
	Activate     bool
	Live         bool
}

type RsiPendingRestart struct {
	Id          string  `json:"id"`
	Root        string  `json:"root"`
	Branch      *string `json:"branch"`
	Commit      *string `json:"commit"`
	RequestedAt int64   `json:"requestedAt"`
	Generation  *int64  `json:"generation,omitempty"`
	Force       bool    `json:"force,omitempty"`
}

type RsiSyncEntry struct {
	Branch   string `json:"branch"`
	Upstream string `json:"upstream"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
}

type RsiSyncState struct {
	Unpublished    []RsiSyncEntry     `json:"unpublished"`
	Expected       []RsiSyncEntry     `json:"expected"`
	LocalOnly      int                `json:"localOnly"`
	Deploy         *DeployDriftReport `json:"deploy,omitempty"`
	Note           string             `json:"note"`
	deployCompared bool
}

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

type RsiOperation struct {
	Id             string  `json:"id"`
	TaskId         string  `json:"taskId"`
	NodeId         string  `json:"nodeId"`
	State          string  `json:"state"`
	Request        string  `json:"request"`
	ConversationId *string `json:"conversationId"`
	Archived       bool    `json:"archived"`
}

type RsiLastActivation struct {
	Id          string  `json:"id"`
	Commit      *string `json:"commit"`
	ConfirmedAt int64   `json:"confirmedAt"`
	Generation  int     `json:"generation"`
}

type RsiStatus struct {
	Available          bool                   `json:"available"`
	Root               *string                `json:"root"`
	Branch             *string                `json:"branch"`
	Reason             *string                `json:"reason,omitempty"`
	Sync               *RsiSyncState          `json:"sync"`
	PendingRestart     *RsiPendingRestart     `json:"pendingRestart"`
	LastActivation     *RsiLastActivation     `json:"lastActivation"`
	InterruptedAttempt *RsiInterruptedAttempt `json:"interruptedAttempt"`
	ActiveOperations   int                    `json:"activeOperations"`
	Operations         []RsiOperation         `json:"operations"`
	OperationsKnown    bool                   `json:"operationsKnown"`
	CanRestart         bool                   `json:"canRestart"`
}

type RsiValidateInput struct {
	Root          string
	Checks        []RsiCommand
	Activate      bool
	NeedsAppBuild bool
	NeedsWebBuild bool
}

type RsiValidateFunc func(input RsiValidateInput) []RsiValidationResult

type RsiServiceOptions struct {
	Root     *string
	StateDir string
	Validate RsiValidateFunc
}

type RsiApplyContext struct {
	OperationId    *string
	Store          *TaskStore
	TaskId         string
	ConversationId *string
}

type RsiAckRestart struct {
	Cleared        bool               `json:"cleared"`
	PendingRestart *RsiPendingRestart `json:"pendingRestart"`
}

type ValidationCommandPlan struct {
	Executable string
	Args       []string
	Env        map[string]string
}

type RsiService struct {
	reload    *RsiReloadHooks
	Root      *string
	Available bool

	stateDir      string
	validate      RsiValidateFunc
	runningCommit *string
	mu            sync.Mutex
	changing      bool
	asyncFull     rsiAsyncFullState
}
