package graph

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"

	"time"

	"context"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

// PigNodeHostOptions configure one node's host on the PiG kernel.
type PigNodeHostOptions struct {
	// Database is the formal Graph database the durable records live in.
	Database string
	// Store is the daemon's store, so a node's extension calls reach the same
	// tool telemetry every other tool writes to.
	Store *TaskStore
	// Request is the node's own session request. Everything the kernel runs -
	// the model, the tools, the prompt and the identity - is the daemon's.
	Request AgentSessionRequest
	// Gate admits the node's tool calls. The model's sends are admitted by the
	// node's own provider gate.
	Gate SendGate
	// Ungated names the tools that are not behind the node's tool gate: the
	// host executes them against the real execution, so the host's own bridge
	// is their gate.
	Ungated []string
	// Stream is the daemon's model channel.
	Stream PromptStreamFunc
	// StreamOptions are the provider options of the turn.
	StreamOptions func() map[string]any
	// RequestId is the admission identity of the next turn.
	RequestId func() string
	// Usage is the usage the host accounted for the turn.
	Usage func() *PiTurnUsage
	// PreAdmission names the provider calls that existed before the turn. A
	// call beyond them is one this turn made, and the turn must not be
	// replayed.
	PreAdmission func() []string
	// OnEvent receives the kernel's events.
	OnEvent func(event map[string]any)
	// OnToolCall receives every executed tool call.
	OnToolCall func(call pigkernel.ToolCallRecord)
	// OnReady records the durable session the node runs in.
	OnReady func(sessionId string, sessionFile string)
	// RecoveredAttempt reports the attempt an interrupted turn keeps.
	RecoveredAttempt func() int
}

// PigNodeHost is one graph node's host on the PiG kernel.
//
// The host is resident for the life of the node, the way the TypeScript
// resident worker was: the durable conversation is the node's own, and every
// turn of the node runs in it.
type PigNodeHost struct {
	options PigNodeHostOptions
	mutex   sync.Mutex
	current *pigkernel.Session
	closed  bool
	attempt bool
}

// NewPigNodeHost opens one node's host on the PiG kernel.
func NewPigNodeHost(options PigNodeHostOptions) *PigNodeHost {
	return &PigNodeHost{options: options}
}

// Start starts the host.
//
// The kernel is resident in this process: there is no worker to start, and the
// durable conversations of every node live in the one kernel the daemon opened.
func (host *PigNodeHost) Start() HostProcess {
	host.mutex.Lock()
	closed := host.closed
	host.mutex.Unlock()
	if closed {
		panic(errors.New("The PiG node binding is closed"))
	}
	return HostProcess{ProcessId: os.Getpid()}
}

// Alive reports whether the host still runs.
func (host *PigNodeHost) Alive() bool {
	host.mutex.Lock()
	defer host.mutex.Unlock()
	return !host.closed
}

// RecoveredAttempt reports the attempt an interrupted turn keeps.
//
// The answer is asked once per host: an attempt belongs to the execution, not
// to the turn that follows it.
func (host *PigNodeHost) RecoveredAttempt() int {
	host.mutex.Lock()
	asked := host.attempt
	host.attempt = true
	host.mutex.Unlock()
	if asked || host.options.RecoveredAttempt == nil {
		return 0
	}
	return host.options.RecoveredAttempt()
}

// Turn runs one turn of the node on the PiG kernel.
func (host *PigNodeHost) Turn(text string) TurnReport {
	host.mutex.Lock()
	closed := host.closed
	host.mutex.Unlock()
	if closed {
		return pigNodeTurnError("The PiG node binding is closed")
	}
	request := host.options.Request
	if host.options.RequestId != nil {
		request.InputRequestId = host.options.RequestId()
	}
	tools := pigNodeToolSpecs(request, host.options.Gate, host.options.Ungated)
	extensions, err := pigExtensionSpecs(context.Background(), request, host.options.Gate, func(tool string, ms float64, isError bool) {
		if host.options.Store != nil {
			host.options.Store.RecordToolCall(ToolCallInput{InstanceID: request.Binding.InstanceId, Tool: tool, Ms: ms, IsError: isError})
		}
	})
	if err != nil {
		// The refusal names the extension: a node that cannot host one has to
		// say which one, so the user knows what to unbind.
		if errors.Is(err, errPiExtensionNotHosted) {
			return pigNodeTurnError(piExtensionRefusalText(request.CapabilityDescriptor, request.PiExtensionPaths) + ": " + err.Error())
		}
		return pigNodeTurnError(err.Error())
	}
	tools = append(tools, extensions...)
	// The same per-turn event the master turn sends: a node that bound an
	// extension tells it what this turn is about before the tools run. A failure
	// is dropped here rather than failing the node: the extension's own tool
	// calls will report it, and this binding has no task id to file an event
	// under.
	_ = pigExtensionTurnStarted(request.Workspace, text)
	session, err := openPigSession(context.Background(), host.options.Database, request,
		pigProviderBridge(host.options.Stream, host.options.Request.Model, func(map[string]any) map[string]any { return host.providerOptions() }),
		tools, host.options.OnEvent, host.options.OnToolCall)
	if err != nil {
		return pigNodeTurnError(err.Error())
	}
	host.mutex.Lock()
	if host.closed {
		host.mutex.Unlock()
		_ = session.Close()
		return pigNodeTurnError("The PiG node binding is closed")
	}
	host.current = session
	host.mutex.Unlock()
	defer func() {
		host.mutex.Lock()
		if host.current == session {
			host.current = nil
		}
		host.mutex.Unlock()
		_ = session.Close()
	}()

	inspect := session.Inspect()
	if host.options.OnReady != nil {
		host.options.OnReady(inspect.SessionId, inspect.SessionFile)
	}
	// The execution is frozen before the turn starts. The record is what a
	// recovery reads when the daemon dies mid-turn: which execution the kernel
	// was running and the input it was waiting for. The durable conversation
	// exists by now, so the record has a place to live.
	preAdmission := []string{}
	if host.options.PreAdmission != nil {
		preAdmission = host.options.PreAdmission()
	}
	if err := pigkernel.FreezeExecution(context.Background(), host.options.Database, request.Binding.InstanceId,
		pigFrozenExecution(request, preAdmission)); err != nil {
		return pigNodeTurnError(err.Error())
	}
	turn, err := session.Prompt(context.Background(), text)
	if err != nil {
		return pigNodeTurnError(err.Error())
	}
	report := TurnReport{Done: true, Interrupted: turn.StopReason == "aborted"}
	if turn.ErrorMessage != "" {
		return pigNodeTurnError(turn.ErrorMessage)
	}
	if host.options.Usage != nil {
		if usage := host.options.Usage(); usage != nil {
			report.Usage = &TurnUsage{Total: float64(usage.Total), Accounted: usage.Accounted != nil && *usage.Accounted}
		}
	}
	return report
}

// Steer interrupts the current model response and continues the same execution.
func (host *PigNodeHost) Steer(text, requestID string) error {
	host.mutex.Lock()
	session := host.current
	host.mutex.Unlock()
	if session == nil {
		return errors.New("The node is not accepting steering messages")
	}
	return session.InterruptWithRequestID(context.Background(), &text, requestID)
}

// Stop ends the running turn. The node keeps its transcript.
func (host *PigNodeHost) StopActive() error {
	host.mutex.Lock()
	session := host.current
	host.mutex.Unlock()
	if session == nil {
		return errors.New("The node session is not yet available")
	}
	return session.Stop(context.Background())
}

// Stop ends the running turn. The node keeps its transcript.
func (host *PigNodeHost) Stop() error {
	host.mutex.Lock()
	session := host.current
	host.mutex.Unlock()
	if session == nil {
		return nil
	}
	return session.Stop(context.Background())
}

// Dispose ends the host for good.
func (host *PigNodeHost) Dispose() error {
	host.mutex.Lock()
	host.closed = true
	session := host.current
	host.current = nil
	host.mutex.Unlock()
	if session == nil {
		return nil
	}
	return session.Close()
}

// providerOptions are the provider options the node's turn runs with.
func (host *PigNodeHost) providerOptions() map[string]any {
	options := map[string]any{}
	if host.options.StreamOptions != nil {
		options = host.options.StreamOptions()
	}
	return options
}

// pigNodeTurnError is the report of a turn that failed.
func pigNodeTurnError(reason string) TurnReport {
	message := reason
	return TurnReport{Error: &message}
}

// pigNodeToolSpecs are the tools the node may call.
//
// The tool bodies are the daemon's, and so is the admission gate: every call
// passes the same gate the TypeScript sidecar's calls passed. A refusal is a
// tool error the model reads, not a lost turn.
func pigNodeToolSpecs(request AgentSessionRequest, gate SendGate, ungated []string) []pigkernel.ToolSpec {
	direct := map[string]bool{}
	for _, name := range ungated {
		direct[name] = true
	}
	specs := []pigkernel.ToolSpec{}
	for _, tool := range request.Tools {
		definition := tool
		specs = append(specs, pigkernel.ToolSpec{
			Name:        definition.Name,
			Description: definition.Description,
			Parameters:  asMap(definition.Parameters),
			Result: func(_ context.Context, args map[string]any) (result any, err error) {
				defer func() {
					recovered := recover()
					if recovered == nil {
						return
					}
					switch failure := recovered.(type) {
					case *RuntimeError:
						result, err = nil, failure
					case error:
						result, err = nil, failure
					default:
						err = errors.New(fmt.Sprint(recovered))
					}
				}()
				prepared := any(args)
				if definition.PrepareArguments != nil {
					prepared = definition.PrepareArguments(prepared)
				}
				params, _ := prepared.(map[string]any)
				if params == nil {
					params = map[string]any{}
				}
				if definition.Execute == nil {
					return nil, nil
				}
				if direct[definition.Name] {
					return definition.Execute(graphUUID(), params)
				}
				id := graphUUID()
				started := time.Now()
				// Settled after the dispatch returns, so a tool that refuses
				// keeps its own reason instead of being replaced by a conflict
				// between the two settles.
				value := gate.Dispatch(id, 0, func() any {
					result, executeErr := definition.Execute(id, params)
					if executeErr != nil {
						return executeErr
					}
					return result
				})
				gate.Settle(id, &TokenUsage{})
				// Every tool call this node makes is reported, the way the
				// main session reports its own and the way the TypeScript
				// host reports every call: the statistics table is how a
				// user sees what the agents actually did.
				if failure, ok := value.(error); ok {
					recordPigToolCall(request, definition.Name, started, true)
					return nil, failure
				}
				recordPigToolCall(request, definition.Name, started, false)
				return value, nil
			},
		})
	}
	return specs
}

// pigNodeAttemptOf reads the attempt out of an admission identity.
//
// The identity of an admission is `<execution>:attempt:<n>`, with
// `<:resubmit:<n>>` when the node was resubmitted.
func pigNodeAttemptOf(requestId string) int {
	parts := strings.Split(requestId, ":")
	for index, part := range parts {
		if part != "attempt" || index+1 >= len(parts) {
			continue
		}
		attempt, err := strconv.Atoi(parts[index+1])
		if err != nil || attempt < 1 {
			return 0
		}
		return attempt
	}
	return 0
}

// pigNodeRecoveredAttempt reports the attempt an interrupted node turn keeps.
//
// The answer follows the kernel's own records. The frozen execution names the
// admission the node was waiting for, the kernel says whether it still holds
// it, and the Graph says whether the turn ever reached the model. An
// admission the kernel holds and that never reached the model keeps its
// attempt: the same input is sent again, not a second one.
//
// A turn that reached the model keeps nothing: the credential was spent and the
// side effects may have happened, so the node waits for the user.
func pigNodeRecoveredAttempt(kernel *KernelStore, identity string, executionId string) int {
	if identity == "" || executionId == "" {
		return 0
	}
	executions, err := pigkernel.FrozenExecutions(context.Background(), kernel.Store.Path)
	if err != nil {
		return 0
	}
	frozen := pigkernel.FrozenExecution{}
	found := false
	for _, candidate := range executions {
		if candidate.Identity == identity {
			frozen = candidate
			found = true
			break
		}
	}
	if !found || frozen.ExecutionId != executionId {
		return 0
	}
	receipt, err := pigkernel.ReadExecutionReceipt(context.Background(), kernel.Store.Path, frozen)
	if err != nil || !receipt.Found || receipt.Status == "unanswered" {
		return 0
	}
	// A turn the kernel finished keeps its attempt: the answer is retained,
	// so the node runs again against the same admission and the model is not
	// asked a second time.
	switch classifyPigTurn(receipt, pigNodeCalledProvider(kernel, &ExecutionRow{Id: executionId}, frozen)) {
	case pigTurnReachedModel:
		return 0
	default:
		return pigNodeAttemptOf(frozen.InputRequestId)
	}
}
