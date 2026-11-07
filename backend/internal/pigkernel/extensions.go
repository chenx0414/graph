package pigkernel

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/MichaelKinsy/PiG/coding/extension"
	"github.com/MichaelKinsy/PiG/coding/extension/host/subprocess"
)


type ExtensionHost struct {
	host   *subprocess.Host
	mutex  sync.Mutex
	loaded map[string]*LoadedExtension
	sessionStarted map[string]bool
	catalog atomic.Pointer[[]subprocess.ToolInfo]
}

type LoadedExtension struct {
	Name string
	Path      string
	extension *extension.Extension
}

func NewExtensionHost(cwd string) *ExtensionHost {
	host := &ExtensionHost{host: subprocess.NewHost(cwd), loaded: map[string]*LoadedExtension{}, sessionStarted: map[string]bool{}}
	bridge := subprocess.NewUIBridge(nil)
	bridge.SetHostAction("getAllTools", func() []subprocess.ToolInfo {
		if catalog := host.catalog.Load(); catalog != nil {
			return *catalog
		}
		return nil
	})
	bridge.SetHostAction("getCommands", func() []subprocess.CommandInfo { return nil })
	host.host.SetUIBridge(bridge)
	return host
}

func (h *ExtensionHost) Load(ctx context.Context, path string) (*LoadedExtension, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	h.mutex.Lock()
	defer h.mutex.Unlock()
	if loaded, ok := h.loaded[absolute]; ok {
		return loaded, nil
	}
	name := extensionHostName(absolute)
	loaded, err := h.host.Load(ctx, subprocess.ExtConfig{
		Name:    name,
		Source:  absolute,
		Enabled: true,
	})
	if err != nil {
		return nil, fmt.Errorf("load the Pi extension %s: %w", absolute, err)
	}
	entry := &LoadedExtension{Name: name, Path: absolute, extension: loaded}
	h.loaded[absolute] = entry
	h.publishCatalog()
	return entry, nil
}

func (h *ExtensionHost) publishCatalog() {
	catalog := []subprocess.ToolInfo{}
	for _, loaded := range h.loaded {
		for _, tool := range loaded.Tools() {
			encoded, err := json.Marshal(tool.Parameters)
			if err != nil {
				continue
			}
			catalog = append(catalog, subprocess.ToolInfo{Name: tool.Name, Description: tool.Description, Parameters: encoded})
		}
	}
	sort.Slice(catalog, func(left, right int) bool { return catalog[left].Name < catalog[right].Name })
	h.catalog.Store(&catalog)
}

func (h *ExtensionHost) Close() {
	h.mutex.Lock()
	defer h.mutex.Unlock()
	h.loaded = map[string]*LoadedExtension{}
	h.sessionStarted = map[string]bool{}
	h.host.Shutdown("the daemon is closing")
}

func extensionHostName(path string) string {
	directory := filepath.Base(filepath.Dir(path))
	if directory == "." || directory == string(filepath.Separator) {
		directory = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	return directory
}

func (h *ExtensionHost) EmitSessionStart(reason string) []error {
	type pending struct {
		path  string
		entry *LoadedExtension
	}
	h.mutex.Lock()
	waiting := []pending{}
	for path, entry := range h.loaded {
		if h.sessionStarted[path] {
			continue
		}
		waiting = append(waiting, pending{path: path, entry: entry})
	}
	h.mutex.Unlock()
	failures := []error{}
	for _, item := range waiting {
		event := extension.SessionStartEvent{Type: "session_start", Reason: reason}
		if err := item.entry.emit("session_start", event); err != nil {
			failures = append(failures, err)
			continue
		}
		h.mutex.Lock()
		h.sessionStarted[item.path] = true
		h.mutex.Unlock()
	}
	return failures
}

func (h *ExtensionHost) EmitBeforeAgentStart(prompt string) []error {
	event := extension.BeforeAgentStartEvent{Type: "before_agent_start", Prompt: prompt}
	return h.emitEverywhere("before_agent_start", event)
}

func (h *ExtensionHost) emitEverywhere(event string, payload any) []error {
	h.mutex.Lock()
	loaded := make([]*LoadedExtension, 0, len(h.loaded))
	for _, entry := range h.loaded {
		loaded = append(loaded, entry)
	}
	h.mutex.Unlock()
	sort.Slice(loaded, func(left, right int) bool { return loaded[left].Name < loaded[right].Name })
	failures := []error{}
	for _, entry := range loaded {
		if err := entry.emit(event, payload); err != nil {
			failures = append(failures, err)
		}
	}
	return failures
}

func (entry *LoadedExtension) emit(event string, payload any) error {
	if entry == nil || entry.extension == nil {
		return nil
	}
	failures := []string{}
	for _, handler := range entry.extension.EventHandlers(event) {
		if _, err := handler(payload, context.Background()); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) == 0 {
		return nil
	}
	return fmt.Errorf("%s: the %s handler failed: %s", entry.Name, event, strings.Join(failures, "; "))
}

type ExtensionTool struct {
	Name string
	Description string
	Parameters map[string]any
	definition extension.ToolDefinition
}

func (tool ExtensionTool) Execute(ctx context.Context, toolCallID string, args map[string]any) (any, error) {
	encoded, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	return tool.definition.Execute(ctx, toolCallID, json.RawMessage(encoded), nil)
}

type ExtensionVerdict struct {
	Block bool
	Reason string
	Terminate bool
}

type ExtensionResult struct {
	Content           []any           `json:"content"`
	Details           any             `json:"details,omitempty"`
	StructuredContent json.RawMessage `json:"structuredContent,omitempty"`
	IsError           bool            `json:"isError"`
}

func ExtensionResultOf(value any) ExtensionResult {
	result := ExtensionResult{}
	if value == nil {
		return result
	}
	body, err := json.Marshal(value)
	if err != nil {
		return result
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return ExtensionResult{}
	}
	return result
}

func (e *LoadedExtension) BeforeToolCall(ctx context.Context, toolName, toolCallID string, input map[string]any) (ExtensionVerdict, error) {
	verdict := ExtensionVerdict{}
	handlers := e.extension.EventHandlers("tool_call")
	if len(handlers) == 0 {
		return verdict, nil
	}
	event := extension.CustomToolCallEvent{
		ToolCallEventBase: extension.ToolCallEventBase{Type: "tool_call", ToolCallID: toolCallID},
		ToolName:          toolName,
		Input:             input,
	}
	for _, handler := range handlers {
		reply, err := handler(event, ctx)
		if err != nil {
			return verdict, err
		}
		decided, err := decodeExtensionVerdict(reply)
		if err != nil {
			return verdict, err
		}
		if decided.Block {
			verdict.Block = true
			verdict.Reason = decided.Reason
		}
		if decided.Terminate {
			verdict.Terminate = true
		}
	}
	return verdict, nil
}

func (e *LoadedExtension) AfterToolResult(ctx context.Context, toolName, toolCallID string, input map[string]any, result ExtensionResult) (ExtensionResult, error) {
	handlers := e.extension.EventHandlers("tool_result")
	if len(handlers) == 0 {
		return result, nil
	}
	event := extension.CustomToolResultEvent{
		ToolResultEventBase: extension.ToolResultEventBase{
			Type:              "tool_result",
			ToolCallID:        toolCallID,
			Input:             input,
			Content:           result.Content,
			StructuredContent: result.StructuredContent,
			IsError:           result.IsError,
		},
		ToolName: toolName,
		Details:  result.Details,
	}
	for _, handler := range handlers {
		reply, err := handler(event, ctx)
		if err != nil {
			return result, err
		}
		patch, ok, err := decodeExtensionResultPatch(reply)
		if err != nil {
			return result, err
		}
		if !ok {
			continue
		}
		if patch.Content != nil {
			result.Content = patch.Content
		}
		if patch.Details != nil {
			result.Details = patch.Details
		}
		if patch.StructuredContent != nil {
			result.StructuredContent = patch.StructuredContent
		}
		if patch.IsError != nil {
			result.IsError = *patch.IsError
		}
	}
	return result, nil
}

func (e *LoadedExtension) Tools() []ExtensionTool {
	tools := []ExtensionTool{}
	for _, name := range e.extension.ToolOrder {
		registered, ok := e.extension.Tools[name]
		if !ok {
			continue
		}
		tools = append(tools, ExtensionTool{
			Name:        registered.Definition.Name,
			Description: registered.Definition.Description,
			Parameters:  extensionToolParameters(registered.Definition.Parameters),
			definition:  registered.Definition,
		})
	}
	if len(tools) > 0 {
		return tools
	}
	for name, registered := range e.extension.Tools {
		tools = append(tools, ExtensionTool{
			Name:        registered.Definition.Name,
			Description: registered.Definition.Description,
			Parameters:  extensionToolParameters(registered.Definition.Parameters),
			definition:  registered.Definition,
		})
		_ = name
	}
	return tools
}

func extensionToolParameters(parameters json.RawMessage) map[string]any {
	if len(parameters) == 0 {
		return map[string]any{}
	}
	decoded := map[string]any{}
	if err := json.Unmarshal(parameters, &decoded); err != nil {
		return map[string]any{}
	}
	return decoded
}

func decodeExtensionVerdict(reply any) (extension.ToolCallEventResult, error) {
	verdict := extension.ToolCallEventResult{}
	body, err := json.Marshal(reply)
	if err != nil {
		return verdict, err
	}
	if len(body) == 0 || string(body) == "null" {
		return verdict, nil
	}
	if err := json.Unmarshal(body, &verdict); err != nil {
		return verdict, err
	}
	return verdict, nil
}

func decodeExtensionResultPatch(reply any) (extension.ToolResultEventResult, bool, error) {
	patch := extension.ToolResultEventResult{}
	body, err := json.Marshal(reply)
	if err != nil {
		return patch, false, err
	}
	if len(body) == 0 || string(body) == "null" {
		return patch, false, nil
	}
	if err := json.Unmarshal(body, &patch); err != nil {
		return patch, false, err
	}
	return patch, true, nil
}
