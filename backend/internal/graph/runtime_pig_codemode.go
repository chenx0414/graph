package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"context"

	"github.com/MichaelKinsy/PiG/codemode"
)

// CodemodeToolName is the name the codemode tool is offered under.
const CodemodeToolName = "codemode"

// codemodeSettings are the codemode settings of one daemon.
//
// The sandbox module's compilation cache lives under the state directory: the
// module is compiled once, so the first script of a later run starts in
// moments rather than hundreds of them.
func codemodeSettings(config GraphCodemode, stateDir string) CodemodeSettings {
	settings := CodemodeSettings{Enabled: config.Enabled}
	if stateDir != "" {
		settings.CacheDir = filepath.Join(stateDir, "codemode-cache")
	}
	if config.TimeoutMs != nil {
		settings.TimeoutMs = *config.TimeoutMs
	}
	return settings
}

// CodemodeSettings configure the codemode tool of one session.
type CodemodeSettings struct {
	// Enabled offers the codemode tool. It is on unless the configuration
	// turns it off.
	Enabled bool
	// TimeoutMs is the deadline of one script, in milliseconds. Zero is the
	// kernel's own default.
	TimeoutMs int
	// CacheDir holds the sandbox module's on-disk compilation cache. Empty
	// compiles the module in memory, which costs a moment on every first call.
	CacheDir string
}

// CodemodeTool builds the codemode tool of one session.
//
// The tools a script may call are the session's own tools, minus the codemode
// tool itself: a script must not start another script.
func CodemodeTool(tools []ToolDefinition, gate SendGate, settings CodemodeSettings) ToolDefinition {
	return ToolDefinition{
		Name:        CodemodeToolName,
		Label:       "Code mode",
		Description: "Run JavaScript that calls the other tools. The script runs in a sandbox; every call it makes is admitted like a direct call.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"code": map[string]any{"type": "string", "description": "Raw JavaScript source."},
			},
			"required": []any{"code"},
		},
		Execute: func(_ string, params any) (result any, err error) {
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
			arguments := agentToolsParams(params)
			code := agentToolsString(arguments["code"])
			if strings.TrimSpace(code) == "" {
				return nil, errors.New("codemode needs a script")
			}
			text, err := runCodemodeScript(context.Background(), code, tools, gate, settings)
			if err != nil {
				return nil, err
			}
			return agentToolsText(text), nil
		},
	}
}

// runCodemodeScript runs one script in the kernel's sandbox.
//
// The sandbox is the kernel's own: the same QuickJS module the upstream
// codemode extension runs, with the daemon's own tools as its host table.
func runCodemodeScript(ctx context.Context, code string, tools []ToolDefinition, gate SendGate, settings CodemodeSettings) (string, error) {
	sandbox, err := codemode.NewSandbox(codemode.SandboxOptions{
		Tools:     codemodeTools(tools, gate),
		CacheDir:  settings.CacheDir,
		TimeoutMs: float64(settings.TimeoutMs),
	})
	if err != nil {
		return "", err
	}
	defer func() { _ = sandbox.Close() }()
	result, err := sandbox.Execute(ctx, code, codemode.ExecuteOptions{})
	if err != nil {
		return "", err
	}
	if !result.OK {
		return "", errors.New(codemodeFailure(result))
	}
	return codemodeOutput(result), nil
}

// codemodeFailure is the reason a failed script reports.
func codemodeFailure(result codemode.Result) string {
	if result.Error == nil {
		return "The script failed"
	}
	if result.Error.Name != "" {
		return result.Error.Name + ": " + result.Error.Message
	}
	return result.Error.Message
}

// codemodeOutput is the text a finished script reports to the model.
func codemodeOutput(result codemode.Result) string {
	parts := []string{}
	for _, item := range result.Output {
		if item.Type != codemode.OutputItemText || item.Text == "" {
			continue
		}
		parts = append(parts, item.Text)
	}
	if len(parts) == 0 && len(result.Value) > 0 {
		return string(result.Value)
	}
	return strings.Join(parts, "\n")
}

// codemodeTools are the host tools one script may call.
//
// The script reaches them as `tools.<name>(args)`. Every call goes through
// the session's gate, exactly like a direct call: the sandbox changes how the
// calls are written, not whether they are allowed.
func codemodeTools(tools []ToolDefinition, gate SendGate) []codemode.Tool {
	out := []codemode.Tool{}
	for _, tool := range tools {
		if tool.Name == CodemodeToolName {
			// A script must not start another script.
			continue
		}
		definition := tool
		out = append(out, codemode.Tool{
			Name:        definition.Name,
			Description: definition.Description,
			InputSchema: codemodeSchema(definition.Parameters),
			Execute: func(_ context.Context, args json.RawMessage) (result json.RawMessage, err error) {
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
				decoded := map[string]any{}
				if len(args) > 0 {
					if decodeErr := json.Unmarshal(args, &decoded); decodeErr != nil {
						return nil, decodeErr
					}
				}
				prepared := any(decoded)
				if definition.PrepareArguments != nil {
					prepared = definition.PrepareArguments(prepared)
				}
				params, _ := prepared.(map[string]any)
				if params == nil {
					params = map[string]any{}
				}
				if definition.Execute == nil {
					return json.RawMessage("null"), nil
				}
				id := graphUUID()
				// The settle follows the dispatch instead of running inside it.
				//
				// A tool that refuses panics; a defer registered inside the send
				// would settle the call while that refusal unwinds, and the
				// dispatch's own recovery would then settle it a second time with
				// no evidence at all. The conflict that produces replaces the
				// tool's refusal with a bookkeeping error, so the script - and the
				// person reading the transcript - never learns why the tool said
				// no. Settling after the dispatch returns keeps the refusal intact.
				value := gate.Dispatch(id, 0, func() any {
					executed, executeErr := definition.Execute(id, params)
					if executeErr != nil {
						return executeErr
					}
					return executed
				})
				gate.Settle(id, &TokenUsage{})
				if failure, ok := value.(error); ok {
					return nil, failure
				}
				return codemodeValue(value), nil
			},
		})
	}
	return out
}

// codemodeValue is the value one tool call hands to the script.
//
// The Graph's tools answer with the SDK's tool result shape; the script sees
// the text the model would have read, because that is what a tool call means.
func codemodeValue(value any) json.RawMessage {
	if text, ok := codemodeResultText(value); ok {
		return json.RawMessage(strconv.Quote(text))
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}

// codemodeResultText reads the text of one tool result.
func codemodeResultText(value any) (string, bool) {
	if text, ok := value.(string); ok {
		return text, true
	}
	record := asMap(value)
	if record == nil {
		return "", false
	}
	content, ok := record["content"].([]any)
	if !ok {
		return "", false
	}
	parts := []string{}
	for _, item := range content {
		block := asMap(item)
		if block == nil {
			continue
		}
		if text, ok := block["text"].(string); ok {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n"), true
}

// codemodeSchema is the declaration one host tool shows the script.
func codemodeSchema(parameters any) json.RawMessage {
	encoded, err := json.Marshal(parameters)
	if err != nil || len(encoded) == 0 {
		return json.RawMessage(`{"type":"object"}`)
	}
	return encoded
}
