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

	"github.com/chenx0414/graph/backend/internal/agentcore"
	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

type PigNodeHostOptions struct {
	GraphId          string
	NodeId           string
	Role             string
	Database         string
	Store            *TaskStore
	Request          AgentSessionRequest
	Gate             SendGate
	Ungated          []string
	Stream           PromptStreamFunc
	StreamOptions    func() map[string]any
	Codemode         CodemodeSettings
	RequestId        func() string
	Usage            func() *PiTurnUsage
	PreAdmission     func() []string
	OnEvent          func(event map[string]any)
	OnToolCall       func(call pigkernel.ToolCallRecord)
	OnReady          func(sessionId string, sessionFile string)
	RecoveredAttempt func() int
}

type PigNodeHost struct {
	options PigNodeHostOptions
	mutex   sync.Mutex
	current *agentcore.Agent
	closed  bool
	attempt bool
}

func NewPigNodeHost(options PigNodeHostOptions) *PigNodeHost {
	return &PigNodeHost{options: options}
}

func (host *PigNodeHost) Start() HostProcess {
	host.mutex.Lock()
	closed := host.closed
	host.mutex.Unlock()
	if closed {
		panic(errors.New("The PiG node binding is closed"))
	}
	return HostProcess{ProcessId: os.Getpid()}
}

func (host *PigNodeHost) Alive() bool {
	host.mutex.Lock()
	defer host.mutex.Unlock()
	return !host.closed
}

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
		if errors.Is(err, errPiExtensionNotHosted) {
			return pigNodeTurnError(piExtensionRefusalText(request.CapabilityDescriptor, request.PiExtensionPaths) + ": " + err.Error())
		}
		return pigNodeTurnError(err.Error())
	}
	tools = append(tools, extensions...)
	_ = pigExtensionTurnStarted(request.Workspace, text)
	preAdmission := []string{}
	if host.options.PreAdmission != nil {
		preAdmission = host.options.PreAdmission()
	}
	session, err := openAgentSession(host.options.Database, pigSessionOpenOptions{
		Request:    request,
		Stream:     host.options.Stream,
		Codemode:   host.options.Codemode,
		Tools:      tools,
		OnEvent:    host.options.OnEvent,
		OnToolCall: host.options.OnToolCall,
		ProviderOptions: func(map[string]any) map[string]any {
			return host.providerOptions()
		},
		Freeze: func() error {
			return pigkernel.FreezeExecution(context.Background(), host.options.Database, request.Binding.InstanceId,
				pigFrozenExecution(request, preAdmission))
		},
	})
	if err != nil {
		return pigNodeTurnError(err.Error())
	}
	agent, err := agentcore.Adopt(agentIdentityOfNode(host.options.GraphId, host.options.NodeId, host.options.Role, ""), &pigAgentSession{session: session, request: request})
	if err != nil {
		_ = session.Close()
		return pigNodeTurnError(err.Error())
	}
	host.mutex.Lock()
	if host.closed {
		host.mutex.Unlock()
		_ = agent.Close()
		return pigNodeTurnError("The PiG node binding is closed")
	}
	host.current = agent
	host.mutex.Unlock()
	defer func() {
		host.mutex.Lock()
		if host.current == agent {
			host.current = nil
		}
		host.mutex.Unlock()
		_ = agent.Close()
	}()

	inspect := agent.Inspect()
	if host.options.OnReady != nil {
		host.options.OnReady(inspect.SessionId, inspect.SessionFile)
	}
	turn, err := agent.Prompt(text, nil)
	if err != nil {
		return pigNodeTurnError(err.Error())
	}
	report := TurnReport{Done: true, Interrupted: turn.StopReason != nil && *turn.StopReason == "aborted"}
	if turn.ErrorMessage != nil && *turn.ErrorMessage != "" {
		return pigNodeTurnError(*turn.ErrorMessage)
	}
	if host.options.Usage != nil {
		if usage := host.options.Usage(); usage != nil {
			report.Usage = &TurnUsage{Total: float64(usage.Total), Accounted: usage.Accounted != nil && *usage.Accounted}
		}
	}
	return report
}

func (host *PigNodeHost) Steer(text, requestID string) error {
	host.mutex.Lock()
	agent := host.current
	host.mutex.Unlock()
	if agent == nil {
		return errors.New("The node is not accepting steering messages")
	}
	controller, ok := agent.Session().(interface {
		InterruptWithRequestID(text *string, requestID string) error
	})
	if !ok {
		return errors.New("The node session does not accept steering")
	}
	return controller.InterruptWithRequestID(&text, requestID)
}

func (host *PigNodeHost) StopActive() error {
	host.mutex.Lock()
	agent := host.current
	host.mutex.Unlock()
	if agent == nil {
		return errors.New("The node session is not yet available")
	}
	return agent.Stop()
}

func (host *PigNodeHost) Stop() error {
	host.mutex.Lock()
	agent := host.current
	host.mutex.Unlock()
	if agent == nil {
		return nil
	}
	return agent.Stop()
}

func (host *PigNodeHost) Dispose() error {
	host.mutex.Lock()
	host.closed = true
	agent := host.current
	host.current = nil
	host.mutex.Unlock()
	if agent == nil {
		return nil
	}
	return agent.Close()
}

func (host *PigNodeHost) providerOptions() map[string]any {
	options := map[string]any{}
	if host.options.StreamOptions != nil {
		options = host.options.StreamOptions()
	}
	return options
}

func pigNodeTurnError(reason string) TurnReport {
	message := reason
	return TurnReport{Error: &message}
}

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
				value := gate.Dispatch(id, 0, func() any {
					result, executeErr := definition.Execute(id, params)
					if executeErr != nil {
						return executeErr
					}
					return result
				})
				gate.Settle(id, &TokenUsage{})
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
	switch classifyPigTurn(receipt, pigNodeCalledProvider(kernel, &ExecutionRow{Id: executionId}, frozen)) {
	case pigTurnReachedModel:
		return 0
	default:
		return pigNodeAttemptOf(frozen.InputRequestId)
	}
}
