package graph

// The desktop capability is ONE tool.
//
// agent-desktop ships about sixty commands, and the obvious port would declare
// sixty tools: one per verb, each with its own schema. That is the opposite of
// what the tool surface needs - every declaration is paid for by every request
// of every session, and the provider-side budget counts characters, not verbs.
// The CLI is already the thing that validates its own arguments and answers with
// one JSON envelope, so the wrapper passes the verbs through as data and the
// model reads `--help` or the vendored skill instead of the schema.
//
// The description is the whole safety contract of the tool, in the order the
// model needs it: what it wraps, that the envelope comes back unchanged, that
// the default is headless, and that the payload is withheld unless asked for.
// Every clause is load-bearing and there is no room for a second sentence of
// prose.

const desktopToolDescription = "One agent-desktop command+args; envelope unchanged. Headless unless headed:true " +
	"(steals focus, moves the cursor). Output withheld unless include:output; repeat only when disposition.retry is \"safe\"."

// desktopPayloadKinds name what a withheld answer would have contained. It is
// the receipt's explanation, and the list is the one the privacy rule names: a
// window tree can hold a private message, a clipboard read can hold a password,
// and neither belongs in a transcript by accident. Every successful answer is
// withheld by default - the receipt is the default, `include: "output"` is the
// door - because the daemon stores tool results with the conversation.
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

// desktopToolDeclarations is the computer-use surface: `command` plus `args`,
// and nothing else to keep in sync with the CLI's own command list.
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

// desktopAccessibilityCommands are the commands that resolve their target from
// the accessibility tree. For them the permission question comes first.
//
// "I cannot see the screen" and "I cannot tell which element you meant" are
// different problems with different fixes, and the CLI answers the second when
// only the first is true: a missing grant surfaces as a target it could not
// identify. The tool asks the permission question itself, so a user who never
// granted Accessibility is told exactly that instead of being sent to look for
// an ambiguous cell. Only a command whose permission is readable as granted may
// answer with a target error.
//
// Commands that never read the tree are absent on purpose: version, status,
// permissions, skills, session, wait, clipboard-*, screenshot, list-*, help and
// batch. `batch` reports each entry's own code, so its inner commands keep their
// own answer.
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

// desktopPermissionRefusal is the envelope the tool answers with instead of
// running a command whose target it could not see.
//
// It is the CLI's own envelope shape so the model reads it the same way as any
// other refusal, and it says where it came from (`details.source`) because the
// words are the tool's, not the CLI's. It carries no payload, so it is safe to
// hand over verbatim.
func desktopPermissionRefusal(command, state, version string) map[string]any {
	envelope := map[string]any{
		"ok": false, "command": command,
		"error": map[string]any{
			"code":    "PERM_DENIED",
			"message": "Accessibility permission is not granted (" + state + "), so " + command + " has no target it could resolve",
			"suggestion": "Run agent-desktop permissions --guide from the app that launches agent-desktop " +
				"(Graph.app, Terminal, iTerm or Codex) and switch on Accessibility. After a reinstall, upgrade or " +
				"move of that install, run it again: the grant belongs to the binary path and its cdhash.",
			"details":     map[string]any{"source": "graph-desktop-tool", "accessibility": state, "checked": "agent-desktop permissions"},
			"disposition": map[string]any{"delivery": "not_delivered", "retry": "safe"},
		},
	}
	if version != "" {
		envelope["version"] = version
	}
	return envelope
}
