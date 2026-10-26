package graph

import (
	"runtime"
	"sort"
	"strings"

	"reflect"
)

// PI_NATIVE_TOOL_NAMES are Pi's built-in tools. powershell is windows-only.
var PI_NATIVE_TOOL_NAMES = []string{"read", "bash", "edit", "write", "ls", "find", "grep", "powershell"}

// PiNativeToolNamesForPlatform drops powershell unless the platform is win32 or windows.
func PiNativeToolNamesForPlatform(platform ...string) []string {
	name := runtime.GOOS
	if len(platform) > 0 && platform[0] != "" {
		name = platform[0]
	}
	windows := name == "win32" || name == "windows"
	out := []string{}
	for _, tool := range PI_NATIVE_TOOL_NAMES {
		if tool == "powershell" && !windows {
			continue
		}
		out = append(out, tool)
	}
	return out
}

var legacyGraphAliases = map[string]string{"read": "read", "bash": "run_command", "write": "write_file", "ls": "list_dir"}

// GraphToolsSupersededByNative is the set of tool names a native tool replaces, including legacy aliases.
func GraphToolsSupersededByNative(nativeTools []string) map[string]bool {
	superseded := map[string]bool{}
	for _, name := range nativeTools {
		superseded[name] = true
	}
	for native, legacy := range legacyGraphAliases {
		if toolListHas(nativeTools, native) && legacy != "" {
			superseded[legacy] = true
		}
	}
	return superseded
}

// AgentToolSurface is the disabled/native replacement applied to one tool list.
type AgentToolSurface[T any] struct {
	NativeTools    []string
	Tools          []T
	ExtensionTools []string
}

// SelectAgentToolSurface keeps discovery order out of the schema prefix.
func SelectAgentToolSurface[T any](tools []T, nativeTools, disabledTools, extensionTools []string) AgentToolSurface[T] {
	disabled := map[string]bool{}
	for _, name := range disabledTools {
		name = strings.TrimSpace(name)
		if name != "" {
			disabled[name] = true
		}
	}
	seen := map[string]bool{}
	var native []string
	for _, name := range nativeTools {
		name = strings.TrimSpace(name)
		if name == "" || disabled[name] || seen[name] {
			continue
		}
		seen[name] = true
		native = append(native, name)
	}
	sort.SliceStable(native, func(i, j int) bool { return native[i] < native[j] })
	superseded := GraphToolsSupersededByNative(native)
	available := func(name string) bool { return !disabled[name] && !superseded[name] }
	selected := []T{}
	for _, tool := range tools {
		if available(toolSurfaceName(tool)) {
			selected = append(selected, tool)
		}
	}
	sort.SliceStable(selected, func(i, j int) bool {
		left := toolSurfaceName(selected[i])
		right := toolSurfaceName(selected[j])
		if left < right {
			return true
		}
		return false
	})
	var extensions []string
	for _, name := range extensionTools {
		if available(name) {
			extensions = append(extensions, name)
		}
	}
	sort.SliceStable(extensions, func(i, j int) bool { return extensions[i] < extensions[j] })
	if native == nil {
		native = []string{}
	}
	if extensions == nil {
		extensions = []string{}
	}
	return AgentToolSurface[T]{NativeTools: native, Tools: selected, ExtensionTools: extensions}
}

func toolSurfaceName(tool any) string {
	value := reflect.ValueOf(tool)
	if value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if value.Kind() == reflect.Struct {
		field := value.FieldByName("Name")
		if field.IsValid() && field.Kind() == reflect.String {
			return field.String()
		}
	}
	if record, ok := tool.(map[string]any); ok {
		name, _ := record["name"].(string)
		return name
	}
	return ""
}

func toolListHas(tools []string, name string) bool {
	for _, tool := range tools {
		if tool == name {
			return true
		}
	}
	return false
}

// PiNativeToolPromptEntries returns prompt metadata for the enabled native tools.
func PiNativeToolPromptEntries(enabledNames ...[]string) []AgentToolPromptEntry {
	names := PiNativeToolNamesForPlatform()
	if len(enabledNames) > 0 && enabledNames[0] != nil {
		names = enabledNames[0]
	}
	enabled := map[string]bool{}
	for _, name := range names {
		enabled[name] = true
	}
	out := []AgentToolPromptEntry{}
	for _, tool := range nativeToolMetadata() {
		if !enabled[tool.Name] {
			continue
		}
		parameters := append([]string{}, tool.Parameters...)
		tool.Parameters = parameters
		out = append(out, tool)
	}
	return out
}

// toolOrder is the optional order a native tool declaration carries.
func toolOrder(order int) *int { return &order }

func nativeToolMetadata() []AgentToolPromptEntry {
	return []AgentToolPromptEntry{
		{Name: "read", Description: "Read file contents", Source: "Pi", Group: "pi_native", Order: toolOrder(0), Parameters: []string{"path", "offset", "limit"}, Permission: "workspace and granted read roots", Available: true},
		{Name: "bash", Description: "Execute bash commands (ls, grep, find, etc.)", Source: "Pi", Group: "pi_native", Order: toolOrder(1), Parameters: []string{"command", "timeout"}, Permission: "sandboxed shell", Available: true},
		{Name: "edit", Description: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call.", Source: "Pi", Group: "pi_native", Order: toolOrder(2), Parameters: []string{"path", "edits"}, Permission: "workspace write", Available: true},
		{Name: "write", Description: "Create or overwrite files", Source: "Pi", Group: "pi_native", Order: toolOrder(3), Parameters: []string{"path", "content"}, Permission: "workspace write", Available: true},
		{Name: "ls", Description: "List directory contents", Source: "Pi", Group: "pi_native", Order: toolOrder(4), Parameters: []string{"path", "limit"}, Permission: "workspace and granted read roots", Available: true},
		{Name: "find", Description: "Find files by pattern", Source: "Pi", Group: "pi_native", Order: toolOrder(5), Parameters: []string{"pattern", "path", "limit"}, Permission: "workspace and granted read roots", Available: true},
		{Name: "grep", Description: "Search file contents", Source: "Pi", Group: "pi_native", Order: toolOrder(6), Parameters: []string{"pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"}, Permission: "workspace and granted read roots", Available: true},
		{Name: "powershell", Description: "Execute PowerShell commands", Source: "Pi", Group: "pi_native", Order: toolOrder(7), Parameters: []string{"command", "timeout"}, Permission: "sandboxed shell", Available: true},
	}
}
