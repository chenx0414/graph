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

// The Pi extensions a session binds.
//
// PiG runs a TypeScript extension in a Node process of its own and speaks to
// it over PiG's extension wire: the extension declares the tools it registers
// and the hooks it watches, and the host calls them. An extension tool reaches
// the model only when Graph's own policy allows it, and its call passes the
// same gate every other tool passes.
//
// The extension's process belongs to the extension. The daemon cannot confine
// it, so a session whose policy is narrower than the daemon's own reach must
// not host one. That rule is the caller's; the kernel only says what it can
// do.
//
// The daemon/kernel division of labour is documented in docs/architecture.md,
// section daemon 与内核的分工.

// ExtensionHost hosts the Pi extensions one daemon loads.
//
// The host is resident: an extension's Node process is expensive to start and
// worth keeping, so an extension is loaded once and every session that binds
// it uses that one.
type ExtensionHost struct {
	host   *subprocess.Host
	mutex  sync.Mutex
	loaded map[string]*LoadedExtension
	// catalog is the tool list the host reports when an extension reads
	// pi.getAllTools(). Load publishes it after the extension is ready, so the
	// answer never waits on the lock Load holds while the extension process
	// starts.
	catalog atomic.Pointer[[]subprocess.ToolInfo]
}

// LoadedExtension is one loaded Pi extension.
type LoadedExtension struct {
	// Name is the extension's name in the host's registry.
	Name string
	// Path is the file the extension was loaded from.
	Path      string
	extension *extension.Extension
}

// NewExtensionHost returns a host that loads extensions for cwd.
//
// PiG answers an extension's host calls through a UI bridge, and a host with no
// bridge answers every one of them with an error. A Graph session is headless,
// but an extension still reads the session catalog while it works: agent_browser
// calls pi.getAllTools() and pi.getCommands() before it picks the directory it
// launches in, and with no bridge that read failed and the tool never ran. The
// bridge answers the catalog reads and leaves the rendering calls to PiG's
// headless defaults.
func NewExtensionHost(cwd string) *ExtensionHost {
	host := &ExtensionHost{host: subprocess.NewHost(cwd), loaded: map[string]*LoadedExtension{}}
	bridge := subprocess.NewUIBridge(nil)
	// The host holds the extensions' own tools, not the session's built-in ones:
	// Graph's tool policy belongs to the session, and one host serves every
	// session of the daemon.
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

// Load loads the Pi extension at path, once per host.
//
// The path is the extension's entry module. PiG runs it in a Node process of
// its own and calls the module's default export with the extension API, so
// the extension is loaded the way its author wrote it.
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

// publishCatalog republishes the tools the host holds for pi.getAllTools().
//
// The caller holds the lock; a reader takes the published slice through the
// atomic pointer, so an extension that asks while another one loads is answered
// instead of waiting.
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

// Close stops every extension process the host started.
func (h *ExtensionHost) Close() {
	h.mutex.Lock()
	defer h.mutex.Unlock()
	h.loaded = map[string]*LoadedExtension{}
	h.host.Shutdown("the daemon is closing")
}

// extensionHostName is the name one extension is known by in the host.
//
// The capability directory carries the id and the version of the capability
// ("proof-1.0.0"), which is the name a user would recognize; the entry file
// alone ("index.mjs") says nothing.
func extensionHostName(path string) string {
	directory := filepath.Base(filepath.Dir(path))
	if directory == "." || directory == string(filepath.Separator) {
		directory = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	return directory
}

// ExtensionTool is one tool an extension registered.
type ExtensionTool struct {
	// Name is the tool name the model calls.
	Name string
	// Description is what the model is told about the tool.
	Description string
	// Parameters is the tool's JSON schema.
	Parameters map[string]any
	definition extension.ToolDefinition
}

// Execute runs the tool inside the extension's own process.
//
// The result is the extension's own shape: a tool that returns an image or
// structured details keeps them.
func (tool ExtensionTool) Execute(ctx context.Context, toolCallID string, args map[string]any) (any, error) {
	encoded, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	return tool.definition.Execute(ctx, toolCallID, json.RawMessage(encoded), nil)
}

// ExtensionVerdict is what the extension's tool_call hook decided about a call.
type ExtensionVerdict struct {
	// Block refuses the call.
	Block bool
	// Reason is why the call was refused.
	Reason string
	// Terminate asks the agent to stop after the current batch.
	Terminate bool
}

// ExtensionResult is the result of one extension tool call, in Pi's shape.
//
// The content blocks and the details are the extension's own: a tool that
// returns an image or a details object keeps them.
type ExtensionResult struct {
	Content           []any           `json:"content"`
	Details           any             `json:"details,omitempty"`
	StructuredContent json.RawMessage `json:"structuredContent,omitempty"`
	IsError           bool            `json:"isError"`
}

// ExtensionResultOf reads the result an extension returned.
//
// The extension's own result keeps its shape: a tool that returns an image
// or structured details keeps them. Only the names are normalized, so the
// result reads the same as one of Pi's own tools.
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

// BeforeToolCall asks the extension whether a call may go ahead.
//
// The hook is Pi's own: a handler that returns `{block: true, reason}` refuses
// the call, and `{terminate: true}` asks the agent to stop. A handler may also
// edit the call's input, and the edited input is what the tool receives.
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

// AfterToolResult lets the extension patch the result of a call it watched.
//
// A handler may replace the content, the details, the structured content or
// the error flag; what it does not touch stays as it was.
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

// Tools returns the tools the extension registered, in registration order.
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
	// A host that recorded no order still knows the tools it holds.
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

// extensionToolParameters reads a tool's JSON schema as a map.
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

// decodeExtensionVerdict reads the verdict of a tool_call hook.
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

// decodeExtensionResultPatch reads the patch of a tool_result hook.
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
