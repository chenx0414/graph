package graph

import (
	"regexp"

	"fmt"
)

// ExecutorHost is the slice of the resident host this loop turns.
type ExecutorHost interface {
	Start() HostProcess
	Alive() bool
	Turn(text string) TurnReport
}

type HostProcess struct {
	ProcessId int
}

// TurnReport is what one turn reported back.
type TurnReport struct {
	Error   *string
	Done    bool
	Missing []string
	Usage   *TurnUsage
}

type TurnUsage struct {
	Total     float64
	Accounted bool
}

type TurnRunner func(executionId string, attempt int, injection *TurnInjection, input *QueueRow) TurnReport

type TurnInjection struct {
	Missing []string
}

type NodeExecutorOptions struct {
	MaxItems        *int
	SettleWorkspace func(executionId string)
	Signal          *AbortSignal
	Kernel          *KernelStore
	GraphId         string
	Host            ExecutorHost
	OpenHost        func(executionId string, revisionVersion int) ExecutorHost
	Workspace       func() *string
	Artifacts       func() *ArtifactWorkspace
	TokenBudget     *TokenBudget
	TokenBudgetFn   func() TokenBudget
	ReserveTokens   *float64
}

type NodeOutcome string

const (
	NodeOutcomeDone    NodeOutcome = "done"
	NodeOutcomeFailed  NodeOutcome = "failed"
	NodeOutcomeIdle    NodeOutcome = "idle"
	NodeOutcomeBlocked NodeOutcome = "blocked"
)

type NodeExecutor struct {
	queue   *NodeQueue
	kernel  *KernelStore
	graphId string
	options NodeExecutorOptions
}

func NewNodeExecutor(options NodeExecutorOptions) *NodeExecutor {
	return &NodeExecutor{
		options: options,
		kernel:  options.Kernel,
		graphId: options.GraphId,
		queue:   NewNodeQueue(options.Kernel, options.GraphId, NodeQueueDefaults{}),
	}
}

func (e *NodeExecutor) hasValidSubmission(executionId string) bool {
	_, ok := graphDBRow(e.kernel.Store.Db, "SELECT 1 FROM kernel_submissions WHERE execution_id=? LIMIT 1", executionId)
	return ok
}

// RunNode drains the node's queue until it is empty or the node pauses.
func (e *NodeExecutor) RunNode(nodeId string, run TurnRunner) NodeOutcome {
	last := NodeOutcomeIdle
	consumed := 0
	for {
		if e.options.Signal.Aborted() || e.kernel.NodeState(e.graphId, nodeId).Paused {
			return last
		}
		task := e.kernel.Store.Task(e.graphId)
		if task.Paused != 0 || phaseClosed(task.Phase) {
			return last
		}
		if OccupiedSlots(e.kernel.Store, "agent") >= int64(ExecutionLimit("agent")) {
			return last
		}
		item := e.queue.Claim(nodeId)
		if item == nil {
			return last
		}
		last = e.runOne(nodeId, *item, run)
		consumed++
		if last == NodeOutcomeFailed || last == NodeOutcomeBlocked {
			return last
		}
		if e.options.MaxItems != nil && consumed >= *e.options.MaxItems {
			return last
		}
	}
}

func (e *NodeExecutor) runOne(nodeId string, item QueueRow, run TurnRunner) NodeOutcome {
	seq := item.Seq
	latest := e.kernel.LatestRevision(e.graphId)
	if latest == nil {
		Raise("invalid_graph", fmt.Sprintf("Graph %s has no revision", e.graphId))
	}
	generation := graphDBInt(mustRow(graphDBRow(e.kernel.Store.Db, "SELECT generation FROM kernel_queue WHERE seq=?", seq)), "generation")
	suffix := ""
	if generation != 0 {
		suffix = fmt.Sprintf("-%d", generation)
	}
	executionId := fmt.Sprintf("exec-%s-%s-%d%s", e.graphId, nodeId, seq, suffix)
	previous := e.kernel.Execution(executionId)
	tokenBudget := TokenBudget{Budget: 0, Unlimited: true}
	if previous != nil && previous.TokenBudget != nil {
		tokenBudget = *previous.TokenBudget
	} else if authorized := e.kernel.AuthorizedBudget(e.graphId, nodeId); authorized != nil {
		tokenBudget = *authorized
	} else if e.options.TokenBudgetFn != nil {
		tokenBudget = e.options.TokenBudgetFn()
	} else if e.options.TokenBudget != nil {
		tokenBudget = *e.options.TokenBudget
	}
	var refused *string
	if previous != nil && previous.TokenBudget == nil {
		text := "Execution budget history is unavailable; explicitly retry with a new execution identity before spending more tokens"
		refused = &text
	}
	requested := nodeBudget(latest.Definition, nodeId)
	if previous == nil && requested != nil {
		if !tokenBudget.Unlimited && (requested.Tokens == nil || float64(*requested.Tokens) > tokenBudget.Budget) {
			text := "Declared node budget exceeds the user-authorized quota; change the declaration or request a user quota change, then explicitly retry"
			refused = &text
		} else if requested.Tokens == nil {
			tokenBudget = TokenBudget{Budget: 0, Unlimited: true}
		} else {
			tokenBudget = TokenBudget{Budget: float64(*requested.Tokens), Unlimited: false}
		}
	}
	var budgetArg *TokenBudget
	if refused == nil {
		budgetArg = &tokenBudget
	}
	execution := e.kernel.StartExecution(e.graphId, StartExecutionRequest{
		ExecutionId: executionId, NodeId: nodeId, RevisionVersion: latest.Version, TokenBudget: budgetArg,
	})
	if refused == nil && execution.TokenBudget != nil && !execution.TokenBudget.Unlimited {
		if _, unknown := graphDBRow(e.kernel.Store.Db, "SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state='unknown' LIMIT 1", e.graphId, nodeId); unknown {
			text := "Unknown provider usage must be reconciled before starting a finite execution"
			refused = &text
		}
	}
	if refused != nil {
		e.kernel.FinishExecution(executionId, "blocked")
		e.kernel.BlockNode(e.graphId, nodeId, *refused)
		e.kernel.SetNodeQueuePaused(e.graphId, nodeId, true)
		e.queue.Complete(seq, QueueCompletion{Kind: "blocked", Reason: *refused})
		return NodeOutcomeBlocked
	}
	revision := e.kernel.Revision(e.graphId, execution.RevisionVersion)
	defaults := e.queue.RetryBudget(nodeId)
	budget := defaults
	if retry := nodeRetry(revision.Definition, nodeId); retry != nil && retry.Automatic != nil {
		budget.RetriesAllowed = *retry.Automatic
	} else if revision.Definition.Defaults != nil && revision.Definition.Defaults.Retry != nil && revision.Definition.Defaults.Retry.Automatic != nil {
		budget.RetriesAllowed = *revision.Definition.Defaults.Retry.Automatic
	}
	if retry := nodeRetry(revision.Definition, nodeId); retry != nil && retry.Resubmit != nil {
		budget.ResubmitsAllowed = *retry.Resubmit
	} else if revision.Definition.Defaults != nil && revision.Definition.Defaults.Retry != nil && revision.Definition.Defaults.Retry.Resubmit != nil {
		budget.ResubmitsAllowed = *revision.Definition.Defaults.Retry.Resubmit
	}
	var metering *struct {
		limit  TokenBudget
		amount float64
	}
	if execution.TokenBudget != nil && !execution.TokenBudget.Unlimited && e.options.ReserveTokens != nil {
		metering = &struct {
			limit  TokenBudget
			amount float64
		}{limit: *execution.TokenBudget, amount: *e.options.ReserveTokens}
	}
	var host ExecutorHost
	held := false
	releaseHold := func() {
		if metering != nil && held {
			e.kernel.ReleaseNodeTokens(e.graphId, nodeId, metering.amount, executionId)
			held = false
		}
	}
	recovered := e.kernel.Execution(executionId)
	attempt := recovered.Attempt
	retriesUsed := recovered.RetriesUsed
	// The resubmit allowance is the node's, not this execution's. The node's
	// durable counter is the one that survives a restart, and the contract
	// says a reopened database does not refresh the automatic allowance: a
	// node that used its one resubmit has used it, whichever execution it
	// used it in.
	resubmitsUsed := e.kernel.NodeState(e.graphId, nodeId).ResubmitsUsed
	var injection *TurnInjection
	if len(recovered.PendingGap) > 0 {
		injection = &TurnInjection{Missing: recovered.PendingGap}
	}
	for {
		if metering != nil {
			var blocked *RuntimeError
			func() {
				defer func() {
					recovered := recover()
					if recovered == nil {
						return
					}
					re, ok := recovered.(*RuntimeError)
					if !ok || re.Code != "budget" {
						panic(recovered)
					}
					blocked = re
				}()
				e.kernel.ReserveNodeTokens(e.graphId, nodeId, metering.limit, metering.amount, executionId)
				held = true
			}()
			if blocked != nil {
				e.kernel.FinishExecution(executionId, "blocked")
				e.kernel.BlockNode(e.graphId, nodeId, blocked.Message)
				e.kernel.RequestBudget(e.graphId, nodeId, executionId, blocked.Message)
				e.kernel.SetNodeQueuePaused(e.graphId, nodeId, true)
				e.queue.Complete(seq, QueueCompletion{Kind: "blocked", Reason: blocked.Message})
				return NodeOutcomeBlocked
			}
		}
		var report TurnReport
		turnStarted := false
		err := func() (caught any) {
			defer func() { caught = recover() }()
			if host == nil {
				if e.options.OpenHost != nil {
					host = e.options.OpenHost(executionId, revision.Version)
				} else {
					host = e.options.Host
				}
			}
			if !host.Alive() {
				host.Start()
			}
			recoveredAttempt := 0
			if recoverable, ok := host.(interface{ RecoveredAttempt() int }); ok {
				recoveredAttempt = recoverable.RecoveredAttempt()
			}
			if recoveredAttempt > 0 {
				attempt = recoveredAttempt
			} else {
				attempt = e.kernel.NoteExecutionAttempt(executionId)
				e.queue.NoteAttempt(nodeId)
			}
			turnStarted = true
			report = run(executionId, attempt, injection, &item)
			return nil
		}()
		if err != nil {
			if _, blocked := err.(nodeBlocked); blocked {
				return NodeOutcomeBlocked
			}
			if e.options.Signal.Aborted() {
				reason := "Runtime closing; input retained without consuming an automatic retry"
				if !turnStarted {
					releaseHold()
				}
				if e.hasValidSubmission(executionId) {
					return e.fail(executionId, nodeId, seq, "Runtime closed after submit; output retained and original input cannot replay")
				}
				e.kernel.FinishExecution(executionId, "blocked")
				e.kernel.BlockNode(e.graphId, nodeId, reason)
				e.queue.Complete(seq, QueueCompletion{Kind: "blocked", Reason: reason})
				return NodeOutcomeBlocked
			}
			message := panicMessage(err)
			if e.hasValidSubmission(executionId) {
				if metering == nil || !turnStarted {
					releaseHold()
				}
				return e.fail(executionId, nodeId, seq, "Execution failed after submit: "+message)
			}
			if !turnStarted {
				if re, ok := err.(*RuntimeError); ok && (re.Code == "model_selection" || re.Code == "permission" || re.Code == "invalid_workspace") {
					releaseHold()
					e.kernel.FinishExecution(executionId, "blocked")
					e.kernel.BlockNode(e.graphId, nodeId, re.Message)
					e.kernel.SetNodeQueuePaused(e.graphId, nodeId, true)
					e.queue.Complete(seq, QueueCompletion{Kind: "blocked", Reason: re.Message})
					return NodeOutcomeBlocked
				}
			}
			if metering != nil && turnStarted {
				e.kernel.FinishExecution(executionId, "blocked")
				e.kernel.BlockNode(e.graphId, nodeId, "Interrupted turn usage is unknown; reconcile the held reservation before resuming")
				e.queue.Complete(seq, QueueCompletion{Kind: "blocked", Reason: "usage unknown after interruption"})
				return NodeOutcomeBlocked
			}
			if retriesUsed >= budget.RetriesAllowed {
				releaseHold()
				return e.fail(executionId, nodeId, seq, message)
			}
			releaseHold()
			retriesUsed++
			e.kernel.NoteExecutionContinuation(executionId, "retry", nil)
			injection = nil
			continue
		}
		if metering != nil && (report.Usage == nil || !report.Usage.Accounted) && report.Usage != nil && isSafeInteger(report.Usage.Total) && report.Usage.Total > 0 {
			e.kernel.CommitNodeUsage(e.graphId, nodeId, int64(report.Usage.Total))
		}
		if metering != nil && report.Usage == nil {
			if e.hasValidSubmission(executionId) {
				return e.fail(executionId, nodeId, seq, "Execution ended after submit with unknown usage; output retained and original input cannot replay")
			}
			e.kernel.FinishExecution(executionId, "blocked")
			e.kernel.BlockNode(e.graphId, nodeId, "turn reported no usage; its reservation is held until reconciled")
			e.queue.Complete(seq, QueueCompletion{Kind: "blocked", Reason: "usage unknown"})
			return NodeOutcomeBlocked
		}
		releaseHold()
		if report.Error != nil {
			if !e.hasValidSubmission(executionId) && tokenBudgetExhausted.MatchString(*report.Error) {
				e.kernel.FinishExecution(executionId, "blocked")
				e.kernel.BlockNode(e.graphId, nodeId, *report.Error)
				e.kernel.RequestBudget(e.graphId, nodeId, executionId, *report.Error)
				e.kernel.SetNodeQueuePaused(e.graphId, nodeId, true)
				e.queue.Complete(seq, QueueCompletion{Kind: "blocked", Reason: *report.Error})
				return NodeOutcomeBlocked
			}
			if !e.hasValidSubmission(executionId) && pausedReport.MatchString(*report.Error) && (e.kernel.Store.Task(e.graphId).Paused != 0 || e.kernel.NodeState(e.graphId, nodeId).Paused) {
				e.kernel.FinishExecution(executionId, "blocked")
				e.kernel.SetNodeIdle(e.graphId, nodeId)
				e.queue.Complete(seq, QueueCompletion{Kind: "blocked", Reason: *report.Error})
				return NodeOutcomeBlocked
			}
			if e.hasValidSubmission(executionId) || terminalReport.MatchString(*report.Error) || retriesUsed >= budget.RetriesAllowed {
				return e.fail(executionId, nodeId, seq, *report.Error)
			}
			retriesUsed++
			e.kernel.NoteExecutionContinuation(executionId, "retry", nil)
			injection = nil
			continue
		}
		if e.hasValidSubmission(executionId) || report.Done {
			settled := DeliverableSettlement{Ok: true}
			if item.Kind != "chat" {
				settled = e.settleDeliverable(executionId, nodeId)
			}
			if !settled.Ok {
				releaseHold()
				return e.fail(executionId, nodeId, seq, settled.Reason)
			}
			if e.options.SettleWorkspace != nil && (item.Kind != "chat" || e.hasValidSubmission(executionId)) {
				err := func() (caught any) {
					defer func() { caught = recover() }()
					e.options.SettleWorkspace(executionId)
					return nil
				}()
				if err != nil {
					return e.fail(executionId, nodeId, seq, panicMessage(err))
				}
			}
			e.kernel.FinishExecution(executionId, "completed")
			e.kernel.CompleteNode(e.graphId, nodeId)
			e.queue.Complete(seq, QueueCompletion{Kind: "submitted"})
			releaseHold()
			return NodeOutcomeDone
		}
		if len(report.Missing) > 0 {
			if resubmitsUsed < budget.ResubmitsAllowed {
				resubmitsUsed++
				e.kernel.NoteExecutionContinuation(executionId, "resubmit", report.Missing)
				e.kernel.NoteNodeResubmit(e.graphId, nodeId, budget.ResubmitsAllowed)
				e.kernel.MarkExecutionMissingRequired(executionId)
				injection = &TurnInjection{Missing: report.Missing}
				continue
			}
			releaseHold()
			return e.fail(executionId, nodeId, seq, fmt.Sprintf("required output(s) still missing: %s — all %d resubmit(s) were used and the node never enabled them", joinComma(report.Missing), budget.ResubmitsAllowed))
		}
		if retriesUsed >= budget.RetriesAllowed {
			releaseHold()
			return e.fail(executionId, nodeId, seq, fmt.Sprintf("no valid submission after %d attempt(s)", attempt))
		}
		retriesUsed++
		e.kernel.NoteExecutionContinuation(executionId, "retry", nil)
		injection = nil
	}
}

type nodeBlocked struct{}

func (nodeBlocked) Error() string { return "blocked" }

// DeliverableSettlement is the executor's view of a settled deliverable: the
// promise held, or the reason it failed.
type DeliverableSettlement struct {
	Ok     bool
	Reason string
}

func (e *NodeExecutor) settleDeliverable(executionId, nodeId string) DeliverableSettlement {
	var workspace *string
	if e.options.Workspace != nil {
		workspace = e.options.Workspace()
	}
	var artifacts *ArtifactWorkspace
	if e.options.Artifacts != nil {
		artifacts = e.options.Artifacts()
	}
	if workspace == nil || *workspace == "" || artifacts == nil {
		return DeliverableSettlement{Ok: true}
	}
	execution := e.kernel.Execution(executionId)
	if execution == nil {
		return DeliverableSettlement{Ok: true}
	}
	outcome := SettleDeliverable(SettleDeliverableInput{
		Kernel: e.kernel, Artifacts: artifacts, GraphId: e.graphId, NodeId: nodeId,
		RevisionVersion: execution.RevisionVersion, ExecutionId: executionId, Workspace: *workspace,
	})
	if !outcome.Ok {
		return DeliverableSettlement{Ok: false, Reason: outcome.Reason}
	}
	return DeliverableSettlement{Ok: true}
}

func (e *NodeExecutor) fail(executionId, nodeId string, seq int64, reason string) NodeOutcome {
	e.kernel.FinishExecution(executionId, "failed")
	e.kernel.NoteQueueFailure(e.graphId, seq, reason)
	e.kernel.FailNode(e.graphId, nodeId, reason)
	e.queue.Complete(seq, QueueCompletion{Kind: "failed", Reason: reason})
	return NodeOutcomeFailed
}

func mustRow(row map[string]any, ok bool) map[string]any {
	if !ok {
		panic(fmt.Errorf("expected row"))
	}
	return row
}

func panicMessage(value any) string {
	switch err := value.(type) {
	case error:
		return err.Error()
	default:
		return fmt.Sprint(value)
	}
}

var tokenBudgetExhausted = regexp.MustCompile(`Token budget exhausted`)

var pausedReport = regexp.MustCompile(`(?i)paused`)

// terminalReport matches the failures a retry cannot fix.
//
// A budget, a permission, a paused run and a missing credential all need a
// change the node cannot make itself. So does a bound Pi extension the kernel
// cannot host: the extension is either loaded or it is not, and a second
// attempt reads the same catalog and reaches the same refusal.
var terminalReport = regexp.MustCompile(`(?i)budget|permission|paused|credential unavailable|cannot be hosted`)

func nodeBudget(definition GraphDefinition, nodeId string) *NodeBudget {
	if node := definition.Nodes[nodeId]; node.Budget != nil {
		return node.Budget
	}
	if definition.Defaults != nil {
		return definition.Defaults.Budget
	}
	return nil
}

func nodeRetry(definition GraphDefinition, nodeId string) *NodeRetry {
	if node, ok := definition.Nodes[nodeId]; ok && node.Retry != nil {
		return node.Retry
	}
	return nil
}
