package graph

import (
	"errors"
	"fmt"

	"github.com/chenx0414/graph/backend/internal/pigkernel"

	"os"
	"path/filepath"
	"strings"
	"sync"

	"context"

	"github.com/MichaelKinsy/PiG/ai"

	"time"
)

var pigExtensionHostState = &pigExtensionHosts{}

type pigExtensionHosts struct {
	lifecycle sync.RWMutex
	mu        sync.Mutex
	hosts     map[string]*pigkernel.ExtensionHost
}

func (hosts *pigExtensionHosts) acquire(workspace string) (*pigkernel.ExtensionHost, func()) {
	hosts.lifecycle.RLock()
	cwd := pigExtensionHostCwd(workspace)
	hosts.mu.Lock()
	if hosts.hosts == nil {
		hosts.hosts = map[string]*pigkernel.ExtensionHost{}
	}
	host := hosts.hosts[cwd]
	if host == nil {
		host = pigkernel.NewExtensionHost(cwd)
		hosts.hosts[cwd] = host
	}
	hosts.mu.Unlock()
	return host, hosts.lifecycle.RUnlock
}

func (hosts *pigExtensionHosts) take() []*pigkernel.ExtensionHost {
	hosts.lifecycle.Lock()
	defer hosts.lifecycle.Unlock()
	hosts.mu.Lock()
	taken := hosts.hosts
	hosts.hosts = nil
	hosts.mu.Unlock()
	closed := make([]*pigkernel.ExtensionHost, 0, len(taken))
	for _, host := range taken {
		closed = append(closed, host)
	}
	return closed
}

func withPigExtensionHost(workspace string, run func(host *pigkernel.ExtensionHost) error) error {
	host, release := pigExtensionHostState.acquire(workspace)
	defer release()
	return run(host)
}

func (hosts *pigExtensionHosts) withExisting(workspace string, run func(host *pigkernel.ExtensionHost)) bool {
	hosts.lifecycle.RLock()
	defer hosts.lifecycle.RUnlock()
	hosts.mu.Lock()
	host := hosts.hosts[pigExtensionHostCwd(workspace)]
	hosts.mu.Unlock()
	if host == nil {
		return false
	}
	run(host)
	return true
}

func pigExtensionTurnStarted(workspace, prompt string) []error {
	failures := []error{}
	pigExtensionHostState.withExisting(workspace, func(host *pigkernel.ExtensionHost) {
		failures = host.EmitBeforeAgentStart(prompt)
	})
	return failures
}

func pigExtensionTurnStart(store *TaskStore, taskId, operationId, nodeId, workspace, prompt string) {
	failures := pigExtensionTurnStarted(workspace, prompt)
	if len(failures) == 0 || store == nil {
		return
	}
	messages := []string{}
	for _, failure := range failures {
		messages = append(messages, failure.Error())
	}
	func() {
		defer func() { _ = recover() }()
		store.Event(taskId, "pi.extension.before_agent_start_failed", map[string]any{
			"operationId": operationId, "nodeId": nodeId, "message": strings.Join(messages, "; "),
		})
	}()
}

func raisePiExtensionLoadErrors(errors []AgentSessionExtensionError) {
	if len(errors) == 0 {
		return
	}
	details := []string{}
	for _, item := range errors {
		details = append(details, fmt.Sprintf("%s: %v", item.Path, item.Error))
	}
	Raise("capability_unavailable", "A bound Pi extension failed to load: "+strings.Join(details, "; "))
}

func pigExtensionHostCwd(workspace string) string {
	if trimmed := strings.TrimSpace(workspace); trimmed != "" {
		if info, err := os.Stat(trimmed); err == nil && info.IsDir() {
			return filepath.Clean(trimmed)
		}
	}
	return pigExtensionScratchDir()
}

func ReloadPigExtensionHost() bool {
	hosts := pigExtensionHostState.take()
	if len(hosts) == 0 {
		return false
	}
	for _, host := range hosts {
		host.Close()
	}
	return true
}

func pigExtensionScratchDir() string {
	dir := filepath.Join(GraphHome(), "tmp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return GraphHome()
	}
	return dir
}

func ClosePigExtensions() {
	for _, host := range pigExtensionHostState.take() {
		host.Close()
	}
}

func pigExtensionSpecs(ctx context.Context, request AgentSessionRequest, broker SendGate, record func(tool string, ms float64, isError bool)) ([]pigkernel.ToolSpec, error) {
	specs := []pigkernel.ToolSpec{}
	if len(request.PiExtensionPaths) == 0 {
		return specs, nil
	}
	if !request.ExtensionProcessAllowed {
		return nil, piExtensionRefusal{reason: "the session's policy is narrower than the daemon's own reach, and a Pi extension runs in a process with that reach"}
	}
	declared := map[string]bool{}
	for _, name := range request.PiExtensionTools {
		declared[name] = true
	}
	allowed := map[string]bool{}
	for _, name := range request.AllowedToolNames {
		allowed[name] = true
	}
	for _, path := range request.PiExtensionPaths {
		extensionPath := path
		var extensionSpecs []pigkernel.ToolSpec
		err := withPigExtensionHost(request.Workspace, func(host *pigkernel.ExtensionHost) error {
			loaded, err := host.Load(ctx, extensionPath)
			if err != nil {
				return err
			}
			for _, failure := range host.EmitSessionStart("startup") {
				if request.OnEvent != nil {
					request.OnEvent(map[string]any{
						"type":    "pi_extension_setup_failed",
						"message": failure.Error(),
					})
				}
			}
			for _, tool := range loaded.Tools() {
				if !declared[tool.Name] {
					continue
				}
				if len(allowed) > 0 && !allowed[tool.Name] {
					continue
				}
				extensionSpecs = append(extensionSpecs, pigExtensionToolSpec(loaded, tool, broker, record))
			}
			return nil
		})
		if err != nil {
			return nil, piExtensionRefusal{reason: err.Error()}
		}
		specs = append(specs, extensionSpecs...)
	}
	return specs, nil
}

func pigExtensionToolSpec(loaded *pigkernel.LoadedExtension, tool pigkernel.ExtensionTool, broker SendGate, record func(tool string, ms float64, isError bool)) pigkernel.ToolSpec {
	return pigkernel.ToolSpec{
		Name:        tool.Name,
		Description: tool.Description,
		Parameters:  tool.Parameters,
		Result: func(ctx context.Context, args map[string]any) (any, error) {
			definition := ToolDefinition{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  tool.Parameters,
				Execute: func(toolCallID string, params any) (any, error) {
					return pigExtensionCall(ctx, loaded, tool, toolCallID, params)
				},
			}
			gated := piWorkerGatedTool(definition, broker)
			started := time.Now()
			value := gated(graphUUID(), args, ctx)
			failure, failed := value.(error)
			if record != nil {
				record(tool.Name, float64(time.Since(started).Milliseconds()), failed)
			}
			if failed {
				return nil, failure
			}
			return value, nil
		},
	}
}

func pigExtensionCall(ctx context.Context, loaded *pigkernel.LoadedExtension, tool pigkernel.ExtensionTool, toolCallID string, params any) (any, error) {
	arguments, _ := params.(map[string]any)
	if arguments == nil {
		arguments = map[string]any{}
	}
	verdict, err := loaded.BeforeToolCall(ctx, tool.Name, toolCallID, arguments)
	if err != nil {
		return pigExtensionFailure("the Pi extension could not be asked about the call: " + err.Error()), nil
	}
	if verdict.Block {
		reason := verdict.Reason
		if reason == "" {
			reason = "the Pi extension refused the call"
		}
		return pigExtensionText("The Pi extension refused the call: " + reason), nil
	}
	value, err := tool.Execute(ctx, toolCallID, arguments)
	if err != nil {
		return pigExtensionFailure("the Pi extension failed: " + err.Error()), nil
	}
	result := pigkernel.ExtensionResultOf(value)
	patched, err := loaded.AfterToolResult(ctx, tool.Name, toolCallID, arguments, result)
	if err != nil {
		return pigExtensionFailure("the Pi extension could not be shown the result: " + err.Error()), nil
	}
	return patched, nil
}

func pigExtensionText(text string) ai.ToolResultMessage {
	return ai.ToolResultMessage{
		Content: []ai.ToolResultMessageContent{ai.TextContent{Text: text}},
	}
}

func pigExtensionFailure(text string) ai.ToolResultMessage {
	return ai.ToolResultMessage{
		Content: []ai.ToolResultMessageContent{ai.TextContent{Text: text}},
		IsError: true,
	}
}

func pigExtensionProcessAllowed(policy *ResolvedAccessPolicy) bool {
	if policy == nil {
		return true
	}
	return IsHostRead(policy) && IsHostWrite(policy) && policy.Network == "unrestricted"
}

func nodeAccessPolicy(session NodeSession) *ResolvedAccessPolicy {
	if session.Environment == nil {
		return nil
	}
	return session.Environment.Access
}

var errPiExtensionNotHosted = errors.New("a bound Pi extension could not be hosted")

type piExtensionRefusal struct {
	reason string
}

func (refusal piExtensionRefusal) Error() string { return refusal.reason }

func (refusal piExtensionRefusal) Unwrap() error { return errPiExtensionNotHosted }
