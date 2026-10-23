package graph

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

// The PiG kernel of a graph node.
//
// A node's turn is the same turn the main agent runs: its own identity, its own
// transcript, its own admission, all in the same durable namespace and on the
// same kernel. The daemon keeps what it always kept - the model channel, the
// tool bodies, the admission gate and the budget - and the kernel keeps the
// execution history.
//
// The node opens one session per turn, the way the TypeScript sidecar did: the
// admission identity of a turn carries the attempt, so a retry is a new
// admission and an interrupted turn keeps the one it had.

// PigNodeHostOptions configure one node's host on the PiG kernel.
type PigNodeHostOptions struct {
	// Database is the formal Graph database the durable records live in.
	Database string
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
	extensions, err := pigExtensionSpecs(context.Background(), request, host.options.Gate)
	if err != nil {
		// The refusal names the extension: a node that cannot host one has to
		// say which one, so the user knows what to unbind.
		if errors.Is(err, errPiExtensionNotHosted) {
			return pigNodeTurnError(piExtensionRefusalText(request.CapabilityDescriptor, request.PiExtensionPaths) + ": " + err.Error())
		}
		return pigNodeTurnError(err.Error())
	}
	tools = append(tools, extensions...)
	session, err := openPigSession(context.Background(), host.options.Database, request, host.provider(), tools, host.options.OnEvent, host.options.OnToolCall)
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
	report := TurnReport{Done: true}
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

// provider is the daemon's model channel, seen from the kernel.
//
// The kernel asks for the answer; the daemon's own stream produces it. The
// daemon's stream is the one that admits the send, spends the credential and
// records the usage, so the kernel never opens a provider channel of its own.
func (host *PigNodeHost) provider() pigkernel.ProviderBridge {
	options := map[string]any{}
	if host.options.StreamOptions != nil {
		options = host.options.StreamOptions()
	}
	return pigkernel.ProviderBridge{
		Stream: func(_ context.Context, transcript []map[string]any, _ map[string]any) (pigkernel.EventStream, error) {
			messages := make([]any, 0, len(transcript))
			for _, message := range transcript {
				messages = append(messages, message)
			}
			context := map[string]any{"messages": messages}
			return host.options.Stream(host.options.Request.Model, context, options)
		},
	}
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
				value := gate.Dispatch(id, 0, func() any {
					defer gate.Settle(id, &TokenUsage{})
					result, executeErr := definition.Execute(id, params)
					if executeErr != nil {
						return executeErr
					}
					return result
				})
				if failure, ok := value.(error); ok {
					return nil, failure
				}
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
