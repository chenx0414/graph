package graph


const desktopToolDescription = "One agent-desktop command+args; envelope unchanged. Headless unless headed:true " +
	"(steals focus, moves the cursor). Output withheld unless include:output; repeat only when disposition.retry is \"safe\"."

var desktopPayloadKinds = map[string]string{
	"snapshot":             "the accessibility tree of a window",
	"find":                 "element names, values and text content",
	"get":                  "one element's text, value or title",
	"is":                   "one element's state",
	"screenshot":           "a PNG of an application window",
	"clipboard-get":        "the clipboard contents",
	"clipboard-set":        "the clipboard contents it wrote",
	"clipboard-clear":      "the clipboard it cleared",
	"batch":                "the output of every command in the batch, including the ones above",
	"trace":                "the recorded timeline of the session's actions",
	"list-windows":         "window titles",
	"list-apps":            "application names",
	"list-surfaces":        "surface titles",
	"list-notifications":   "notification text",
	"dismiss-notification": "notification text",
}

func desktopToolDeclarations(set agentToolContext) []AgentToolDeclaration {
	return []AgentToolDeclaration{
		{
			Name: "desktop", Label: "Desktop control", Description: desktopToolDescription,
			Parameters: tbObject([]tbField{
				{"command", tbString(map[string]any{"description": "agent-desktop subcommand, e.g. snapshot, click, type, focus-window, clipboard-get, session. Pass --help as an arg to read the CLI's own help."})},
				{"args", tbOptional(tbArray(tbString(nil)))},
				{"headed", tbOptional(tbBool())},
				{"include", tbOptional(tbUnionLiteral([]string{"receipt", "output"}))},
			}, []string{"command"}),
			Available: set.features.Desktop,
		},
	}
}

var desktopAccessibilityCommands = map[string]bool{
	"snapshot": true, "find": true, "get": true, "is": true,
	"click": true, "double-click": true, "triple-click": true, "right-click": true,
	"type": true, "set-value": true, "clear": true, "focus": true,
	"select": true, "toggle": true, "check": true, "uncheck": true,
	"expand": true, "collapse": true, "scroll": true, "scroll-to": true,
	"press": true, "key-down": true, "key-up": true, "hover": true, "drag": true,
	"focus-window": true, "resize-window": true, "move-window": true,
	"minimize": true, "maximize": true, "restore": true,
}

func desktopPermissionRefusal(command, state, version string, context desktopExecutionContext) map[string]any {
	message := "Accessibility permission is not granted (" + state + "), so " + command + " has no target it could resolve"
	suggestion := "Run agent-desktop permissions --guide from the app that launches agent-desktop " +
		"(Graph.app, Terminal, iTerm or Codex) and switch on Accessibility. After a reinstall, upgrade or " +
		"move of that install, run it again: the grant belongs to the binary path and its cdhash."
	details := map[string]any{
		"source": "graph-desktop-tool", "accessibility": state, "checked": "agent-desktop permissions",
		"executionContext": context.details(),
	}
	envelope := map[string]any{
		"ok": false, "command": command,
		"error": map[string]any{
			"code": "PERM_DENIED", "message": message, "suggestion": suggestion,
			"details":     details,
			"disposition": map[string]any{"delivery": "not_delivered", "retry": "safe"},
		},
	}
	if version != "" {
		envelope["version"] = version
	}
	return envelope
}
