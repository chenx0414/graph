package graph

import (
	"errors"

	"github.com/chenx0414/graph/backend/internal/pigkernel"

	"sync"

	"context"

	"github.com/MichaelKinsy/PiG/ai"
)

// pigExtensionHost is the resident host of the daemon's Pi extensions.
//
// The Node process of an extension is expensive to start and worth keeping,
// so one host serves every session of the daemon, and an extension is loaded
// once no matter how many sessions bind it.
var pigExtensionHost = sync.OnceValue(func() *pigkernel.ExtensionHost {
	return pigkernel.NewExtensionHost("")
})

// ClosePigExtensions stops the extension processes the daemon started.
func ClosePigExtensions() {
	pigExtensionHost().Close()
}

// pigExtensionSpecs returns the tools the session's Pi extensions register.
//
// The extension is the authority: it declares the tool and its schema. The
// capability is the contract: it declares the tools of the extension the
// session may see, and the session's own policy says which of them the model
// may call. A tool the capability did not declare is not the session's tool
// at all.
func pigExtensionSpecs(ctx context.Context, request AgentSessionRequest, broker SendGate) ([]pigkernel.ToolSpec, error) {
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
		loaded, err := pigExtensionHost().Load(ctx, path)
		if err != nil {
			return nil, piExtensionRefusal{reason: err.Error()}
		}
		for _, tool := range loaded.Tools() {
			if !declared[tool.Name] {
				continue
			}
			if len(allowed) > 0 && !allowed[tool.Name] {
				continue
			}
			specs = append(specs, pigExtensionToolSpec(loaded, tool, broker))
		}
	}
	return specs, nil
}

// pigExtensionToolSpec is one extension tool, as the kernel sees it.
//
// The call goes through the same gate as every other tool: the gate admits
// the call, the extension's own hook may still refuse it, and the extension
// runs the body in its own process.
func pigExtensionToolSpec(loaded *pigkernel.LoadedExtension, tool pigkernel.ExtensionTool, broker SendGate) pigkernel.ToolSpec {
	return pigkernel.ToolSpec{
		Name:        tool.Name,
		Description: tool.Description,
		Parameters:  tool.Parameters,
		Result: func(ctx context.Context, args map[string]any) (any, error) {
			// The definition is built per call so the turn's context reaches
			// the extension: the call belongs to this turn, and a turn that
			// ends must not leave a call running in the extension's process.
			definition := ToolDefinition{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  tool.Parameters,
				Execute: func(toolCallID string, params any) (any, error) {
					return pigExtensionCall(ctx, loaded, tool, toolCallID, params)
				},
			}
			gated := piWorkerGatedTool(definition, broker)
			value := gated(graphUUID(), args, ctx)
			if failure, ok := value.(error); ok {
				return nil, failure
			}
			return value, nil
		},
	}
}

// pigExtensionCall runs one extension tool call.
//
// The extension's own hook comes first: it may refuse the call, and it may
// edit the arguments the tool receives. The tool then runs in the extension's
// process, and the extension's result hook may still rewrite what the model
// reads.
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

// pigExtensionText is a tool result that carries one line of text.
func pigExtensionText(text string) ai.ToolResultMessage {
	return ai.ToolResultMessage{
		Content: []ai.ToolResultMessageContent{ai.TextContent{Text: text}},
	}
}

// pigExtensionFailure is a tool result that says the call failed.
//
// The failure is the extension's own: the model has to be able to tell a
// refusal from an answer, and a failed call is neither.
func pigExtensionFailure(text string) ai.ToolResultMessage {
	return ai.ToolResultMessage{
		Content: []ai.ToolResultMessageContent{ai.TextContent{Text: text}},
		IsError: true,
	}
}

// pigExtensionProcessAllowed says whether a session's policy is as wide as
// the daemon's own reach.
//
// The extension's process has the daemon's reach: it reads and writes the
// host and reaches the network. A session that may not do that itself may
// not host an extension either, because the extension would do it for the
// session. The default policy is full access, so a session that never asked
// for a narrower one may host an extension.
func pigExtensionProcessAllowed(policy *ResolvedAccessPolicy) bool {
	if policy == nil {
		return true
	}
	return IsHostRead(policy) && IsHostWrite(policy) && policy.Network == "unrestricted"
}

// nodeAccessPolicy is the access policy one node session runs under.
func nodeAccessPolicy(session NodeSession) *ResolvedAccessPolicy {
	if session.Environment == nil {
		return nil
	}
	return session.Environment.Access
}

// errPiExtensionNotHosted is the refusal a session gets when a bound Pi
// extension cannot be hosted for it.
var errPiExtensionNotHosted = errors.New("a bound Pi extension could not be hosted")

// piExtensionRefusal says why a bound Pi extension could not be hosted.
type piExtensionRefusal struct {
	reason string
}

func (refusal piExtensionRefusal) Error() string { return refusal.reason }

func (refusal piExtensionRefusal) Unwrap() error { return errPiExtensionNotHosted }
